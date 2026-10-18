// pi-quickbar backend: thin Tauri shell over `pi --mode rpc`.
// First principles: pi owns agent/sessions/skills/models. This app only
// spawns one pi RPC child per working dir, forwards JSONL, lists session
// files, and toggles windows via hotkeys.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use base64::Engine as _;

use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

// Media primer: what the desktop chat can render (mirrors src/md.ts —
// keep the extension lists and syntax forms in sync). Embedded at
// compile time so installed builds carry it with no repo present, and
// appended to every pi child's system prompt: capability and agent
// knowledge ship as one unit, no separate skill install, no trigger
// gambling. web-backend.mjs reads the same file for browser dev.
const MEDIA_PRIMER: &str = include_str!("../../src/media-primer.md");

// Subagents (pi-spawn package — see the pi-spawn repo, SPAWN.md there): one
// primitive, sessions all the way down. The extension is a single
// dependency-free TS file, so the installer vendors it as a resource and
// every pi child loads it via --extension: desktop users get subagents with
// no `pi install` step. Resolved at runtime so dev (sibling repo present)
// and installed builds (resource bundle, env override) all work; missing
// file means the flag is skipped and pi runs without spawn (graceful).
// Shadow-browser is NOT injected here: it carries heavy native deps
// (camoufox) and loads from the user's own pi packages instead.
fn spawn_ext_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("PI_DESKTOP_SPAWN_EXT") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    // Installed bundle: Tauri `bundle.resources` places it here.
    if let Ok(rd) = app.path().resource_dir() {
        let bundled = rd.join("pi-spawn").join("index.ts");
        if bundled.is_file() {
            return Some(bundled);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Dev layout: src-tauri/target/<profile>/pi-desktop → sibling
            // pi-spawn repo, or file: dep under the desktop node_modules.
            for rel in [
                "../../../../pi-spawn/index.ts",
                "../../../node_modules/pi-spawn/index.ts",
            ] {
                let dev = dir.join(rel);
                if dev.is_file() {
                    return Some(dev);
                }
            }
            // Installed layout: <dir>/pi-spawn/index.ts next to the binary.
            let next = dir.join("pi-spawn").join("index.ts");
            if next.is_file() {
                return Some(next);
            }
        }
    }
    None
}

// ---------------------------------------------------------------- config

fn bg_default() -> bool {
    true
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

#[tauri::command]
fn pi_ensure(cwd: String, session_dir: Option<String>, tag: Option<String>, key: String, session_path: Option<String>, app: AppHandle, state: State<AppState>) -> Result<String, String> {
    let pkey = proc_key(&tag, &key);
    {
        let procs = state.procs.lock().map_err(|e| e.to_string())?;
        if let Some(p) = procs.get(&pkey) {
            if proc_alive(p) {
                return Ok("running".into());
            }
        }
    }
    // Reap dead proc if present.
    {
        let mut procs = state.procs.lock().map_err(|e| e.to_string())?;
        procs.remove(&pkey);
    }

    // Make sure the dir exists (default Q&A dir may not yet).
    let _ = fs::create_dir_all(&cwd);

    let mut cmd = Command::new(pi_bin());
    // Marker for boot-time orphan reaping (see reap_stale_children):
    // survives in /proc/<pid>/environ, invisible everywhere else.
    cmd.env("PI_DESKTOP_CHILD", "1");
    cmd.arg("--mode")
        .arg("rpc")
        .arg("--append-system-prompt")
        .arg(MEDIA_PRIMER)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // App-owned subagents ride along with every child; absence is fine.
    if let Some(ext) = spawn_ext_path(&app) {
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
    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn pi: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    // Forward every stdout JSONL record tagged with its session key, so
    // each window renders only its currently viewed session.
    let app2 = app.clone();
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
            // Track run lifecycle for cross-session status (sidebar dots).
            // try_state per event is fine: two events per run, no hot path.
            if let Some(t) = record.get("type").and_then(|v| v.as_str()) {
                if t == "agent_start" || t == "agent_settled" {
                    let rk = format!("{}\n{}", tag2, key2);
                    if let Some(st) = app2.try_state::<AppState>() {
                        if let Ok(mut rs) = st.run_states.lock() {
                            rs.insert(rk, t == "agent_start");
                        }
                    }
                }
            }
            let _ = app2.emit(
                "pi-record",
                serde_json::json!({ "cwd": cwd2, "tag": tag2, "key": key2, "record": record }),
            );
        }
    });

    let mut procs = state.procs.lock().map_err(|e| e.to_string())?;
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
    if let Ok(mut rs) = state.run_states.lock() {
        rs.remove(&pkey);
    }
    // Remember as last used. Quickbar dirs stay out of the shared recents:
    // its throwaway Q&A dirs would drown the real project list.
    if tag.as_deref() != Some("quickbar") {
        let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.last_cwd = cwd.clone();
        cfg.recents = push_recent(cfg.recents.clone(), &cwd);
        let snapshot = cfg.clone();
        save_config(&snapshot);
    }
    Ok("started".into())
}

fn push_recent(mut recents: Vec<String>, cwd: &str) -> Vec<String> {
    recents.retain(|d| d != cwd);
    recents.insert(0, cwd.to_string());
    recents.truncate(12);
    recents
}

/// Write one JSON command line to the pi child for `cwd`.
#[tauri::command]
fn pi_send(_cwd: String, payload: serde_json::Value, tag: Option<String>, key: String, state: State<AppState>) -> Result<(), String> {
    let procs = state.procs.lock().map_err(|e| e.to_string())?;
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

#[tauri::command]
fn pi_stop(_cwd: String, tag: Option<String>, key: String, state: State<AppState>) -> Result<(), String> {
    let pkey = proc_key(&tag, &key);
    {
        let mut procs = state.procs.lock().map_err(|e| e.to_string())?;
        if let Some(p) = procs.remove(&pkey) {
            if let Ok(mut c) = p.child.lock() {
                let _ = c.kill();
            }
        }
    }
    // A stopped run is over: drop its lifecycle mark too, or run_states
    // (and every sidebar snapshot) accumulates dead keys forever.
    if let Ok(mut rs) = state.run_states.lock() {
        rs.remove(&pkey);
    }
    Ok(())
}

// ---------------------------------------------------------------- sessions

#[derive(Debug, Clone, serde::Serialize)]
struct SessionInfo {
    path: String,
    id: String,
    timestamp: String,
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
            out.push(SessionInfo {
                path: p.to_string_lossy().into_owned(),
                id,
                timestamp,
                cwd,
                name,
                preview,
            });
        }
    }
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(out)
}

/// Read a media file for inline display. Returns `{"mime", "base64"}`.
/// Relative paths resolve against `base` (the viewed session's cwd).
/// Absolute paths are used as-is. Cap 12MB: screenshots are KBs; anything
/// bigger stays a click-to-open card handled frontend-side.
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
    if meta.len() > 12 * 1024 * 1024 {
        return Err("media file too large for inline display (>12MB)".into());
    }
    let bytes = fs::read(&p).map_err(|e| format!("unreadable media file: {e}"))?;
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let mime = match ext.as_str() {
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
        _ => return Err(format!("unsupported media type: .{ext}")),
    };
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

/// Windowed transcript of ANY session file, parsed straight from disk.
/// Same message shape as get_messages. This is what history rebuilds read:
/// the file is the truth every writer shares, so a stale, dead, or busy
/// pi process can never hide a reply from the view again. Torn trailing
/// lines (concurrent writers) are skipped, never fatal. Bounded.
///
/// Windowing: sessions grow without bound and the view must never parse +
/// transfer + render the whole thing in one shot. `limit` caps the window
/// (default 60, max 500), `offset` skips that many NEWEST messages (page
/// back with offset = already-loaded count). Returns
/// `{messages, total, has_more}` so the UI can offer "show earlier".
#[tauri::command]
fn read_session_messages(path: String, session_root: Option<String>, limit: Option<usize>, offset: Option<usize>) -> Result<serde_json::Value, String> {
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
    // Single pass: collect message payloads oldest-first. The file read +
    // parse stays server-side (fast even at multi-MB); only the requested
    // window crosses IPC and reaches the renderer.
    let mut messages: Vec<serde_json::Value> = vec![];
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
                messages.push(m);
            }
        }
    }
    let total = messages.len();
    let off = offset.unwrap_or(0).min(total);
    let lim = limit.unwrap_or(60).clamp(1, 500);
    // Newest-first paging: window ends `off` before the newest message.
    let end = total - off;
    let start = end.saturating_sub(lim);
    let window = messages[start..end].to_vec();
    let has_more = start > 0;
    Ok(serde_json::json!({ "messages": window, "total": total, "has_more": has_more }))
}

/// Run-lifecycle snapshot for sidebar status dots: {bootId, runs:
/// Process liveness probe (kill(pid, 0): no signal sent). Lets the UI
/// reconcile subagent rows orphaned by a crash/reboot: no completion
/// event can ever arrive for those, so their history would otherwise
/// read "running" forever. EPERM still means alive (exists, foreign uid).
#[tauri::command]
fn pids_alive(pids: Vec<i32>) -> Vec<bool> {
    pids.iter()
        .map(|pid| {
            if *pid <= 0 {
                return false;
            }
            unsafe {
                if libc::kill(*pid, 0) == 0 {
                    true
                } else {
                    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
                }
            }
        })
        .collect()
}

/// [{tag, key, streaming}]}. Read from the tracked map (no pi traffic).
/// Unknown sessions are simply absent (= idle).
#[tauri::command]
fn pi_states(state: State<AppState>) -> serde_json::Value {
    let runs = match state.run_states.lock() {
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
    serde_json::json!({ "bootId": state.boot_id, "runs": runs })
}

/// Transcript of one spawned subagent (see agent/SPAWN.md). Scoped to the
/// spawn-sessions root: run ids are `[A-Za-z0-9_-]+`, no path traversal,
/// one session file per run dir. Returns `{messages}` in get_messages
/// shape so the frontend renders it with the same renderer. Bounded.
#[tauri::command]
fn read_spawn_transcript(run_id: String) -> Result<serde_json::Value, String> {
    if run_id.is_empty()
        || run_id.len() > 128
        || !run_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid run id".into());
    }
    let home = dirs::home_dir().ok_or("no home dir")?;
    let dir = home.join(".pi").join("agent").join("spawn-sessions").join(&run_id);
    let mut session_file: Option<PathBuf> = None;
    let entries = fs::read_dir(&dir).map_err(|e| format!("unreadable spawn dir: {e}"))?;
    for e in entries {
        let e = e.map_err(|e| e.to_string())?;
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
            if session_file.is_some() {
                return Err("ambiguous spawn dir (multiple sessions)".into());
            }
            session_file = Some(p);
        }
    }
    let file = session_file.ok_or("no session file for run")?;
    let meta = fs::metadata(&file).map_err(|e| format!("unreadable session file: {e}"))?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err("spawn transcript too large (>2MB)".into());
    }
    let text = fs::read_to_string(&file).map_err(|e| format!("unreadable session file: {e}"))?;
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

/// Delete one spawned subagent's run dir (see agent/SPAWN.md). Scoped to
/// the spawn-sessions root: run ids are `[A-Za-z0-9_-]+`, resolved path
/// must stay inside the root. Removes transcript files outright.
#[tauri::command]
fn delete_spawn_run(run_id: String) -> Result<(), String> {
    if run_id.is_empty()
        || run_id.len() > 128
        || !run_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid run id".into());
    }
    let home = dirs::home_dir().ok_or("no home dir")?;
    let root = home.join(".pi").join("agent").join("spawn-sessions");
    let dir = root.join(&run_id);
    // Containment: canonicalize the parent (root always exists when a
    // run does) and require the target to be exactly one entry inside.
    if !dir.is_dir() {
        return Ok(()); // already gone: idempotent
    }
    let canonical_root = fs::canonicalize(&root).map_err(|e| format!("unreadable spawn root: {e}"))?;
    let canonical = fs::canonicalize(&dir).map_err(|e| format!("unreadable spawn dir: {e}"))?;
    if canonical.parent() != Some(canonical_root.as_path()) {
        return Err("refusing to delete outside spawn root".into());
    }
    fs::remove_dir_all(&canonical).map_err(|e| format!("delete failed: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------- config

#[tauri::command]
fn get_config(state: State<AppState>) -> AppConfig {
    state.config.lock().map(|c| c.clone()).unwrap_or_default()
}

#[tauri::command]
fn set_config(patch: serde_json::Value, app: AppHandle, state: State<AppState>) -> Result<AppConfig, String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    if let Some(v) = patch.get("default_dir").and_then(|v| v.as_str()) {
        cfg.default_dir = v.to_string();
    }
    if let Some(v) = patch.get("last_cwd").and_then(|v| v.as_str()) {
        cfg.last_cwd = v.to_string();
    }
    if let Some(arr) = patch.get("recents").and_then(|v| v.as_array()) {
        cfg.recents = arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
    }
    if let Some(v) = patch.get("run_in_bg").and_then(|v| v.as_bool()) {
        cfg.run_in_bg = v;
        let snapshot = cfg.clone();
        save_config(&snapshot);
        drop(cfg);
        apply_tray(&app, snapshot.run_in_bg);
        return Ok(snapshot);
    }
    if patch.get("quickbar_hotkey").or(patch.get("main_hotkey")).is_some() {
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
        // Validate BEFORE unregister_all: a typo must not wipe working keys.
        let _: tauri_plugin_global_shortcut::Shortcut =
            q.parse().map_err(|_| format!("bad hotkey: {q}"))?;
        let _: tauri_plugin_global_shortcut::Shortcut =
            m.parse().map_err(|_| format!("bad hotkey: {m}"))?;
        cfg.quickbar_hotkey = q;
        cfg.main_hotkey = m;
        let snapshot = cfg.clone();
        drop(cfg);
        apply_hotkeys(&app, &state, &snapshot)?;
        let cfg2 = state.config.lock().map_err(|e| e.to_string())?;
        let snapshot2 = cfg2.clone();
        save_config(&snapshot2);
        return Ok(snapshot2);
    }
    let snapshot = cfg.clone();
    save_config(&snapshot);
    Ok(snapshot)
}

fn apply_hotkeys(app: &AppHandle, _state: &State<AppState>, cfg: &AppConfig) -> Result<(), String> {
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

fn tray_icon_image() -> Option<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")).ok()
}

/// Create the tray icon if missing; set visibility per background mode.
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

fn bg_enabled(app: &AppHandle) -> bool {
    app.try_state::<AppState>()
        .and_then(|s| s.config.lock().ok().map(|c| c.run_in_bg))
        .unwrap_or(true)
}

fn toggle_window(app: &AppHandle, label: &str) {
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

/// Bring up the full sessions window for a cwd (used by quickbar's "Open").
#[tauri::command]
fn open_in_main(app: AppHandle, cwd: String, session_path: Option<String>, state: State<AppState>) -> Result<(), String> {
    let key = session_path.clone().unwrap_or_else(|| cwd.clone());
    pi_ensure(cwd.clone(), None, None, key, session_path.clone(), app.clone(), state)?;
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
    // Unclean shutdowns (SIGKILL, dev restarts) orphan pi children that
    // keep running + writing while a fresh backend serves stale views.
    // Reap them before anything else. Our own live children (if any)
    // are never reaped: only ppid-1 processes carry the marker check.
    reap_stale_children();
    let cfg = load_config();
    // Ensure default Q&A dir exists so first run just works.
    let _ = fs::create_dir_all(&cfg.default_dir);
    if cfg.last_cwd.is_empty() {
        let mut c = cfg.clone();
        c.last_cwd = c.default_dir.clone();
        save_config(&c);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // KDE-fallback shortcut path: `pi-quickbar --toggle-quickbar`.
            if argv.iter().any(|a| a == "--toggle-quickbar") {
                toggle_window(&app, "quickbar");
            } else if argv.iter().any(|a| a == "--toggle-main" || a == "--toggle-sessions") {
                toggle_window(&app, "main");
            } else if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
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
        })
        .setup(move |app| {
            // First-launch flags (also used by the KDE custom shortcut).
            let args: Vec<String> = std::env::args().collect();
            if args.iter().any(|a| a == "--toggle-quickbar" || a == "--show-quickbar") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
                if let Some(w) = app.get_webview_window("quickbar") {
                    let _ = w.show();
                    let _ = w.set_focus();
                    let _ = w.center();
                }
            }
            if let Err(e) = apply_hotkeys(&app.handle(), &app.state::<AppState>(), &cfg) {
                eprintln!("hotkey registration failed: {e} (edit in Settings; KDE shortcut still works)");
            }
            apply_tray(&app.handle(), cfg.run_in_bg);
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
            pids_alive,
            list_sessions,
            delete_session,
            read_media,
            media_stat,
            read_session_messages,
            read_spawn_transcript,
            delete_spawn_run,
            get_config,
            set_config,
            toggle_quickbar,
            toggle_main,
            show_window,
            hide_window,
            open_in_main,
            pick_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
