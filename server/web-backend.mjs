// Dev-only web backend for pi-desktop browser mode (`npm run dev:web`).
// Mirrors src-tauri/src/lib.rs: same commands, same pi-proc management, same
// session scanning — so the frontend can't tell Tauri IPC from fetch/SSE.
// window-only commands (toggles, tray) are harmless no-ops here.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 1421);
const HOME = os.homedir();

// ---------------------------------------------------------------- config

function defaultConfig() {
  const qa = path.join(HOME, ".pi-qa");
  return {
    quickbar_hotkey: "Super+J",
    main_hotkey: "Super+Shift+J",
    default_dir: qa,
    recents: [],
    last_cwd: qa,
    run_in_bg: true,
  };
}

function configPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(HOME, ".config");
  return path.join(base, "pi-quickbar", "config.json");
}

function loadConfig() {
  try {
    return { ...defaultConfig(), ...JSON.parse(fs.readFileSync(configPath(), "utf8")) };
  } catch {
    return defaultConfig();
  }
}

function saveConfig(c) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    // Atomic: a crash mid-write must never leave a torn config behind.
    const tmp = configPath() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
    fs.renameSync(tmp, configPath());
  } catch {}
}

let CONFIG = loadConfig();

// ---------------------------------------------------------------- pi procs

function sessionRootDefault() {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return process.env.PI_CODING_AGENT_SESSION_DIR;
  return path.join(HOME, ".pi", "agent", "sessions");
}

function piBin() {
  if (process.env.PI_BIN) return process.env.PI_BIN;
  for (const sub of [".pi/agent/bin/pi", ".local/bin/pi"]) {
    const p = path.join(HOME, sub);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return "pi";
}

// key: `${tag}\n${key}` -> { child, alive }
const procs = new Map();
const sseClients = new Set();
// Random per backend boot: frontends drop pre-reboot liveness on change.
const BOOT_ID = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
// Run lifecycle per session key (`tag\nkey`): true while its agent runs.
// Maintained by watching forwarded records. Backs sidebar run dots.
const runStates = new Map();

function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {}
  }
}

function pushRecent(recents, cwd) {
  const out = [cwd, ...recents.filter((d) => d !== cwd)];
  return out.slice(0, 12);
}

function ensureProc({ cwd, sessionDir, tag, key, sessionPath }) {
  const pkey = `${tag || "main"}\n${key}`;
  const existing = procs.get(pkey);
  if (existing && existing.alive) return "running";
  if (existing) {
    try {
      existing.child.kill();
    } catch {}
    procs.delete(pkey);
  }
  fs.mkdirSync(cwd, { recursive: true });
  // Same media primer as the Tauri backend (see src/media-primer.md):
  // capability + agent knowledge ship together, no skill install step.
  let primer = null;
  try {
    primer = fs.readFileSync(new URL("../src/media-primer.md", import.meta.url), "utf8");
  } catch {}
  const args = ["--mode", "rpc"];
  if (primer) args.push("--append-system-prompt", primer);
  // App-owned subagents (see agent/SPAWN.md). Resolved relative to this
  // file in dev; env override for custom layouts; skipped when absent.
  let spawnExt =
    process.env.PI_DESKTOP_SPAWN_EXT ||
    new URL("../agent/spawn.ts", import.meta.url);
  try {
    if (typeof spawnExt !== "string") spawnExt = fileURLToPath(spawnExt);
    fs.statSync(spawnExt);
    args.push("--extension", spawnExt);
  } catch { /* pi runs without spawn */ }
  if (sessionDir) args.push("--session-dir", sessionDir);
  if (sessionPath) args.push("--session", sessionPath);
  // Marker for boot-time orphan reaping (see reapStaleChildren).
  const child = spawn(piBin(), args, { cwd, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, PI_DESKTOP_CHILD: "1" } });
  const entry = { child, alive: true };
  child.on("exit", () => (entry.alive = false));
  child.on("error", () => (entry.alive = false));
  // forward stdout JSONL as pi-record events
  let buf = "";
  const tagName = tag || "main";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        record = line;
      }
      if (record && (record.type === "agent_start" || record.type === "agent_settled")) {
        runStates.set(`${tagName}\n${key}`, record.type === "agent_start");
      }
      broadcast({ cwd, tag: tagName, key, record });
    }
  });
  procs.set(pkey, entry);
  // A (re)spawned proc has no live run by definition — a run cannot
  // survive its process. Drop any stale lifecycle mark (crashed pi with
  // no settled event), or the sidebar dot sticks until reboot. The alive
  // fast-path above deliberately skips this: mid-run ensures must never
  // erase a true mark.
  runStates.delete(pkey);
  if (tag !== "quickbar") {
    CONFIG.last_cwd = cwd;
    CONFIG.recents = pushRecent(CONFIG.recents, cwd);
    saveConfig(CONFIG);
  }
  return "started";
}

function sendProc({ payload, tag, key }) {
  const pkey = `${tag || "main"}\n${key}`;
  const p = procs.get(pkey);
  if (!p) throw new Error("no pi running for this session (call pi_ensure)");
  if (!p.alive) throw new Error("pi exited (call pi_ensure)");
  p.child.stdin.write(JSON.stringify(payload) + "\n");
}

function stopProc({ tag, key }) {
  const pkey = `${tag || "main"}\n${key}`;
  const p = procs.get(pkey);
  if (p) {
    try {
      p.child.kill();
    } catch {}
    procs.delete(pkey);
  }
  // A stopped run is over: drop its lifecycle mark too, or runStates
  // (and every sidebar snapshot) accumulates dead keys forever.
  runStates.delete(pkey);
}

// ---------------------------------------------------------------- sessions

function quotedAfter(obj, key) {
  const n = obj.indexOf(key);
  if (n < 0) return null;
  const seg = obj.slice(n + key.length);
  const c = seg.indexOf(":");
  if (c < 0) return null;
  let v = seg.slice(c + 1).trimStart();
  if (!v.startsWith('"')) return null;
  v = v.slice(1);
  let s = "";
  for (let i = 0; i < v.length && s.length <= 160; i++) {
    const ch = v[i];
    if (ch === "\\" && i + 1 < v.length) {
      s += v[++i];
    } else if (ch === '"') {
      break;
    } else {
      s += ch;
    }
  }
  s = s.trim();
  return s || null;
}

function scanName(blob) {
  let name = null;
  let rest = blob;
  for (;;) {
    const i = rest.indexOf('"type":"session_info"');
    if (i < 0) break;
    const seg = rest.slice(i, i + 600);
    const n = quotedAfter(seg, '"name"');
    if (n) name = n;
    rest = rest.slice(i + 1);
  }
  return name;
}

function scanPreview(blob) {
  let rest = blob;
  for (;;) {
    const i = rest.indexOf('"role":"user"');
    if (i < 0) break;
    const seg = rest.slice(i, i + 2000);
    const t = quotedAfter(seg, '"text"');
    if (t && !t.startsWith("Ran `")) return t;
    rest = rest.slice(i + 1);
  }
  return null;
}

// Bounded windows of a session file for the sidebar: header line,
// preview window (first 256KB), name window (last 16KB). Null = unreadable.
function readSessionWindows(p) {
  let fd;
  try {
    fd = fs.openSync(p, "r");
  } catch {
    return null;
  }
  try {
    const len = fs.fstatSync(fd).size;
    const headLen = Math.min(len, 262144);
    const headBuf = Buffer.alloc(headLen);
    let n = 0;
    while (n < headBuf.length) {
      const r = fs.readSync(fd, headBuf, n, headBuf.length - n, n);
      if (r <= 0) break; // concurrent truncate: take what we got
      n += r;
    }
    const headStr = headBuf.slice(0, n).toString("utf8");
    const nl = headStr.indexOf("\n");
    const header = nl < 0 ? headStr.slice(0, 2000) : headStr.slice(0, nl);
    const tailLen = Math.min(len, 16384);
    const tailBuf = Buffer.alloc(tailLen);
    let m = 0;
    while (m < tailBuf.length) {
      const r = fs.readSync(fd, tailBuf, m, tailBuf.length - m, len - tailLen + m);
      if (r <= 0) break;
      m += r;
    }
    return { header, previewWin: headStr, tail: tailBuf.slice(0, m).toString("utf8") };
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

function listSessions(cwdFilter, sessionRoot) {
  const root = sessionRoot || sessionRootDefault();
  const out = [];
  let groups;
  try {
    groups = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    throw new Error(`session dir unreadable (${root}): ${e.message}`);
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const gp = path.join(root, g.name);
    let files;
    try {
      files = fs.readdirSync(gp);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(gp, f);
      // Bounded windows (see readSessionWindows): a sidebar row must
      // never load a whole multi-MB transcript.
      const win = readSessionWindows(p);
      if (!win) continue;
      let head;
      try {
        head = JSON.parse(win.header);
      } catch {
        continue;
      }
      const cwd = head.cwd || "";
      if (cwdFilter && cwd !== cwdFilter) continue;
      const entry = {
        path: p,
        id: head.id || "",
        timestamp: head.timestamp || "",
        cwd,
        name: scanName(win.tail),
        preview: scanPreview(win.previewWin),
      };
      out.push(entry);
    }
  }
  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return out;
}

// ---------------------------------------------------------------- commands

const MEDIA_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm",
  mov: "video/quicktime", ogv: "video/ogg",
};

function resolveMediaPath(mediaPath, base) {
  let p = mediaPath;
  if (p.startsWith("~/")) p = path.join(HOME, p.slice(2));
  else if (p.startsWith("file://")) p = decodeURI(p.replace(/^file:\/\//, ""));
  else if (!path.isAbsolute(p)) {
    if (!base) throw new Error("relative media path with no base dir");
    p = path.join(base, p);
  }
  return p;
}
function mediaStatJson(st) {
  return { mtimeMs: Math.floor(st.mtimeMs), size: st.size };
}
function readMedia(mediaPath, base) {
  const p = resolveMediaPath(mediaPath, base);
  const st = fs.statSync(p);
  if (st.size > 12 * 1024 * 1024) throw new Error("media file too large for inline display (>12MB)");
  const ext = (path.extname(p).slice(1) || "").toLowerCase();
  const mime = MEDIA_MIME[ext];
  if (!mime) throw new Error(`unsupported media type: .${ext}`);
  // Stat rides along so the frontend can revalidate its cache without
  // re-transferring bytes (see media_stat).
  return { mime, base64: fs.readFileSync(p).toString("base64"), ...mediaStatJson(st) };
}

const handlers = {
  read_media: (p) => readMedia(p.path, p.base ?? null),
  // Cheap stat for the frontend's media cache (see readMedia).
  media_stat: (p) => mediaStatJson(fs.statSync(resolveMediaPath(p.path, p.base ?? null))),
  pi_ensure: (p) => ensureProc(p),
  pi_send: (p) => (sendProc(p), null),
  pi_stop: (p) => (stopProc(p), null),
  pi_states: () => {
    const runs = [...runStates.entries()].map(([k, streaming]) => {
      const i = k.indexOf("\n");
      return { tag: i < 0 ? k : k.slice(0, i), key: i < 0 ? "" : k.slice(i + 1), streaming };
    });
    return { bootId: BOOT_ID, runs };
  },
  // Process liveness probe for orphaned subagent rows (see pids_alive
  // in the Tauri backend). EPERM means alive (exists, foreign uid).
  pids_alive: (p) => (Array.isArray(p.pids) ? p.pids : []).map((pid) => {
    if (typeof pid !== "number" || !(pid > 0)) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e && e.code) === "EPERM";
    }
  }),
  list_sessions: (p) => listSessions(p.cwdFilter ?? null, p.sessionRoot ?? null),
  delete_session: (p) => {
    const root = p.sessionRoot || sessionRootDefault();
    // Canonicalize like the Tauri backend: lexical startsWith is fooled
    // by symlinks pointing outside the session root.
    const canonicalRoot = fs.realpathSync(root);
    const canonical = fs.realpathSync(path.resolve(p.path));
    if (!canonical.startsWith(canonicalRoot)) throw new Error("refusing to delete outside session dir");
    fs.unlinkSync(canonical);
    return null;
  },
  read_session_messages: (p) => {
    const root = p.sessionRoot || sessionRootDefault();
    const resolved = path.resolve(p.path);
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(realRoot)) throw new Error("refusing to read outside session dir");
    const st = fs.statSync(real);
    if (st.size > 8 * 1024 * 1024) throw new Error("session file too large (>8MB)");
    const messages = [];
    for (const line of fs.readFileSync(real, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let v;
      try {
        v = JSON.parse(t);
      } catch {
        continue; // torn line from a concurrent writer: skip
      }
      // Ring: keep the NEWEST 2000 (see the Rust backend). Breaking at
      // the cap would pin the oldest and drop the recent end.
      if (v.type === "message" && v.message) {
        messages.push(v.message);
        if (messages.length === 4000) messages.splice(0, 2000);
      }
    }
    return { messages: messages.length > 2000 ? messages.slice(-2000) : messages };
  },
  read_spawn_transcript: (p) => {
    const runId = p.run_id ?? p.runId ?? "";
    if (!runId || runId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("invalid run id");
    const dir = path.join(HOME, ".pi", "agent", "spawn-sessions", runId);
    let file = null;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      if (file) throw new Error("ambiguous spawn dir (multiple sessions)");
      file = path.join(dir, f);
    }
    if (!file) throw new Error("no session file for run");
    const st = fs.statSync(file);
    if (st.size > 2 * 1024 * 1024) throw new Error("spawn transcript too large (>2MB)");
    const messages = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let v;
      try {
        v = JSON.parse(t);
      } catch {
        continue; // torn line from a concurrent writer: skip
      }
      // Ring: keep the NEWEST 2000 (see the Rust backend). Breaking at
      // the cap would pin the oldest and drop the recent end.
      if (v.type === "message" && v.message) {
        messages.push(v.message);
        if (messages.length === 4000) messages.splice(0, 2000);
      }
    }
    return { messages: messages.length > 2000 ? messages.slice(-2000) : messages };
  },
  delete_spawn_run: (p) => {
    const runId = p.runId ?? "";
    if (!runId || runId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("invalid run id");
    const root = path.join(HOME, ".pi", "agent", "spawn-sessions");
    const dir = path.resolve(root, runId);
    if (path.dirname(dir) !== path.resolve(root)) throw new Error("refusing to delete outside spawn root");
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  },
  get_config: () => CONFIG,
  set_config: (p) => {
    const patch = p.patch || {};
    for (const k of ["default_dir", "last_cwd", "recents", "run_in_bg", "quickbar_hotkey", "main_hotkey"]) {
      if (patch[k] !== undefined) CONFIG[k] = patch[k];
    }
    saveConfig(CONFIG);
    return CONFIG;
  },
  // window-only: no-ops in browser mode
  toggle_quickbar: () => null,
  toggle_main: () => null,
  show_window: () => null,
  hide_window: () => null,
  open_in_main: () => null,
  pick_dir: () => null,
};

function readBody(req) {
  return new Promise((res, rej) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        res(JSON.parse(s || "{}"));
      } catch (e) {
        rej(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/events" || url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  if (req.method === "POST" && (url.pathname === "/api/invoke" || url.pathname === "/invoke")) {
    try {
      const { cmd, params } = await readBody(req);
      const fn = handlers[cmd];
      if (!fn) throw new Error(`unknown command: ${cmd}`);
      const data = await fn(params || {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
    return;
  }
  res.writeHead(404);
  res.end("pi-desktop web backend. POST /api/invoke, GET /api/events");
});

// Kill pi children orphaned by an unclean shutdown (same rule as the
// Tauri backend's reap_stale_children): our marker + reparented to init.
function reapStaleChildren() {
  if (process.platform !== "linux") return;
  let dirs;
  try {
    dirs = fs.readdirSync("/proc");
  } catch {
    return;
  }
  const me = String(process.pid);
  for (const d of dirs) {
    if (!/^\d+$/.test(d) || d === me) continue;
    let env;
    try {
      env = fs.readFileSync(`/proc/${d}/environ`, "utf8");
    } catch {
      continue;
    }
    if (!env.split("\0").includes("PI_DESKTOP_CHILD=1")) continue;
    let ppid = null;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2);
      ppid = after.split(/\s+/)[1];
    } catch {
      continue;
    }
    if (ppid === "1") {
      try {
        process.kill(Number(d), "SIGKILL");
      } catch { /* already gone */ }
    }
  }
}

reapStaleChildren();

server.listen(PORT, () => console.log(`[web-backend] listening on http://localhost:${PORT}`));

process.on("SIGTERM", () => {
  for (const [, p] of procs) {
    try {
      p.child.kill();
    } catch {}
  }
  process.exit(0);
});
