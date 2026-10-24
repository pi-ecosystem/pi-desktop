// pi-quickbar backend: thin Tauri shell over `pi --mode rpc`.
// First principles: pi owns agent/sessions/skills/models. This app only
// spawns one pi RPC child per working dir, forwards JSONL, lists session
// files, and toggles windows via hotkeys.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use base64::Engine as _;
use calamine::Reader as _;
use tokio::sync::broadcast;

use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
// Desktop-only: global shortcuts don't exist on Android/iOS (and the
// plugin isn't even a dependency there — see Cargo.toml target cfg).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_global_shortcut::ShortcutState;

mod server;
pub use server::run_server;

// Bundled app prompt (src/system-prompt.md): what the transcript can render
// plus how to format answers for it. Embedded at compile time so installed
// builds carry it with no repo present. THE single prompt call site — prompt
// changes edit the md file only, never this code. Override with
// PI_DESKTOP_APP_PROMPT=/path/to/file.md, disable with PI_DESKTOP_APP_PROMPT=0.
// The effective text also rides PI_DESKTOP_APP_PROMPT_TEXT down to pi-jobs
// grandchildren (CLI flags don't propagate; env does). The HTTP server
// mode shares this core, so browser dev gets the identical behavior.
const SYSTEM_PROMPT: &str = include_str!("../../src/system-prompt.md");

fn bundled_prompt_text() -> Option<String> {
    match std::env::var("PI_DESKTOP_APP_PROMPT") {
        Ok(v) if v == "0" || v.eq_ignore_ascii_case("off") => None,
        Ok(p) => match fs::read_to_string(&p) {
            Ok(s) if !s.trim().is_empty() => Some(s),
            _ => Some(SYSTEM_PROMPT.to_string()),
        },
        Err(_) => Some(SYSTEM_PROMPT.to_string()),
    }
}

// Jobs (pi-jobs package) load from the USER's own pi packages
// (`pi install git:github.com/pi-ecosystem/pi-jobs`), exactly like
// shadow-browser — never via --extension from here. Rationale: pi dedupes
// an identical --extension path but FATALS on the same tool from two
// DIFFERENT paths (vendored copy + user install = dead child, zombie
// proc, everything RPC-shaped breaks at once). The only exception is an
// explicit PI_DESKTOP_JOBS_EXT override (dev escape hatch).
fn jobs_ext_path() -> Option<PathBuf> {
    // Explicit override only (dev escape hatch):
    // PI_DESKTOP_JOBS_EXT=/path/to/index.ts (legacy PI_DESKTOP_SPAWN_EXT honored)
    for var in ["PI_DESKTOP_JOBS_EXT", "PI_DESKTOP_SPAWN_EXT"] {
        if let Ok(p) = std::env::var(var) {
            let pb = PathBuf::from(p);
            if pb.is_file() {
                return Some(pb);
            }
        }
    }
    None
}

// ---------------------------------------------------------------- config

fn bg_default() -> bool {
    true
}
fn remote_port_default() -> u16 {
    1423
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct AppConfig {
    quickbar_hotkey: String,
    main_hotkey: String,
    default_dir: String,
    recents: Vec<String>,
    last_cwd: String,
    #[serde(default = "bg_default")]
    run_in_bg: bool,
    /// HTTP backend exposure for the phone (remote mode). Empty token =
    /// localhost only (safe default); a set token binds all interfaces
    /// and requires it as a Bearer token. Needs app restart to rebind.
    #[serde(default = "remote_port_default")]
    remote_port: u16,
    #[serde(default)]
    remote_token: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or(PathBuf::from("/tmp"));
        let qa = home.join(".pi-qa");
        Self {
            // Both editable in Settings. (Ctrl+Shift+Space was already grabbed
            // on this machine, so Super-based defaults that KDE leaves free.)
            quickbar_hotkey: "Super+J".into(),
            main_hotkey: "Super+Shift+J".into(),
            default_dir: qa.to_string_lossy().into_owned(),
            recents: vec![],
            last_cwd: qa.to_string_lossy().into_owned(),
            run_in_bg: true,
            remote_port: 1423,
            remote_token: String::new(),
        }
    }
}

fn config_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or(PathBuf::from("/tmp"));
    base.join("pi-quickbar").join("config.json")
}

fn load_config() -> AppConfig {
    let p = config_path();
    if let Ok(raw) = fs::read_to_string(&p) {
        if let Ok(c) = serde_json::from_str::<AppConfig>(&raw) {
            return c;
        }
    }
    AppConfig::default()
}

fn save_config(c: &AppConfig) {
    let p = config_path();
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string_pretty(c) {
        // Atomic: a crash mid-write must never leave a torn config
        // behind (load falls back to defaults on parse failure).
        let tmp = p.with_extension("json.tmp");
        if fs::write(&tmp, raw).is_ok() {
            let _ = fs::rename(&tmp, &p);
        }
    }
}

// ---------------------------------------------------------------- pi procs

struct PiProc {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
}

struct AppState {
    procs: Mutex<HashMap<String, PiProc>>,
    config: Mutex<AppConfig>,
    // Run lifecycle per session key ("tag\nkey"): true while its agent
    // runs. Maintained by watching forwarded records (agent_start /
    // agent_settled) — no pi roundtrips needed. Backs sidebar run dots
    // so any session's live/idle state is visible without viewing it.
    run_states: Mutex<HashMap<String, bool>>,
    // Random per backend boot. Frontends clear their run tracking when
    // it changes: a reboot ends every supervised run (or reaps orphans),
    // so pre-reboot liveness is never carried forward.
    boot_id: String,
    // Fan-out for forwarded pi records. The Tauri bridge thread re-emits
    // these as pi-record IPC; the standalone HTTP server streams them
    // as SSE. Senders never block: lagging receivers drop, frontends
    // re-sync via pi_states + history reads.
    events: broadcast::Sender<serde_json::Value>,
}

impl AppState {
    /// Shared constructor for both hosts: Tauri `run()` and the
    /// standalone HTTP server (`--server`). Loads config, ensures dirs,
    /// reaps orphans, mints a boot id, opens the event broadcast.
    pub(crate) fn new_shared() -> Arc<Self> {
        reap_stale_children();
        let cfg = load_config();
        // Ensure default Q&A dir exists so first run just works.
        let _ = fs::create_dir_all(&cfg.default_dir);
        if cfg.last_cwd.is_empty() {
            let mut c = cfg.clone();
            c.last_cwd = c.default_dir.clone();
            save_config(&c);
        }
        let (events, _) = broadcast::channel(256);
        Arc::new(Self {
            procs: Mutex::new(HashMap::new()),
            config: Mutex::new(cfg.clone()),
            run_states: Mutex::new(HashMap::new()),
            boot_id: {
                use std::time::{SystemTime, UNIX_EPOCH};
                let nanos = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_nanos() as u128)
                    .unwrap_or(0);
                format!("{:x}-{}", nanos, std::process::id())
            },
            events,
        })
    }

    /// One forwarded pi record: maintain run lifecycle, then fan out to
    /// Tauri IPC (via the bridge thread in `run()`) and HTTP SSE.
    fn on_record(&self, cwd: &str, tag: &str, key: &str, record: serde_json::Value) {
        if let Some(t) = record.get("type").and_then(|v| v.as_str()) {
            if t == "agent_start" || t == "agent_settled" {
                if let Ok(mut rs) = self.run_states.lock() {
                    rs.insert(format!("{}\n{}", tag, key), t == "agent_start");
                }
            }
        }
        let _ = self.events.send(serde_json::json!({
            "cwd": cwd,
            "tag": tag,
            "key": key,
            "record": record,
        }));
    }

    /// Kill every supervised pi child. Server shutdown path (mirrors the
    /// SIGTERM handler the old Node bridge had); Tauri uses quit_app.
    pub(crate) fn kill_all(&self) {
        if let Ok(mut procs) = self.procs.lock() {
            for (_, p) in procs.drain() {
                if let Ok(mut c) = p.child.lock() {
                    let _ = c.kill();
                }
            }
        }
    }
}

fn session_root_default() -> String {
    if let Ok(v) = std::env::var("PI_CODING_AGENT_SESSION_DIR") {
        if !v.is_empty() {
            return v;
        }
    }
    let home = dirs::home_dir().unwrap_or(PathBuf::from("/tmp"));
    home.join(".pi")
        .join("agent")
        .join("sessions")
        .to_string_lossy()
        .into_owned()
}

// Launched from a terminal, `pi` is on PATH. Launched from the KDE
// launcher it is NOT (~/.pi/agent/bin is shell-only). So resolve it:
// explicit PI_BIN first, then well-known locations, then PATH lookup.
fn pi_bin() -> String {
    if let Ok(v) = std::env::var("PI_BIN") {
        if !v.is_empty() {
            return v;
        }
    }
    if let Some(home) = dirs::home_dir() {
        for sub in [".pi/agent/bin/pi", ".local/bin/pi"] {
            let p = home.join(sub);
            if p.is_file() {
                return p.to_string_lossy().into_owned();
            }
        }
    }
    "pi".to_string()
}

fn proc_alive(p: &PiProc) -> bool {
    p.child
        .lock()
        .map(|mut c| matches!(c.try_wait(), Ok(None)))
        .unwrap_or(false)
}

/// Spawn (or reuse) a `pi --mode rpc` child rooted at `cwd`.
/// Child identity: (window tag, session key). One pi child per session, so
/// runs proceed independently and switching views never touches agent state.
/// `key` is the session file path when known, else a unique fresh id.
/// `cwd` is only the process working directory for spawning.
fn proc_key(tag: &Option<String>, key: &str) -> String {
    format!("{}\n{}", tag.clone().unwrap_or_else(|| "main".to_string()), key)
}

impl AppState {
    /// Spawn (or reuse) a `pi --mode rpc` child rooted at `cwd`.
    /// Child identity: (window tag, session key). One pi child per session, so
    /// runs proceed independently and switching views never touches agent state.
    /// `key` is the session file path when known, else a unique fresh id.
    /// `cwd` is only the process working directory for spawning.
    fn pi_ensure_core(self: &Arc<Self>, cwd: String, session_dir: Option<String>, tag: Option<String>, key: String, session_path: Option<String>) -> Result<String, String> {
    let pkey = proc_key(&tag, &key);
    {
        let procs = self.procs.lock().map_err(|e| e.to_string())?;
        if let Some(p) = procs.get(&pkey) {
            if proc_alive(p) {
                return Ok("running".into());
            }
        }
    }
    // Reap dead proc if present.
    {
        let mut procs = self.procs.lock().map_err(|e| e.to_string())?;
        procs.remove(&pkey);
    }

    // Empty cwd (a fresh frontend with no config yet) means the backend
    // default, not an error — the phone UI hits this on first launch.
    let cwd = if cwd.trim().is_empty() {
        self.config.lock().map(|c| c.default_dir.clone()).unwrap_or_default()
    } else {
        cwd
    };
    if cwd.trim().is_empty() {
        return Err("no working dir and no backend default (config broken?)".into());
    }
    // Make sure the dir exists (default Q&A dir may not yet).
    fs::create_dir_all(&cwd).map_err(|e| format!("cannot use working dir '{cwd}': {e}"))?;

    let bin = pi_bin();
    // Marker for boot-time orphan reaping (see reap_stale_children):
    // survives in /proc/<pid>/environ, invisible everywhere else.
    // (Program selection below may replace a script shim with its
    // interpreter; PI_BIN still reports the canonical entry point.)
    let mut cmd = Command::new(&bin);
    cmd.env("PI_DESKTOP_CHILD", "1");
    // Jobs inherit the parent's PATH and run under /bin/sh, where a bare
    // "pi" relies on PATH — minimal under a KDE-launched desktop (no
    // ~/.pi/agent/bin), so submits fail exit 127. pi's own bash tool
    // prepends its bin dir; do the same here with PI_BIN's dir, so every
    // job from a desktop session resolves pi. An explicit PI_BIN override
    // passes through unchanged (pi_bin() returns it first).
    cmd.env("PI_BIN", &bin);
    if let Some(dir) = std::path::Path::new(&bin).parent() {
        let mut paths = vec![dir.as_os_str().to_owned()];
        paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).map(|p| p.into_os_string()));
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }
    cmd.arg("--mode")
        .arg("rpc")
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Single bundled prompt (shared core, both hosts): capability primer +
    // formatting guide, one flag. Grandchild subagents don't inherit CLI
    // flags, so the effective text also rides the env down for pi-jobs
    // to re-append (absent when disabled via PI_DESKTOP_APP_PROMPT=0).
    if let Some(prompt) = bundled_prompt_text() {
        cmd.arg("--append-system-prompt").arg(&prompt);
        cmd.env("PI_DESKTOP_APP_PROMPT_TEXT", prompt);
    }
    // Jobs extension only on explicit PI_DESKTOP_JOBS_EXT override;
    // normally jobs come from the user's own pi packages.
    if let Some(ext) = jobs_ext_path() {
        cmd.arg("--extension").arg(ext);
    }
    if let Some(sd) = session_dir {
        if !sd.is_empty() {
            cmd.arg("--session-dir").arg(sd);
        }
    }
    // Resume a specific session file when given; otherwise pi starts fresh
    // (which for an existing dir means continuing its most recent session
    // — callers pass an explicit fresh flow instead when they want new).
    if let Some(sp) = session_path {
        if !sp.is_empty() {
            cmd.arg("--session").arg(sp);
        }
    }
    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn pi binary '{bin}': {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    // Forward every stdout JSONL record tagged with its session key, so
    // each window renders only its currently viewed session. Records flow
    // through the shared broadcast: Tauri re-emits them as pi-record IPC,
    // the HTTP server streams them as SSE (see on_record).
    let this = Arc::clone(self);
    let cwd2 = cwd.clone();
    let tag2 = tag.clone().unwrap_or_else(|| "main".to_string());
    let key2 = key.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }
            let record: serde_json::Value =
                serde_json::from_str(&line).unwrap_or(serde_json::Value::String(line));
            this.on_record(&cwd2, &tag2, &key2, record);
        }
    });

    let mut procs = self.procs.lock().map_err(|e| e.to_string())?;
    procs.insert(
        pkey.clone(),
        PiProc {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
        },
    );
    drop(procs);
    // A (re)spawned proc has no live run by definition — a run cannot
    // survive its process. Drop any stale lifecycle mark (crashed pi
    // with no settled event), or the sidebar dot sticks until reboot.
    // The alive fast-path above deliberately skips this: mid-run
    // ensures must never erase a true mark.
    if let Ok(mut rs) = self.run_states.lock() {
        rs.remove(&pkey);
    }
    // Remember as last used. Quickbar dirs stay out of the shared recents:
    // its throwaway Q&A dirs would drown the real project list.
    if tag.as_deref() != Some("quickbar") {
        let mut cfg = self.config.lock().map_err(|e| e.to_string())?;
        cfg.last_cwd = cwd.clone();
        cfg.recents = push_recent(cfg.recents.clone(), &cwd);
        let snapshot = cfg.clone();
        save_config(&snapshot);
    }
    Ok("started".into())
    }
}

#[tauri::command]
fn pi_ensure(cwd: String, session_dir: Option<String>, tag: Option<String>, key: String, session_path: Option<String>, state: State<Arc<AppState>>) -> Result<String, String> {
    state.pi_ensure_core(cwd, session_dir, tag, key, session_path)
}

fn push_recent(mut recents: Vec<String>, cwd: &str) -> Vec<String> {
    recents.retain(|d| d != cwd);
    recents.insert(0, cwd.to_string());
    recents.truncate(12);
    recents
}

/// Write one JSON command line to the pi child for `cwd`.
impl AppState {
    /// Write one JSON command line to the pi child for `cwd`.
    fn pi_send_core(&self, _cwd: String, payload: serde_json::Value, tag: Option<String>, key: String) -> Result<(), String> {
    let procs = self.procs.lock().map_err(|e| e.to_string())?;
    let p = procs.get(&proc_key(&tag, &key)).ok_or("no pi running for this session (call pi_ensure)")?;
    if !proc_alive(p) {
        return Err("pi exited (call pi_ensure)".into());
    }
    let mut line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    line.push('\n');
    p.stdin
        .lock()
        .map_err(|e| e.to_string())?
        .write_all(line.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
    }
}

#[tauri::command]
fn pi_send(_cwd: String, payload: serde_json::Value, tag: Option<String>, key: String, state: State<Arc<AppState>>) -> Result<(), String> {
    state.pi_send_core(_cwd, payload, tag, key)
}

impl AppState {
    fn pi_stop_core(&self, _cwd: String, tag: Option<String>, key: String) -> Result<(), String> {
    let pkey = proc_key(&tag, &key);
    {
        let mut procs = self.procs.lock().map_err(|e| e.to_string())?;
        if let Some(p) = procs.remove(&pkey) {
            if let Ok(mut c) = p.child.lock() {
                let _ = c.kill();
            }
        }
    }
    // A stopped run is over: drop its lifecycle mark too, or run_states
    // (and every sidebar snapshot) accumulates dead keys forever.
    if let Ok(mut rs) = self.run_states.lock() {
        rs.remove(&pkey);
    }
    Ok(())
    }
}

#[tauri::command]
fn pi_stop(_cwd: String, tag: Option<String>, key: String, state: State<Arc<AppState>>) -> Result<(), String> {
    state.pi_stop_core(_cwd, tag, key)
}

// ---------------------------------------------------------------- sessions

#[derive(Debug, Clone, serde::Serialize)]
struct SessionInfo {
    path: String,
    id: String,
    timestamp: String,
    /// Last activity: file mtime (every message append bumps it), so the
    /// sidebar sorts and stamps by latest message, not session creation.
    updated: String,
    cwd: String,
    name: Option<String>,
    preview: Option<String>,
}

/// Best-effort quoted string value for `key` inside `obj` (flat scan, KISS).
fn quoted_after(obj: &str, key: &str) -> Option<String> {
    let n = obj.find(key)?;
    let seg = &obj[n + key.len()..];
    let c = seg.find(':')?;
    let v = seg[c + 1..].trim_start().strip_prefix('"')?;
    let mut s = String::new();
    let mut chars = v.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(e) = chars.next() {
                s.push(e);
            }
        } else if ch == '"' {
            break;
        } else {
            s.push(ch);
        }
        if s.len() > 160 {
            break;
        }
    }
    let s = s.trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Display name from `session_info` entries (set via /name). Last one wins.
fn scan_name(blob: &str) -> Option<String> {
    let mut name: Option<String> = None;
    let mut rest = blob;
    while let Some(i) = rest.find("\"type\":\"session_info\"") {
        let seg = &rest[i..(i + 600).min(rest.len())];
        if let Some(n) = quoted_after(seg, "\"name\"") {
            name = Some(n);
        }
        rest = &rest[i + 1..];
    }
    name
}

/// First user message text, for sidebar preview. Skips bash-echo noise.
fn scan_preview(blob: &str) -> Option<String> {
    let mut rest = blob;
    while let Some(i) = rest.find("\"role\":\"user\"") {
        let seg = &rest[i..(i + 2000).min(rest.len())];
        if let Some(t) = quoted_after(seg, "\"text\"") {
            if !t.starts_with("Ran `") {
                return Some(t);
            }
        }
        rest = &rest[i + 1..];
    }
    None
}

/// Bounded windows of a session file for the sidebar: header line,
/// preview window (first 256KB), name window (last 16KB). Transcripts
/// grow to multi-MB; the listing must never read them whole. Lossy
/// UTF-8 is fine — both scanners are best-effort text searches.
/// Returns (header_line, preview_window, tail_window). None = unreadable.
fn read_session_windows(p: &PathBuf) -> Option<(String, String, String)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(p).ok()?;
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut head = vec![0u8; (len.min(262144)) as usize];
    let mut n = 0;
    while n < head.len() {
        match f.read(&mut head[n..]) {
            Ok(0) => break, // concurrent truncate: take what we got
            Ok(m) => n += m,
            Err(_) => return None,
        }
    }
    head.truncate(n);
    let line_end = head
        .iter()
        .position(|&b| b == b'\n')
        .unwrap_or(head.len().min(2000));
    let header = String::from_utf8_lossy(&head[..line_end]).into_owned();
    let preview_win = String::from_utf8_lossy(&head).into_owned();
    let tail_len = (len.min(16384)) as usize;
    let mut tail = vec![0u8; tail_len];
    if tail_len > 0 {
        if f.seek(SeekFrom::End(-(tail_len as i64))).is_err() {
            return Some((header, preview_win, String::new()));
        }
        let mut m = 0;
        while m < tail.len() {
            match f.read(&mut tail[m..]) {
                Ok(0) => break,
                Ok(k) => m += k,
                Err(_) => return Some((header, preview_win, String::new())),
            }
        }
        tail.truncate(m);
    }
    Some((header, preview_win, String::from_utf8_lossy(&tail).into_owned()))
}

/// List session files (newest first), optionally filtered to one cwd.
/// Reads only the header line + small windows per file. KISS: no index DB.
#[tauri::command]
fn list_sessions(cwd_filter: Option<String>, session_root: Option<String>) -> Result<Vec<SessionInfo>, String> {
    let root = session_root.unwrap_or_else(session_root_default);
    let mut out: Vec<SessionInfo> = vec![];
    let groups = fs::read_dir(&root).map_err(|e| format!("session dir unreadable ({root}): {e}"))?;
    for g in groups.flatten() {
        let gp = g.path();
        if !gp.is_dir() {
            continue;
        }
        let files = match fs::read_dir(&gp) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            // Bounded windows (see read_session_windows): a sidebar row
            // must never load a whole multi-MB transcript.
            let (header, preview_win, tail_win) = match read_session_windows(&p) {
                Some(w) => w,
                None => continue,
            };
            let head: serde_json::Value = match serde_json::from_str(&header) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let cwd = head.get("cwd").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if let Some(ref want) = cwd_filter {
                if !want.is_empty() && &cwd != want {
                    continue;
                }
            }
            let id = head.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let timestamp = head.get("timestamp").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let name = scan_name(&tail_win);
            let preview = scan_preview(&preview_win);
            // Last activity = file mtime: every message (mine or agent's)
            // appends, so a reply in an old session bumps it to the top.
            // Falls back to creation time when the clock can't be read.
            let updated = f.metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|t| chrono::DateTime::<chrono::Utc>::from(t).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| timestamp.clone());
            out.push(SessionInfo {
                path: p.to_string_lossy().into_owned(),
                id,
                timestamp,
                updated,
                cwd,
                name,
                preview,
            });
        }
    }
    out.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| b.timestamp.cmp(&a.timestamp)));
    Ok(out)
}

/// Read a media file for inline display. Returns `{"mime", "base64"}`.
/// Relative paths resolve against `base` (the viewed session's cwd).
/// Absolute paths are used as-is. Cap 64MB (matches save_upload).
/// Bigger files stay a click-to-open card handled frontend-side.
///
/// Why bytes-over-IPC instead of convertFileSrc/asset URLs: this box's
/// WebKitGTK fails Tauri custom-scheme loads entirely (asset: *and* the
/// IPC scheme fall back with "Load failed" once assetProtocol is
/// touched), while plain invoke round-trips fine. Data URIs use no
/// custom scheme at all.
/// Shared media path resolution for read_media + media_stat: ~ expansion,
/// absolute use, base-relative join, file:// strip. One rule, both doors.
fn resolve_media_path(path: &str, base: &Option<String>) -> Result<PathBuf, String> {
    let p = if let Some(rest) = path.strip_prefix("~/") {
        // Frontend can't expand ~ (it doesn't know HOME); backend can.
        match dirs::home_dir() {
            Some(h) => h.join(rest),
            None => return Err("cannot resolve ~ (no home dir)".into()),
        }
    } else if std::path::Path::new(&path).is_absolute() {
        PathBuf::from(&path)
    } else if let Some(b) = base.clone().filter(|b| !b.is_empty()) {
        PathBuf::from(b).join(&path)
    } else {
        return Err("relative media path with no base dir".into());
    };
    // file:// prefix from markdown ("file:///x/y.png" -> "/x/y.png").
    let s = p.to_string_lossy();
    let s = s.strip_prefix("file://").unwrap_or(&s);
    Ok(PathBuf::from(s))
}

fn media_stat_json(meta: &fs::Metadata) -> serde_json::Value {
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    serde_json::json!({ "mtimeMs": mtime_ms, "size": meta.len() })
}

/// MIME table shared by read_media (data URIs for Tauri IPC) and the
/// HTTP /api/media route (raw bytes for browser mode).
pub(crate) fn media_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        // Text-ish types ride along as UTF-8 for snippet previews.
        // Decoded frontend-side; binary office formats stay unsupported.
        "txt" | "md" | "markdown" | "json" | "csv" | "tsv" | "log"
        | "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx" | "py" | "rs"
        | "go" | "java" | "c" | "h" | "cpp" | "hpp" | "cs" | "rb"
        | "php" | "swift" | "kt" | "html" | "htm" | "css" | "scss"
        | "sh" | "bash" | "yaml" | "yml" | "toml" | "ini" | "cfg"
        | "xml" | "sql" | "r" | "dockerfile" | "gitignore" => "text/plain",
        _ => return None,
    })
}

/// Cheap stat for the frontend's media cache: lets it revalidate bytes
/// without re-transferring them (same-path rewrites re-read, unchanged
/// files never do). Mirrors read_media's resolution exactly.
#[tauri::command]
fn media_stat(path: String, base: Option<String>) -> Result<serde_json::Value, String> {
    let p = resolve_media_path(&path, &base)?;
    let meta = fs::metadata(&p).map_err(|e| format!("unreadable media file: {e}"))?;
    Ok(media_stat_json(&meta))
}

#[tauri::command]
fn read_media(path: String, base: Option<String>) -> Result<serde_json::Value, String> {
    let p = resolve_media_path(&path, &base)?;
    let meta = fs::metadata(&p).map_err(|e| format!("unreadable media file: {e}"))?;
    if meta.len() > 64 * 1024 * 1024 {
        return Err("media file too large for inline display (>64MB)".into());
    }
    let bytes = fs::read(&p).map_err(|e| format!("unreadable media file: {e}"))?;
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let mime = media_mime(&ext).ok_or_else(|| format!("unsupported media type: .{ext}"))?;
    // Stat rides along so the frontend can revalidate its cache without
    // re-transferring bytes (see media_stat + the data-fast loop).
    let stat = media_stat_json(&meta);
    Ok(serde_json::json!({
        "mime": mime,
        "base64": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "mtimeMs": stat.get("mtimeMs"),
        "size": stat.get("size"),
    }))
}

/// First rows of a spreadsheet for table previews: xlsx/xls/ods/csv.
/// Returns `{sheets, sheet, rows, truncated}` (rows capped 50x20,
/// default 8x8). Pure-Rust (calamine), no system deps.
#[tauri::command]
fn read_sheet(path: String, base: Option<String>, sheet: Option<String>, max_rows: Option<usize>, max_cols: Option<usize>) -> Result<serde_json::Value, String> {
    let p = resolve_media_path(&path, &base)?;
    let meta = fs::metadata(&p).map_err(|e| format!("unreadable sheet file: {e}"))?;
    if meta.len() > 64 * 1024 * 1024 {
        return Err("sheet file too large (>64MB)".into());
    }
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !["xlsx", "xls", "ods", "csv"].contains(&ext.as_str()) {
        return Err(format!("unsupported sheet type: .{ext}"));
    }
    let mut wb = calamine::open_workbook_auto(&p).map_err(|e| format!("unreadable sheet: {e}"))?;
    let names = wb.sheet_names().to_vec();
    let first = names.first().cloned().unwrap_or_default();
    let which = sheet.filter(|s| !s.is_empty()).unwrap_or(first);
    let range = wb.worksheet_range(&which).map_err(|e| format!("unreadable sheet: {e}"))?;
    let max_r = max_rows.unwrap_or(8).clamp(1, 50);
    let max_c = max_cols.unwrap_or(8).clamp(1, 20);
    let rows: Vec<Vec<String>> = range
        .rows()
        .take(max_r)
        .map(|r| r.iter().take(max_c).map(|c| c.to_string()).collect())
        .collect();
    let truncated = range.height() > max_r || range.width() > max_c;
    Ok(serde_json::json!({ "sheets": names, "sheet": which, "rows": rows, "truncated": truncated }))
}

/// Text content of office documents for preview cards: docx (word/
/// document.xml // w:t), pptx (ppt/slides/slide*.xml // a:t), odt
/// (content.xml // text:p|h). Pure-Rust zip+xml, no system deps.
/// Returns `{text, truncated}` (6000 chars max).
#[tauri::command]
fn read_office_text(path: String, base: Option<String>) -> Result<serde_json::Value, String> {
    let p = resolve_media_path(&path, &base)?;
    let meta = fs::metadata(&p).map_err(|e| format!("unreadable office file: {e}"))?;
    if meta.len() > 64 * 1024 * 1024 {
        return Err("office file too large (>64MB)".into());
    }
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let (entry_filter, text_tag, para_tag): (fn(&str) -> bool, &[u8], &[u8]) = match ext.as_str() {
        "docx" => (|n| n == "word/document.xml", b"w:t", b"w:p"),
        "pptx" => (|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"), b"a:t", b"a:p"),
        "odt" => (|n| n == "content.xml", b"text:p", b"text:p"),
        _ => return Err(format!("unsupported office type: .{ext}")),
    };
    let file = fs::File::open(&p).map_err(|e| format!("unreadable office file: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("unreadable office file: {e}"))?;
    let mut names: Vec<String> = zip.file_names().filter(|n| entry_filter(n)).map(|s| s.to_string()).collect();
    // Slide order: slide1, slide2, ... slide10 (lexical sort lies).
    names.sort_by_key(|n| {
        n.rsplit('/')
            .next()
            .unwrap_or(n)
            .trim_start_matches(|c: char| !c.is_ascii_digit())
            .trim_end_matches(|c: char| !c.is_ascii_digit())
            .parse::<u32>()
            .unwrap_or(0)
    });
    if names.is_empty() {
        return Err("no readable content in office file".into());
    }
    let mut out = String::new();
    for name in names {
        use std::io::Read as _;
        let mut f = zip.by_name(&name).map_err(|e| format!("unreadable office file: {e}"))?;
        let mut xml = Vec::new();
        f.read_to_end(&mut xml).map_err(|e| format!("unreadable office file: {e}"))?;
        let mut reader = quick_xml::Reader::from_reader(xml.as_slice());
        reader.trim_text(true);
        let mut buf = Vec::new();
        let mut depth: i32 = 0;
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(quick_xml::events::Event::Start(ref e)) if e.name().as_ref() == text_tag => depth += 1,
                Ok(quick_xml::events::Event::End(ref e)) if e.name().as_ref() == text_tag => {
                    depth -= 1;
                    if para_tag == text_tag {
                        out.push('\n');
                    }
                }
                Ok(quick_xml::events::Event::End(ref e)) if e.name().as_ref() == para_tag => out.push('\n'),
                Ok(quick_xml::events::Event::Text(ref e)) if depth > 0 => {
                    if let Ok(t) = e.unescape() {
                        out.push_str(&t);
                        out.push(' ');
                    }
                }
                Ok(quick_xml::events::Event::Eof) => break,
                Err(e) => return Err(format!("unreadable office file: {e}")),
                _ => {}
            }
            buf.clear();
            if out.len() > 7000 {
                break;
            }
        }
        out.push('\n');
        if out.len() > 7000 {
            break;
        }
    }
    let joined: String = out
        .split('\n')
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let truncated = joined.len() > 6000;
    let text: String = joined.chars().take(6000).collect();
    Ok(serde_json::json!({ "text": text, "truncated": truncated }))
}

#[tauri::command]
fn delete_session(path: String, session_root: Option<String>) -> Result<(), String> {
    let root = session_root.unwrap_or_else(session_root_default);
    // Canonicalize: lexical starts_with is fooled by `..` segments
    // ("/root/../evil" starts with "/root" component-wise).
    let canonical_root = fs::canonicalize(&root).map_err(|e| format!("unreadable session root: {e}"))?;
    let p = PathBuf::from(&path);
    let canonical = fs::canonicalize(&p).map_err(|e| format!("unreadable session file: {e}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("refusing to delete outside session dir".into());
    }
    fs::remove_file(&canonical).map_err(|e| e.to_string())
}

/// Rename a session: append a `session_info` name entry (last one wins
/// for the sidebar — same shape pi itself writes via set_session_name).
/// Chained onto the file's last entry id so history stays linked.
/// Works on any session, live or not: no proc needed.
#[tauri::command]
fn rename_session(path: String, name: String, session_root: Option<String>) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("empty name".into());
    }
    if name.chars().count() > 120 {
        return Err("name too long (max 120 chars)".into());
    }
    let root = session_root.unwrap_or_else(session_root_default);
    let canonical_root = fs::canonicalize(&root).map_err(|e| format!("unreadable session root: {e}"))?;
    let p = PathBuf::from(&path);
    let canonical = fs::canonicalize(&p).map_err(|e| format!("unreadable session file: {e}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("refusing to rename outside session dir".into());
    }
    let text = fs::read_to_string(&canonical).map_err(|e| e.to_string())?;
    let mut parent_id = String::new();
    for line in text.lines().rev() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                parent_id = id.to_string();
                break;
            }
        }
    }
    static RENAME_CTR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = RENAME_CTR.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let id = format!("{:08x}", (nanos ^ (std::process::id() as u128) ^ (n as u128)) & 0xffff_ffff);
    let entry = serde_json::json!({
        "type": "session_info",
        "id": id,
        "parentId": parent_id,
        "timestamp": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        "name": name,
    });
    use std::io::Write as _;
    let mut f = fs::OpenOptions::new()
        .append(true)
        .open(&canonical)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{entry}").map_err(|e| e.to_string())?;
    Ok(())
}

/// Windowed transcript of ANY session file, parsed straight from disk.
/// Same message shape as get_messages. This is what history rebuilds read:
/// the file is the truth every writer shares, so a stale, dead, or busy
/// pi process can never hide a reply from the view again. Torn trailing
/// lines (concurrent writers) are skipped, never fatal. Bounded.
///
/// Windowing: sessions grow without bound and the view must never parse +
/// transfer + render the whole thing in one shot. Windows are BYTE-budgeted
/// (message counts lie: one tool result can outweigh a thousand chats).
/// `max_bytes` caps the window (default 256KB, clamped 4KB–8MB),
/// `offset` skips that many NEWEST messages (page back with offset =
/// already-loaded count). Returns `{messages, total, has_more, bytes}` so
/// the UI can offer "show earlier". At least one message always returns
/// (no empty-window spin when a single message exceeds the budget).
#[tauri::command]
fn read_session_messages(path: String, session_root: Option<String>, max_bytes: Option<usize>, offset: Option<usize>) -> Result<serde_json::Value, String> {
    let root = session_root.unwrap_or_else(session_root_default);
    let p = PathBuf::from(&path);
    // Containment: the file must live inside the session root.
    let canonical_root = fs::canonicalize(&root).map_err(|e| format!("unreadable session root: {e}"))?;
    let canonical = fs::canonicalize(&p).map_err(|e| format!("unreadable session file: {e}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("refusing to read outside session dir".into());
    }
    let meta = fs::metadata(&canonical).map_err(|e| format!("unreadable session file: {e}"))?;
    // Generous cap: the full parse stays server-side (fast even at tens of
    // MB) and only the requested window crosses IPC, so large files stay
    // on the windowed disk path instead of falling back to a full-RPC load.
    if meta.len() > 64 * 1024 * 1024 {
        return Err("session file too large (>64MB)".into());
    }
    let text = fs::read_to_string(&canonical).map_err(|e| format!("unreadable session file: {e}"))?;
    // Single pass: collect entries oldest-first, tagged by kind.
    // Regular messages spend the byte budget below; custom messages
    // (spawn cards/notes) ALWAYS ride along under their own generous
    // cap. The side panels are an index over customs — paging them out
    // would wipe the panels on every revisit of a long session.
    // The file read + parse stays server-side (fast even at multi-MB);
    // only the requested window crosses IPC and reaches the renderer.
    let mut messages: Vec<(serde_json::Value, bool)> = vec![];
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue, // torn line from a concurrent writer: skip
        };
        if v.get("type").and_then(|t| t.as_str()) == Some("message") {
            if let Some(m) = v.get("message").cloned() {
                messages.push((m, false));
            }
        } else if v.get("type").and_then(|t| t.as_str()) == Some("custom_message") {
            // Custom messages (spawn cards/notes): shape them like live
            // RPC so history rebuilds track and render exactly what live
            // did. Without this, spawn rows/cards exist only until the
            // next revisit — switching sessions wipes the panels.
            let mut m = serde_json::Map::new();
            m.insert("role".into(), serde_json::Value::String("custom".into()));
            for k in ["customType", "content", "display", "details"] {
                if let Some(val) = v.get(k).cloned() {
                    m.insert(k.into(), val);
                }
            }
            messages.push((serde_json::Value::Object(m), true));
        }
    }
    let total = messages.len();
    let off = offset.unwrap_or(0).min(total);
    let budget = max_bytes.unwrap_or(256 * 1024).clamp(4 * 1024, 8 * 1024 * 1024);
    // Newest-first paging: window ends `off` before the newest message.
    // Spend the byte budget walking back (sizes are serialized lengths —
    // honest transfer bytes); always take ≥1 so oversized singletons
    // can't trap the pager on an empty window with has_more set.
    let end = total - off;
    // Budget counts render-weight, not raw transfer bytes: a single
    // multi-MB message (screenshot blobs in tool results transfer but
    // render as one line) must not eat a whole page and strand paging
    // at one invisible row per click. Each message counts at most 32KB
    // toward the stop condition; `bytes` still reports actual transfer
    // size (refreshMsgs re-reads by it — capping it would shrink the
    // window and lose messages).
    const MSG_BUDGET_CAP: usize = 32 * 1024;
    const CUSTOM_BUDGET: usize = 512 * 1024;
    let mut selected = vec![false; end];
    let mut acc: usize = 0;
    let mut custom_acc: usize = 0;
    let mut bytes: usize = 0;
    let mut start = end;
    // Pass 1: newest-first budget walk over regulars; customs encountered
    // ride free under their own cap.
    while start > 0 {
        let (m, is_custom) = &messages[start - 1];
        let size = serde_json::to_string(m).map(|s| s.len()).unwrap_or(0);
        let custom = *is_custom;
        if custom {
            if custom_acc + size <= CUSTOM_BUDGET {
                custom_acc += size;
                bytes += size;
                selected[start - 1] = true;
            }
            start -= 1;
            continue;
        }
        if acc + size.min(MSG_BUDGET_CAP) > budget && start < end {
            break;
        }
        acc += size.min(MSG_BUDGET_CAP);
        bytes += size;
        selected[start - 1] = true;
        start -= 1;
    }
    // Pass 2: the walk stops at the first over-budget regular, stranding
    // older customs. Sweep them up so the panels' index is complete no
    // matter how long the session grows.
    if start > 0 {
        let mut i = start;
        while i > 0 {
            i -= 1;
            if !messages[i].1 {
                continue;
            }
            let size = serde_json::to_string(&messages[i].0).map(|s| s.len()).unwrap_or(0);
            if custom_acc + size <= CUSTOM_BUDGET {
                custom_acc += size;
                bytes += size;
                selected[i] = true;
            }
        }
    }
    let window: Vec<serde_json::Value> = messages[..end]
        .iter()
        .enumerate()
        .filter(|(i, _)| selected[*i])
        .map(|(_, (m, _))| m.clone())
        .collect();
    let has_more = start > 0;
    Ok(serde_json::json!({ "messages": window, "total": total, "has_more": has_more, "bytes": bytes }))
}

/// Phone-as-client (remote mode): serve the same core over HTTP so the
/// phone app can reach this desktop. Localhost when no token is set
/// (safe default); all interfaces + Bearer auth once a token exists.
/// Desktop only — the phone app has no use for a TCP server.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn serve_http_for_phone() {
    std::thread::spawn(|| server::run_server(None));
}

/// Direct-chat network pipe: the phone WebView can't call provider APIs
/// itself (CORS blocks cross-origin fetch, and some gateways reject
/// browser origins outright). This runs the HTTPS request natively and
/// streams raw bytes back over a Tauri Channel the frontend reassembles
/// into SSE. Works on-device and on desktop; meaningless over the HTTP
/// bridge itself (direct mode never runs remote).
#[tauri::command]
async fn direct_fetch(
    url: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
    method: Option<String>,
    on_chunk: tauri::ipc::Channel<Vec<u8>>,
) -> Result<(), String> {
    // No timeout = a dead network hangs the call forever with no error.
    // Fail loud instead.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("direct: client error: {e}"))?;
    eprintln!("[direct] fetch {url}");
    let mut rb = if method.as_deref() == Some("GET") {
        client.get(&url)
    } else {
        client.post(&url)
    };
    rb = rb
        .header("Accept", "*/*")
        .header("User-Agent", "pi-desktop/0.1");
    for (k, v) in &headers {
        rb = rb.header(k, v);
    }
    if let Some(b) = body.as_deref() {
        rb = rb
            .header("content-type", "application/json")
            .body(b.to_string());
    }
    let mut resp = rb
        .send()
        .await
        .map_err(|e| format!("direct: request failed: {e}"))?;
    let status = resp.status();
    eprintln!("[direct] status {status} for {url}");
    if !status.is_success() {
        let t = resp.text().await.unwrap_or_default();
        let short: String = t.chars().take(300).collect();
        return Err(format!("direct: {status} {short} :: {url}"));
    }
    loop {
        match resp.chunk().await {
            Ok(Some(bytes)) => on_chunk
                .send(bytes.to_vec())
                .map_err(|e| format!("direct: channel closed: {e}"))?,
            Ok(None) => break,
            Err(e) => return Err(format!("direct: stream error: {e}")),
        }
    }
    Ok(())
}

/// Stop the backend itself (detached server mode: the server outlives
/// the UI, so an explicit stop is needed). Kills supervised pi
/// children, then exits after the response flushes.
#[tauri::command]
fn shutdown_server(state: State<Arc<AppState>>) -> Result<(), String> {
    let st = state.inner().clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        st.kill_all();
        std::process::exit(0);
    });
    Ok(())
}

/// Run-lifecycle snapshot for sidebar status dots: {bootId, runs:

/// [{tag, key, streaming}]}. Read from the tracked map (no pi traffic).
/// Unknown sessions are simply absent (= idle).
impl AppState {
    fn pi_states_core(&self) -> serde_json::Value {
    let runs = match self.run_states.lock() {
        Ok(rs) => rs
            .iter()
            .map(|(k, v)| {
                let mut parts = k.splitn(2, '\n');
                let tag = parts.next().unwrap_or("").to_string();
                let key = parts.next().unwrap_or("").to_string();
                serde_json::json!({ "tag": tag, "key": key, "streaming": v })
            })
            .collect(),
        Err(_) => vec![],
    };
    serde_json::json!({ "bootId": self.boot_id, "runs": runs })
    }
}

#[tauri::command]
fn pi_states(state: State<Arc<AppState>>) -> serde_json::Value {
    state.pi_states_core()
}

/// Resolve a pi-jobs log file for a job id, run id, or unambiguous prefix
/// from the SQLite store (`~/.pi/agent/jobs/jobs.db`). Returns the
/// effective log (the job's own `customLog`, e.g. a pi session jsonl,
/// else the captured `output.log`). Store paths were recorded by the
/// agent's own job tool (the same files `job logs` reads), so they only
/// need to be absolute.
/// SQLite store (`jobs.db`, WAL). Short reads only, never held open.
fn abs_path(p: &str) -> Result<PathBuf, String> {
    let pb = PathBuf::from(p);
    if pb.is_absolute() {
        Ok(pb)
    } else {
        Err("job log path is not absolute".into())
    }
}

fn resolve_job_log(id: &str) -> Result<PathBuf, String> {
    if id.is_empty()
        || id.len() > 128
        || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid job id".into());
    }
    let home = dirs::home_dir().ok_or("no home dir")?;
    let db_path = home.join(".pi").join("agent").join("jobs").join("jobs.db");
    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| format!("unreadable jobs db: {e}"))?;
    // Exact job id → its latest run; exact run id → itself.
    let hit: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT log_file, custom_log FROM runs WHERE job_id = ?1 ORDER BY started_at DESC LIMIT 1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    if let Some((log_file, custom_log)) = hit {
        let pick = custom_log.filter(|s: &String| !s.is_empty()).unwrap_or(log_file);
        if pick.is_empty() {
            return Err("job run has no log file yet".into());
        }
        return abs_path(&pick);
    }
    let run_hit: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT log_file, custom_log FROM runs WHERE run_id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    if let Some((log_file, custom_log)) = run_hit {
        let pick = custom_log.filter(|s: &String| !s.is_empty()).unwrap_or(log_file);
        if pick.is_empty() {
            return Err("job run has no log file yet".into());
        }
        return abs_path(&pick);
    }
    // Unambiguous prefix over jobs + runs, like the job tool. Ids are
    // [A-Za-z0-9_-] (validated above), so GLOB needs no escaping.
    let pattern = format!("{id}*");
    let mut stmt = conn.prepare("SELECT id FROM jobs WHERE id GLOB ?1").map_err(|e| format!("unreadable jobs db: {e}"))?;
    let j_hits: Vec<String> = stmt.query_map([pattern.as_str()], |row| row.get(0)).map_err(|e| format!("unreadable jobs db: {e}"))?.filter_map(|r| r.ok()).collect();
    let mut stmt = conn.prepare("SELECT run_id FROM runs WHERE run_id GLOB ?1").map_err(|e| format!("unreadable jobs db: {e}"))?;
    let r_hits: Vec<String> = stmt.query_map([pattern.as_str()], |row| row.get(0)).map_err(|e| format!("unreadable jobs db: {e}"))?.filter_map(|r| r.ok()).collect();
    if j_hits.len() + r_hits.len() > 1 {
        return Err(format!("'{id}' matches multiple jobs/runs; use a longer id"));
    }
    if j_hits.len() == 1 {
        let hit: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT log_file, custom_log FROM runs WHERE job_id = ?1 ORDER BY started_at DESC LIMIT 1",
                [&j_hits[0]],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        if let Some((log_file, custom_log)) = hit {
            let pick = custom_log.filter(|s: &String| !s.is_empty()).unwrap_or(log_file);
            return abs_path(&pick);
        }
        return Err("job has no runs yet".into());
    }
    if r_hits.len() == 1 {
        let hit: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT log_file, custom_log FROM runs WHERE run_id = ?1",
                [&r_hits[0]],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        if let Some((log_file, custom_log)) = hit {
            let pick = custom_log.filter(|s: &String| !s.is_empty()).unwrap_or(log_file);
            return abs_path(&pick);
        }
    }
    Err(format!("no such job '{id}'"))
}

/// Legacy JSON registry (`registry.json`, pre-sqlite pi-jobs). Same
/// semantics as the sqlite store. `None` = registry unusable/absent.
/// Transcript of one pi-jobs subagent: its session jsonl parsed into
/// `{messages}` in get_messages shape so the frontend renders it with the
/// same renderer. Bounded (newest 2000). Errors when the job's log is not
/// a session jsonl (use read_job_log for plain output).
#[tauri::command]
fn read_job_transcript(id: String) -> Result<serde_json::Value, String> {
    let path = resolve_job_log(&id)?;
    if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
        return Err("not a subagent session (plain log — use the Processes tab)".into());
    }
    let meta = fs::metadata(&path).map_err(|e| format!("unreadable session file: {e}"))?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err("job transcript too large (>2MB)".into());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("unreadable session file: {e}"))?;
    // Ring: keep the NEWEST 2000. Breaking at the cap would pin the
    // oldest (long sessions would silently lose their recent end).
    let mut messages = std::collections::VecDeque::with_capacity(2001);
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue, // torn line from a concurrent writer: skip
        };
        if v.get("type").and_then(|t| t.as_str()) == Some("message") {
            if let Some(m) = v.get("message").cloned() {
                messages.push_back(m);
                if messages.len() > 2000 {
                    messages.pop_front();
                }
            }
        }
    }
    Ok(serde_json::json!({ "messages": messages }))
}

/// Tail of one pi-jobs run's log. Returns `{text, size, truncated}` — the
/// last 256KB starting on a line boundary. Never parses: raw bytes for
/// the UI to render as text. For subagent sessions this is the raw jsonl;
/// the Agents tab parses it via read_job_transcript instead.
#[tauri::command]
fn read_job_log(id: String) -> Result<serde_json::Value, String> {
    let path = resolve_job_log(&id)?;
    const HEAD_CAP: u64 = 8 * 1024 * 1024;
    const WINDOW: usize = 256 * 1024;
    let mut f = fs::File::open(&path).map_err(|e| format!("unreadable job log: {e}"))?;
    let size = f.metadata().map_err(|e| format!("unreadable job log: {e}"))?.len();
    use std::io::{Read, Seek, SeekFrom};
    if size > HEAD_CAP {
        f.seek(SeekFrom::Start(size - HEAD_CAP)).map_err(|e| e.to_string())?;
    }
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).map_err(|e| format!("unreadable job log: {e}"))?;
    let mut start = bytes.len().saturating_sub(WINDOW);
    if start > 0 {
        // Align to the next line boundary (skip a torn first line).
        if let Some(pos) = bytes[start..].iter().position(|&b| b == b'\n') {
            start += pos + 1;
        }
    }
    let text = String::from_utf8_lossy(&bytes[start..]).into_owned();
    Ok(serde_json::json!({ "text": text, "size": size, "truncated": (start > 0) || (size > bytes.len() as u64) }))
}

/// Native job listing for the sidebar: every job submitted from one pi
/// session (matched on the session file pi-jobs records at submit time)
/// with its latest run. The DB is the source of truth — the frontend
/// renders this directly instead of scraping chat messages. Returns
/// `{jobs: [{id, label, state, kind, startedAt, durationMs, runId, pid,
/// logFile, exitCode}]}`. kind: a session-jsonl log means the pi-subagent
/// recipe (Agents tab), anything else is a plain process.
#[tauri::command]
fn list_session_jobs(session_file: String) -> Result<serde_json::Value, String> {
    if session_file.trim().is_empty() {
        return Ok(serde_json::json!({ "jobs": [] }));
    }
    let home = dirs::home_dir().ok_or("no home dir")?;
    let db_path = home.join(".pi").join("agent").join("jobs").join("jobs.db");
    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| format!("unreadable jobs db: {e}"))?;
    let _ = conn.pragma_update(None, "query_only", true);
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("unreadable jobs db: {e}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT j.id, j.label, r.run_id, r.state, r.pid, r.started_at, r.ended_at, r.exit_code, r.log_file, r.custom_log
             FROM jobs j LEFT JOIN runs r ON r.job_id = j.id
               AND r.started_at = (SELECT MAX(started_at) FROM runs WHERE job_id = j.id)
             WHERE j.session_file = ?1 ORDER BY j.created_at DESC LIMIT 200",
        )
        .map_err(|e| format!("unreadable jobs db: {e}"))?;
    let rows = stmt
        .query_map([session_file.as_str()], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "label": row.get::<_, String>(1)?,
                "runId": row.get::<_, Option<String>>(2)?,
                "state": row.get::<_, Option<String>>(3)?.unwrap_or_else(|| "running".to_string()),
                "pid": row.get::<_, Option<i32>>(4)?,
                "startedAt": row.get::<_, Option<i64>>(5)?,
                "endedAt": row.get::<_, Option<i64>>(6)?,
                "exitCode": row.get::<_, Option<i64>>(7)?,
                "logFile": row.get::<_, Option<String>>(8)?,
                "customLog": row.get::<_, Option<String>>(9)?,
            }))
        })
        .map_err(|e| format!("unreadable jobs db: {e}"))?;
    let mut jobs = Vec::new();
    for r in rows {
        let mut j = r.map_err(|e| format!("unreadable jobs db: {e}"))?;
        let log: String = j
            .get("customLog")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| j.get("logFile").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .unwrap_or_default();
        let kind = if log.ends_with(".jsonl") { "agent" } else { "proc" };
        let duration_ms = match (j.get("startedAt").and_then(|v| v.as_i64()), j.get("endedAt").and_then(|v| v.as_i64())) {
            (Some(s), Some(e)) => Some(e - s),
            _ => None,
        };
        j["kind"] = serde_json::json!(kind);
        j["logFile"] = serde_json::json!(log);
        j["durationMs"] = duration_ms.map(serde_json::Value::from).unwrap_or(serde_json::Value::Null);
        jobs.push(j);
    }
    Ok(serde_json::json!({ "jobs": jobs }))
}

impl AppState {
    /// Store an uploaded file inside the session cwd so the agent can
    /// read it: `<cwd>/.pi-desktop-uploads/<name>`. Returns `{path}`.
    /// Browser File objects have no path; this bridges them to one.
    /// Cap 64MB (disk is cheap; the 12MB read_media cap still guards
    /// inline rendering). Names sanitized, collisions suffixed.
    /// The frontend appends the path to the message text.
    fn save_upload_core(cwd: String, name: String, data: String) -> Result<serde_json::Value, String> {
        let clean: String = std::path::Path::new(&name)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("upload")
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let clean = clean.trim_matches('.').to_string();
        let clean = if clean.is_empty() || clean.len() > 128 { "upload".to_string() } else { clean };
        let dir = PathBuf::from(&cwd).join(".pi-desktop-uploads");
        fs::create_dir_all(&dir).map_err(|e| format!("unreadable working dir: {e}"))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.trim())
            .map_err(|_| "invalid base64".to_string())?;
        if bytes.len() > 64 * 1024 * 1024 {
            return Err("file too large (>64MB)".into());
        }
        let (stem, ext) = match clean.rfind('.') {
            Some(i) if i > 0 => (clean[..i].to_string(), clean[i..].to_string()),
            _ => (clean.clone(), String::new()),
        };
        let mut i = 0;
        let path = loop {
            let candidate = if i == 0 {
                dir.join(format!("{stem}{ext}"))
            } else {
                dir.join(format!("{stem}-{i}{ext}"))
            };
            if !candidate.exists() {
                break candidate;
            }
            i += 1;
            if i > 1000 {
                return Err("too many uploads with this name".into());
            }
        };
        fs::write(&path, &bytes).map_err(|e| format!("write failed: {e}"))?;
        Ok(serde_json::json!({ "path": path.to_string_lossy() }))
    }
}

#[tauri::command]
fn save_upload(cwd: String, name: String, data: String, state: State<Arc<AppState>>) -> Result<serde_json::Value, String> {
    let _ = state;
    AppState::save_upload_core(cwd, name, data)
}

// ---------------------------------------------------------------- config

impl AppState {
    fn get_config_core(&self) -> AppConfig {
    self.config.lock().map(|c| c.clone()).unwrap_or_default()
    }
}

#[tauri::command]
fn get_config(state: State<Arc<AppState>>) -> AppConfig {
    state.get_config_core()
}

/// Hotkey validation: desktop parses via the real Shortcut type;
/// mobile just checks non-empty (no global shortcuts there, and the
/// plugin isn't a dependency on android/ios). Server --server path
/// shares this, so validation must compile everywhere.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn validate_hotkey(s: &str) -> Result<(), String> {
    let _: tauri_plugin_global_shortcut::Shortcut =
        s.parse().map_err(|_| format!("bad hotkey: {s}"))?;
    Ok(())
}
#[cfg(any(target_os = "android", target_os = "ios"))]
fn validate_hotkey(s: &str) -> Result<(), String> {
    if s.trim().is_empty() {
        return Err("bad hotkey: empty".into());
    }
    Ok(())
}

impl AppState {
    /// Apply a config patch: validate, mutate, persist. Returns the
    /// snapshot plus which window-side effects the host must apply
    /// (hotkey re-registration, tray visibility). Validation runs before
    /// any mutation; the old code mutated first and failed dirty.
    fn set_config_core(&self, patch: &serde_json::Value) -> Result<(AppConfig, bool, bool), String> {
    if patch.get("quickbar_hotkey").or(patch.get("main_hotkey")).is_some() {
        let cfg = self.config.lock().map_err(|e| e.to_string())?;
        let q = patch
            .get("quickbar_hotkey")
            .and_then(|v| v.as_str())
            .unwrap_or(&cfg.quickbar_hotkey)
            .to_string();
        let m = patch
            .get("main_hotkey")
            .and_then(|v| v.as_str())
            .unwrap_or(&cfg.main_hotkey)
            .to_string();
        drop(cfg);
        // Validate BEFORE unregister_all: a typo must not wipe working keys.
        validate_hotkey(&q)?;
        validate_hotkey(&m)?;
    }
    let mut cfg = self.config.lock().map_err(|e| e.to_string())?;
    if let Some(v) = patch.get("default_dir").and_then(|v| v.as_str()) {
        cfg.default_dir = v.to_string();
    }
    if let Some(v) = patch.get("last_cwd").and_then(|v| v.as_str()) {
        cfg.last_cwd = v.to_string();
    }
    if let Some(arr) = patch.get("recents").and_then(|v| v.as_array()) {
        cfg.recents = arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
    }
    let mut tray_changed = false;
    if let Some(v) = patch.get("run_in_bg").and_then(|v| v.as_bool()) {
        cfg.run_in_bg = v;
        tray_changed = true;
    }
    if let Some(v) = patch.get("remote_port").and_then(|v| v.as_u64()) {
        if !(1..=65535).contains(&v) {
            return Err(format!("bad remote_port: {v} (1-65535, restart to rebind)"));
        }
        cfg.remote_port = v as u16;
    }
    if let Some(v) = patch.get("remote_token").and_then(|v| v.as_str()) {
        if v.len() > 256 {
            return Err("bad remote_token: too long".into());
        }
        cfg.remote_token = v.to_string();
    }
    let mut hotkeys_changed = false;
    if patch.get("quickbar_hotkey").or(patch.get("main_hotkey")).is_some() {
        // Validated above: infallible here.
        if let Some(v) = patch.get("quickbar_hotkey").and_then(|v| v.as_str()) {
            cfg.quickbar_hotkey = v.to_string();
        }
        if let Some(v) = patch.get("main_hotkey").and_then(|v| v.as_str()) {
            cfg.main_hotkey = v.to_string();
        }
        hotkeys_changed = true;
    }
    let snapshot = cfg.clone();
    save_config(&snapshot);
    Ok((snapshot, hotkeys_changed, tray_changed))
    }
}

#[tauri::command]
fn set_config(patch: serde_json::Value, app: AppHandle, state: State<Arc<AppState>>) -> Result<AppConfig, String> {
    let (snapshot, hotkeys_changed, tray_changed) = state.set_config_core(&patch)?;
    if hotkeys_changed {
        apply_hotkeys(&app, &state, &snapshot)?;
    }
    if tray_changed {
        apply_tray(&app, snapshot.run_in_bg);
    }
    Ok(snapshot)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn apply_hotkeys(app: &AppHandle, _state: &State<Arc<AppState>>, cfg: &AppConfig) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let _ = app.global_shortcut().unregister_all();
    for (key, win) in [(&cfg.quickbar_hotkey, "quickbar"), (&cfg.main_hotkey, "main")] {
        let shortcut: tauri_plugin_global_shortcut::Shortcut =
            key.parse().map_err(|_| format!("bad hotkey: {key}"))?;
        let app_h = app.clone();
        app.global_shortcut()
            .on_shortcut(shortcut.clone(), move |_app, _s, ev| {
                if ev.state == ShortcutState::Pressed {
                    toggle_window(&app_h, win);
                }
            })
            .map_err(|e| e.to_string())?;
        app.global_shortcut().register(shortcut).map_err(|e| e.to_string())?;
    }
    Ok(())
}
/// Mobile stub: no global shortcuts on Android/iOS (--server has no
/// windows to toggle; the phone UI never calls this).
#[cfg(any(target_os = "android", target_os = "ios"))]
fn apply_hotkeys(_app: &AppHandle, _state: &State<Arc<AppState>>, _cfg: &AppConfig) -> Result<(), String> {
    Ok(())
}

// ---------------------------------------------------------------- windows

/// Kill every pi child, then exit. Otherwise quitting orphans them.
fn quit_app(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut procs) = state.procs.lock() {
            for (_, p) in procs.drain() {
                if let Ok(mut c) = p.child.lock() {
                    let _ = c.kill();
                }
            }
        }
    }
    app.exit(0);
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn tray_icon_image() -> Option<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")).ok()
}

/// Create the tray icon if missing; set visibility per background mode.
/// Desktop only: no tray/menu APIs on Android/iOS.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn apply_tray(app: &AppHandle, enabled: bool) {
    use tauri::tray::TrayIconBuilder;
    if app.tray_by_id("main-tray").is_none() {
        let menu = tauri::menu::MenuBuilder::new(app)
            .text("show", "Show Pi")
            .text("quit", "Quit")
            .build()
            .ok();
        let mut b = TrayIconBuilder::with_id("main-tray")
            .tooltip("Pi Desktop")
            .show_menu_on_left_click(false)
            .on_menu_event(|app, e| match e.id().as_ref() {
                "show" => toggle_window(app, "main"),
                "quit" => quit_app(app),
                _ => {}
            })
            .on_tray_icon_event(|tray, e| {
                use tauri::tray::TrayIconEvent;
                if let TrayIconEvent::Click { .. } = e {
                    toggle_window(tray.app_handle(), "main");
                }
            });
        if let Some(icon) = tray_icon_image() {
            b = b.icon(icon);
        }
        if let Some(menu) = menu {
            b = b.menu(&menu);
        }
        let _ = b.build(app);
    }
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_visible(enabled);
    }
}
/// Mobile stub: no tray on Android/iOS.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn apply_tray(_app: &AppHandle, _enabled: bool) {}

fn bg_enabled(app: &AppHandle) -> bool {
    app.try_state::<AppState>()
        .and_then(|s| s.config.lock().ok().map(|c| c.run_in_bg))
        .unwrap_or(true)
}

// Toggle de-dup: a held hotkey repeats (~30ms) and double-fires across
// the in-app shortcut + KDE fallback. Sub-250ms toggles are repeats,
// never intent. The quickbar frontend also hides itself instantly on
// the chord (see quickbar.ts); the stale backend toggle arriving after
// must not re-show it, so self-hides buy 400ms of immunity.
static LAST_TOGGLE_MS: AtomicU64 = AtomicU64::new(0);
static LAST_QB_SELF_HIDE_MS: AtomicU64 = AtomicU64::new(0);
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
fn toggle_window(app: &AppHandle, label: &str) {
    let now = now_ms();
    if now.wrapping_sub(LAST_TOGGLE_MS.load(Ordering::SeqCst)) < 250 {
        return;
    }
    LAST_TOGGLE_MS.store(now, Ordering::SeqCst);
    if label == "quickbar"
        && now.wrapping_sub(LAST_QB_SELF_HIDE_MS.load(Ordering::SeqCst)) < 400
    {
        return;
    }
    if let Some(w) = app.get_webview_window(label) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            if label == "quickbar" {
                let _ = app.emit("quickbar-hidden", ());
            }
        } else {
            let _ = w.show();
            let _ = w.set_focus();
            if label == "quickbar" {
                // center() is desktop-only (no windowing on mobile).
                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                let _ = w.center();
                let _ = app.emit("quickbar-shown", ());
            }
        }
    }
}

#[tauri::command]
fn toggle_quickbar(app: AppHandle) {
    toggle_window(&app, "quickbar");
}
#[tauri::command]
fn toggle_main(app: AppHandle) {
    toggle_window(&app, "main");
}
#[tauri::command]
fn show_window(app: AppHandle, label: String) {
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
#[tauri::command]
fn hide_window(app: AppHandle, label: String) {
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.hide();
    }
}
/// Chord self-hide: the quickbar frontend hides instantly on its own
/// toggle chord (the backend toggle arrives a beat later via hotkey
/// daemon round-trip). Records the moment so toggle_window can drop
/// that stale toggle instead of re-showing. Plain hide_window (Esc,
/// buttons) grants no immunity — a fast manual reopen must always win.
#[tauri::command]
fn qb_hide_self(app: AppHandle) {
    LAST_QB_SELF_HIDE_MS.store(now_ms(), Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("quickbar") {
        let _ = w.hide();
    }
}

/// Bring up the full sessions window for a cwd (used by quickbar's "Open").
#[tauri::command]
fn open_in_main(app: AppHandle, cwd: String, session_path: Option<String>, state: State<Arc<AppState>>) -> Result<(), String> {
    let key = session_path.clone().unwrap_or_else(|| cwd.clone());
    state.pi_ensure_core(cwd.clone(), None, None, key, session_path.clone())?;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit(
            "open-request",
            serde_json::json!({ "cwd": cwd, "sessionPath": session_path }),
        );
    }
    Ok(())
}

/// Native file picker (desktop only): real paths, no copying. Browser
/// mode keeps the file-input + save_upload flow (see attachbtn).
/// Mobile stub below: blocking_pick_* doesn't exist on Android/iOS.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn pick_files(app: AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title("Choose files to attach")
        .blocking_pick_files();
    Ok(picked
        .map(|v| v.into_iter().map(|p| p.to_string()).collect())
        .unwrap_or_default())
}
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
fn pick_files(app: AppHandle) -> Result<Vec<String>, String> {
    let _ = app;
    Err("file picker unavailable on mobile (use upload instead)".into())
}
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn pick_dir(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title("Choose working directory")
        .blocking_pick_folder();
    Ok(picked.map(|p| p.to_string()))
}
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
async fn pick_dir(app: AppHandle) -> Result<Option<String>, String> {
    let _ = app;
    Err("dir picker unavailable on mobile".into())
}

// ---------------------------------------------------------------- run

/// Kill pi children orphaned by an unclean shutdown (SIGKILL, dev-server
/// restart, crash): same-uid processes carrying our PI_DESKTOP_CHILD
/// marker whose parent is gone (ppid 1). Never touches live supervised
/// children (ppid != 1) or anyone else's processes. Without this, an
/// orphan keeps running its turn and writing the session file while a
/// fresh backend serves a stale in-memory view of the same session —
/// replies land on disk but never reach the UI. Linux only; elsewhere
/// this is a no-op (orphans there are the OS's problem).
#[cfg(target_os = "linux")]
fn reap_stale_children() {
    let me = std::process::id();
    let entries = match std::fs::read_dir("/proc") {
        Ok(e) => e,
        Err(_) => return,
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let pid: u32 = match name.parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        if pid == me {
            continue;
        }
        let env = match std::fs::read(format!("/proc/{pid}/environ")) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let marked = env.split(|b| *b == 0).any(|kv| kv == b"PI_DESKTOP_CHILD=1");
        if !marked {
            continue;
        }
        let ppid: u32 = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|s| {
                s.rfind(')').and_then(|i| {
                    s[i + 2..].split_whitespace().nth(1)?.parse().ok()
                })
            })
            .unwrap_or(0);
        if ppid == 1 {
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn reap_stale_children() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Shared core (config, procs, broadcast) also used by `--server`.
    let backend = AppState::new_shared();

    // Release desktop only: serve the UI over http://localhost (random
    // free port) instead of tauri://, so embedded players that require a
    // valid HTTP Referer (YouTube: Error 153) work. Dev already runs on
    // http via Vite; mobile never navigates off its bundled scheme.
    // The port travels into setup() for the window navigation below;
    // IPC keeps working through the remote-url allowlist in
    // capabilities/default.json.
    #[cfg(all(not(debug_assertions), not(any(target_os = "android", target_os = "ios"))))]
    let localhost_port: u16 = portpicker::pick_unused_port().unwrap_or(14200);

    // Desktop-only plugins (not dependencies on android/ios — see
    // Cargo.toml target cfg). Rebind pattern: #[cfg] can't gate a link
    // inside a builder chain, so gate the rebinding instead.
    let builder = tauri::Builder::default();
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // KDE-fallback shortcut path: `pi-quickbar --toggle-quickbar`.
            if argv.iter().any(|a| a == "--toggle-quickbar") {
                toggle_window(&app, "quickbar");
            } else if argv.iter().any(|a| a == "--toggle-main" || a == "--toggle-sessions") {
                toggle_window(&app, "main");
            } else if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    #[cfg(all(not(debug_assertions), not(any(target_os = "android", target_os = "ios"))))]
    let builder = builder.plugin(tauri_plugin_localhost::Builder::new(localhost_port).build());
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sys_insets::init())
        .manage(backend)
        .setup(move |app| {
            // Local UI over http://localhost (see run()): point the config
            // windows at the plugin server before first paint. Same files
            // (index.html, quickbar.html), just an http origin with a real
            // Referer instead of tauri://.
            #[cfg(all(not(debug_assertions), not(any(target_os = "android", target_os = "ios"))))]
            {
                let base = format!("http://localhost:{localhost_port}");
                // Exact-origin capability (no wildcard semantics to fight):
                // mirrors capabilities/default.json permissions for the
                // remote origin so __TAURI__ IPC keeps working there.
                let mut cap = tauri::ipc::CapabilityBuilder::new("localhost")
                    .remote(base.clone())
                    .windows(["main", "quickbar"]);
                for perm in [
                    "core:default",
                    "core:window:allow-show",
                    "core:window:allow-hide",
                    "core:window:allow-set-focus",
                    "core:window:allow-center",
                    "core:window:allow-set-size",
                    "core:event:default",
                    "opener:default",
                    "dialog:default",
                    // App commands (autogenerated allow-<command> in
                    // build.rs): without these, remote origins can never
                    // match an app command, no matter the URL pattern.
                    "allow-delete-session",
                    "allow-direct-fetch",
                    "allow-get-config",
                    "allow-hide-window",
                    "allow-list-session-jobs",
                    "allow-list-sessions",
                    "allow-media-stat",
                    "allow-open-in-main",
                    "allow-pi-ensure",
                    "allow-pi-send",
                    "allow-pi-states",
                    "allow-pi-stop",
                    "allow-pick-dir",
                    "allow-pick-files",
                    "allow-qb-hide-self",
                    "allow-read-job-log",
                    "allow-read-job-transcript",
                    "allow-read-media",
                    "allow-read-office-text",
                    "allow-read-session-messages",
                    "allow-read-sheet",
                    "allow-rename-session",
                    "allow-save-upload",
                    "allow-set-config",
                    "allow-show-window",
                    "allow-shutdown-server",
                    "allow-toggle-main",
                    "allow-toggle-quickbar",
                ] {
                    cap = cap.permission(perm);
                }
                app.add_capability(cap)?;
                for (label, page) in [("main", "index.html"), ("quickbar", "quickbar.html")] {
                    if let Some(w) = app.get_webview_window(label) {
                        if let Ok(url) = format!("{base}/{page}").parse() {
                            let _ = w.navigate(url);
                        }
                    }
                }
            }
            // Bridge: forwarded pi records fan out over the broadcast;
            // re-emit them as pi-record IPC for the frontend.
            let st = app.state::<Arc<AppState>>();
            let bridge_rx = st.inner().clone();
            let ah = app.handle().clone();
            std::thread::spawn(move || {
                let mut rx = bridge_rx.events.subscribe();
                while let Ok(payload) = rx.blocking_recv() {
                    let _ = ah.emit("pi-record", payload);
                }
            });
            let cfg = st.get_config_core();
            // First-launch flags (also used by the KDE custom shortcut).
            let args: Vec<String> = std::env::args().collect();
            if args.iter().any(|a| a == "--toggle-quickbar" || a == "--show-quickbar") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
                if let Some(w) = app.get_webview_window("quickbar") {
                    let _ = w.show();
                    let _ = w.set_focus();
                    #[cfg(not(any(target_os = "android", target_os = "ios")))]
                    let _ = w.center();
                }
            }
            if let Err(e) = apply_hotkeys(&app.handle(), &st, &cfg) {
                eprintln!("hotkey registration failed: {e} (edit in Settings; KDE shortcut still works)");
            }
            apply_tray(&app.handle(), cfg.run_in_bg);
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            serve_http_for_phone();
            Ok(())
        })
        .on_window_event(|win, ev| {
            // Closing the sessions window quits outright, unless background
            // mode is on — then it hides to the tray instead.
            if win.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = ev {
                    if bg_enabled(win.app_handle()) {
                        api.prevent_close();
                        let _ = win.hide();
                    } else {
                        quit_app(win.app_handle());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            pi_ensure,
            pi_send,
            pi_stop,
            pi_states,
            list_sessions,
            delete_session,
            rename_session,
            read_media,
            media_stat,
            read_session_messages,
            read_job_transcript,
            read_job_log,
            list_session_jobs,
            save_upload,
            read_sheet,
            read_office_text,
            get_config,
            set_config,
            toggle_quickbar,
            toggle_main,
            show_window,
            hide_window,
            qb_hide_self,
            open_in_main,
            pick_dir,
            pick_files,
            shutdown_server,
            direct_fetch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
