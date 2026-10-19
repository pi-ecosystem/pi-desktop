// Shared pi RPC client. KISS: one `pi-record` listener, id-correlated calls,
// per-cwd streaming subscribers. No state duplicated from pi.

import { invoke } from "./tauri-shim";
import { listen } from "./tauri-shim";

// Namespace: main window and quickbar must NEVER share a pi child, even
// for the same cwd. Otherwise one's newSession yanks the other's session
// mid-run and prompt routing becomes mystery soup. The backend keys
// children by (tag, cwd) and tags every event; this module filters by tag.
let NS = "main";
export function setTag(t: string): void {
  NS = t;
}

// Currently viewed session key. Backend children are keyed (tag, key), so
// each session runs in its own pi process and view switches are purely
// visual — agent state is never touched by navigating the UI.
let curKey = "";
export function setKey(k: string): void {
  curKey = k;
}
export function getKey(): string {
  return curKey;
}

let seq = 0;
const pending = new Map<string, { res: (v: any) => void; rej: (e: any) => void }>();
const subs = new Map<string, Set<(rec: any) => void>>();
let listening = false;

function subKey(cwd: string): string {
  return `${NS}\n${cwd}`;
}

export async function ensureListening(): Promise<void> {
  if (listening) return;
  listening = true;
  await listen("pi-record", (e: any) => {
    const p = e.payload ?? {};
    const { cwd, tag, key, record } = p;
    if (tag !== NS) return;
    // Run-lifecycle events for NON-viewed sessions bypass the transcript
    // filter into the status channel: that's how the sidebar tracks
    // background runs (key carries the session path for saved sessions).
    if (
      key !== undefined &&
      key !== curKey &&
      record &&
      (record.type === "agent_start" || record.type === "agent_settled")
    ) {
      const set = statusSubs;
      if (set.size) set.forEach((fn) => fn({ tag, key, streaming: record.type === "agent_start" }));
      return;
    }
    // Render only the currently viewed session. Other sessions keep
    // running; their UI refreshes when viewed (full reload from messages).
    if (key !== undefined && key !== curKey && !(record && record.type === "response")) return;
    if (
      record &&
      record.type === "response" &&
      typeof record.id === "string" &&
      pending.has(record.id)
    ) {
      const h = pending.get(record.id)!;
      pending.delete(record.id);
      if (record.success) h.res(record.data);
      else h.rej(new Error(record.error ?? "pi error"));
      return;
    }
    const set = subs.get(subKey(cwd));
    if (set) set.forEach((fn) => fn(record));
  });
}

export function onRunStatus(fn: (s: { tag: string; key: string; streaming: boolean }) => void): () => void {
  statusSubs.add(fn);
  return () => {
    statusSubs.delete(fn);
  };
}

const statusSubs = new Set<(s: { tag: string; key: string; streaming: boolean }) => void>();

export function onRecord(cwd: string, fn: (rec: any) => void): () => void {
  const k = subKey(cwd);
  let set = subs.get(k);
  if (!set) {
    set = new Set();
    subs.set(k, set);
  }
  set.add(fn);
  return () => set!.delete(fn);
}

async function call(cwd: string, obj: any, timeoutMs = 120_000, key?: string): Promise<any> {
  await ensureListening();
  const id = `q${++seq}`;
  obj.id = id;
  return new Promise((res, rej) => {
    // Clear the deadline on settle: otherwise every RPC (including
    // high-frequency state polls) leaves a dead 120s timer behind.
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rej(new Error("pi timeout"));
      }
    }, timeoutMs);
    pending.set(id, {
      res: (v: any) => {
        clearTimeout(timer);
        res(v);
      },
      rej: (e: any) => {
        clearTimeout(timer);
        rej(e);
      },
    });
    // Explicit key when given (background send to a non-viewed session);
    // otherwise the viewed session. Never mutate curKey for a send.
    invoke("pi_send", { cwd, payload: obj, tag: NS, key: key ?? curKey }).catch((err) => {
      pending.delete(id);
      clearTimeout(timer);
      rej(err);
    });
  });
}

export async function ensure(cwd: string, key?: string, sessionPath?: string | null): Promise<void> {
  await invoke("pi_ensure", {
    cwd,
    sessionDir: null,
    tag: NS,
    key: key ?? curKey,
    sessionPath: sessionPath ?? null,
  });
}

export async function stopChild(cwd: string, key: string): Promise<void> {
  await invoke("pi_stop", { cwd, tag: NS, key });
}

export const pi = {
  prompt: (cwd: string, message: string, streamingBehavior?: "steer" | "followUp", key?: string) =>
    call(cwd, {
      type: "prompt",
      message,
      ...(streamingBehavior ? { streamingBehavior } : {}),
    }, 120_000, key),
  abort: (cwd: string) => call(cwd, { type: "abort" }),
  newSession: (cwd: string) => call(cwd, { type: "new_session" }),
  switchSession: (cwd: string, sessionPath: string) =>
    call(cwd, { type: "switch_session", sessionPath }),
  state: (cwd: string, key?: string) => call(cwd, { type: "get_state" }, 120_000, key),
  messages: (cwd: string) => call(cwd, { type: "get_messages" }),
  models: (cwd: string) => call(cwd, { type: "get_available_models" }),
  setModel: (cwd: string, provider: string, modelId: string) =>
    call(cwd, { type: "set_model", provider, modelId }),
  thinkingLevels: (cwd: string) => call(cwd, { type: "get_available_thinking_levels" }),
  setThinking: (cwd: string, level: string) =>
    call(cwd, { type: "set_thinking_level", level }),
  setName: (cwd: string, name: string) =>
    call(cwd, { type: "set_session_name", name }),

  forkMessages: (cwd: string) => call(cwd, { type: "get_fork_messages" }),
  fork: (cwd: string, entryId: string) => call(cwd, { type: "fork", entryId }),

  // Discoverable slash commands: extension commands, prompt templates,
  // skills. Run one via prompt("/name args"). Built-in TUI commands
  // (/settings, /model, …) are NOT included — handle those locally.
  commands: (cwd: string): Promise<{ commands: PiCommand[] }> =>
    call(cwd, { type: "get_commands" }),

  // Mid-run queue primitives (mirror of pi's own API; backend forwards).
  // steer()/followUp() enqueue server-side; clearQueue() returns the held
  // {steering[], followUp[]} so the UI can restore them to the editor.
  steerMsg: (cwd: string, message: string, key?: string) =>
    call(cwd, { type: "steer", message }, 120_000, key),
  followUpMsg: (cwd: string, message: string, key?: string) =>
    call(cwd, { type: "follow_up", message }, 120_000, key),
  clearQueue: (cwd: string): Promise<{ steering: string[]; followUp: string[] }> =>
    call(cwd, { type: "clear_queue" }),
  upload: (cwd: string, name: string, data: string): Promise<string> =>
    invoke("save_upload", { cwd, name, data }).then((r: any) => r.path as string),
};

// new_session / switch_session / fork ACK immediately but switch
// asynchronously: poll get_state until the file actually changes, else
// the next prompt (and the transcript) still belong to the old session.
export async function awaitSession(cwd: string, before: string | null, want?: string, ms = 4000): Promise<string | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const s: any = await pi.state(cwd);
      const f: string | null = s?.sessionFile ?? null;
      if (f && (want ? f === want : f !== before)) return f;
    } catch { /* pi busy/starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

export interface PiCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: any;
}

export interface SessionInfo {
  path: string;
  id: string;
  timestamp: string;
  cwd: string;
  name: string | null;
  preview: string | null;
}

export const sessions = {
  list: (cwd?: string): Promise<SessionInfo[]> =>
    invoke("list_sessions", { cwdFilter: cwd ?? null, sessionRoot: null }),
  del: (path: string): Promise<void> => invoke("delete_session", { path, sessionRoot: null }),
  // Windowed transcript parsed straight from the session file (same shape as
  // get_messages, plus total/has_more/bytes). The file is the truth every
  // writer shares: immune to stale/dead/busy pi processes. Falls back to
  // live RPC when needed. maxBytes budgets the newest-first window
  // (default 256KB — counts lie, one tool result can outweigh a thousand
  // chats), offset skips that many newest (page back with offset = loaded
  // count).
  read: (path: string, maxBytes?: number, offset?: number): Promise<{ messages: any[]; total: number; has_more: boolean; bytes: number }> =>
    invoke("read_session_messages", { path, sessionRoot: null, maxBytes: maxBytes ?? null, offset: offset ?? null }),
};

// Run-lifecycle snapshot across sessions (sidebar status dots).
// Event-maintained backend-side; unknown sessions absent (= idle).
// bootId changes across backend reboots: pre-reboot liveness dies with it.
export const runStates = {
  snapshot: (): Promise<{ bootId: string; runs: { tag: string; key: string; streaming: boolean }[] }> =>
    invoke("pi_states"),
};

// Process liveness probe for subagent rows orphaned by a crash/reboot
// (pi-spawn/SPAWN.md). Same command name as the Tauri backend. Only ever
// marks rows dead (high confidence); a live answer changes nothing, so
// pid reuse can at worst leave a row "running", never kill a live one.
export const procAlive = {
  check: (pids: number[]): Promise<boolean[]> => invoke("pids_alive", { pids }),
};

// Transcript of one spawned subagent (pi-spawn/SPAWN.md). Scoped server-side
// to the spawn-sessions root. Returns {messages} in get_messages shape.
export const spawnTranscript = {
  read: (runId: string): Promise<{ messages: any[] }> =>
    // Tauri maps JS camelCase to Rust snake_case: must be runId here.
    invoke("read_spawn_transcript", { runId }),
  remove: (runId: string): Promise<void> =>
    invoke("delete_spawn_run", { runId }),
};

// Tail of one background process's log (pi-spawn/SPAWN.md, spawn_bg).
// Scoped server-side to the spawn-sessions root. Returns the last 256KB
// starting on a line boundary: {text, size, truncated}.
export const spawnLog = {
  read: (runId: string): Promise<{ text: string; size: number; truncated: boolean }> =>
    invoke("read_spawn_log", { runId }),
};

export interface AppConfig {
  quickbar_hotkey: string;
  main_hotkey: string;
  default_dir: string;
  recents: string[];
  last_cwd: string;
  run_in_bg?: boolean;
}

export const config = {
  get: (): Promise<AppConfig> => invoke("get_config"),
  set: (patch: Partial<AppConfig>): Promise<AppConfig> => invoke("set_config", { patch }),
};
