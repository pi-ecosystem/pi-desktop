// Sessions window: sidebar (dir + sessions), chat, model/thinking pickers,
// settings (hotkeys). Thin view over pi RPC — pi owns everything.

import "./compat";
import { invoke } from "./tauri-shim";
import { ensureServerBackend, isServerMode, sendShutdownBeacon } from "./tauri-shim";
import { listen } from "./tauri-shim";
import { getCurrentWindow, getCurrentWebview } from "./tauri-window-shim";
import { awaitSession, config, ensure, getKey, jobLog, jobTranscript, onRecord, onRunStatus, pi, recycleEvents, runStates, sessionJobs, sessions, setKey, setTag, stopChild, type PiCommand, type SessionInfo } from "./pi";
import {
  deleteDirectChat,
  getDirectChat,
  listDirectModels,
  listDirectChats,
  loadDirectSettings,
  saveDirectSettings,
  newDirectChat,
  renameDirectChat,
  saveDirectChat,
  streamDirectChat,
} from "./direct";

// Shown in Settings so installed-vs-running is checkable. Value comes
// from package.json via vite define (single source, see vite.config.ts).
import { renderMd, setMediaBase, clearMediaCache, wireCopy } from "./md";
import {
  mountComposer,
  composerText,
  setComposerText,
  composerCursor,
  composerFocus,
} from "./composer";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

let cwd = "";
let liveRun: HTMLElement | null = null;
let liveThinkDiv: HTMLElement | null = null;
let liveThinkBuf = "";
let liveCalls = new Map<string, any>();
// Live tool rows by toolCallId: created at tool_execution_start (running),
// morphed at toolResult completion. Long tools show WHAT is running
// instead of bare dots. Cleared on view change; history rebuilds render
// completed rows from the file and never consult this.
const liveToolRows = new Map<string, HTMLElement>();
let streaming = false;
// True from a follow-up transmit until the agent's next output. Bridges
// the dead air between turn A settling and turn B's first token: without
// it the UI looks idle although your message is accepted and queued.
// One-shot (consumed by finishRun); cleared by any agent output, by
// abort, and by a 90s safety timer. Cosmetic only, never drives runs.
let awaitingResponse = false;
let streamBuf = "";
let streamDiv: HTMLElement | null = null;
// True once the current message completed: late deltas are dropped
// instead of opening a duplicate bubble. Reopened by the next
// turn_start / message_start / agent_start.
let streamClosed = false;
// Partial stream text per session key. A rebuild (switch/revisit) wipes
// #msgs, and partial text lives nowhere in history — without this cache
// the pre-switch portion of a live answer vanishes and the stream
// appears to stall on return. Seeded back in syncRunFlag.
let lastStreamWire = 0; // throttle: full wire at most every ~1.5s mid-stream
let lastStreamRender = 0; // throttle: full re-parse at most every ~250ms mid-stream
let unsub: (() => void) | null = null;
let sessCache: SessionInfo[] = [];

// ---- ChatGPT chat dynamics ----
let stick = true; // pinned to bottom unless the user scrolls up
const ICO_STOP = `<svg width="14" height="14" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor"/></svg>`;
const ICO_SEND = `↑`;
function pin() {
  if (!stick) return;
  const m = $("scrollwrap");
  m.scrollTop = m.scrollHeight;
}
// Latch-heal: trackpad jitter or a layout kick unlatches `stick` while the
// user is still effectively at the bottom, and every later pin() no-ops.
// New agent output re-arms the pin when the viewport is NEAR the bottom
// (300px grace); readers parked deep in history keep control.
function healStick(): void {
  try {
    const m = $("scrollwrap");
    if (!m) return;
    if (m.scrollHeight - m.scrollTop - m.clientHeight < 300) stick = true;
  } catch { /* ignore */ }
}
// Unconditional drop-to-bottom on send: the user asked for it, output or
// not. Unlike pin() this ignores `stick` — pressing Enter means "take me
// to the latest", even from a scrolled-up view.
function dropToBottom(): void {
  stick = true;
  const m = $("scrollwrap");
  if (m) m.scrollTop = m.scrollHeight;
}
// Late media bytes extend the page under a pinned viewport (the #1
// autoscroll miss: text pinned fine, then images landed below it).
window.addEventListener("pi-media-settled", pin);
// OpenUI round-trip (see openui.ts): widget actions (@ToAssistant,
// form submits) come back as user messages. Mid-run they queue as
// follow-ups; idle they send fresh.
window.addEventListener("pi-genui-submit", (e) => {
  try {
    const ev: any = (e as CustomEvent).detail ?? {};
    const msg = typeof ev.humanFriendlyMessage === "string" && ev.humanFriendlyMessage
      ? ev.humanFriendlyMessage
      : typeof ev.params?.message === "string" ? ev.params.message : JSON.stringify(ev.params ?? ev);
    const extra = ev.formState && Object.keys(ev.formState).length
      ? `\n[data] ${JSON.stringify(ev.formState)}` : "";
    const text = `[ui action] ${msg}${extra}`;
    if (streaming) void sendFollowUp(text);
    else {
      setComposerText(text);
      void send();
    }
  } catch { /* ignore */ }
});
// Single-button Send<->Stop morph, ChatGPT-style. The separate #abortbtn
// is hidden (see styles.css); the composer button does both jobs.
function syncSendBtn() {
  const btn = document.getElementById("send") as HTMLButtonElement | null;
  if (!btn) return;
  if (streaming || directStreaming) {
    btn.disabled = false;
    btn.dataset.mode = "stop";
    btn.innerHTML = ICO_STOP;
    btn.title = "Stop";
  } else {
    btn.dataset.mode = "send";
    btn.innerHTML = ICO_SEND;
    btn.title = "Send";
    btn.disabled = !composerText().trim() && !pendingAttachments.length;
  }
}
// Mirror of pi's own queue, data-driven (see renderQueued). queue_update
// carries the live {steering[], followUp[]} arrays; cleared on view
// switch and refined by syncRunFlag's pendingMessageCount.
// queuedCount covers the gap before the first queue_update: a background
// queue predates our view, so only its COUNT is known (never invent
// texts). It suppresses settled rows exactly like a real queue, and a
// new turn clears it — held messages going live means queue consumed.
type AgentQueue = { steering: string[]; followUp: string[] };
let lastQueue: AgentQueue | null = null;
let queuedCount = 0; // pendingMessageCount fallback, see comment above
// Last transmit timestamp (any send path): Stop ignores presses inside
// the debounce window so a double-Enter / double-click can't send-then-
// instantly-abort — the second press lands on the emptied composer and
// would otherwise read as "stop". Deliberate stops just click again.
let lastTransmit = 0;
// Fire-and-forget stop (button/Escape). Completion settles via agent_settled.
function stopOnly() {
  if (Date.now() - lastTransmit < 800) return;
  awaitingResponse = false;
  try {
    pi.abort(cwd).catch(() => {});
  } catch { /* ignore */ }
  // Wedge guard: if the proc is already gone (crashed pi, reaped child)
  // the abort fails silently and no settled event will ever unlock the
  // composer. Settle locally, but only on repeated corroboration — a
  // single failed sample is just backend busy, and the settled event
  // (if one comes) settles first and disarms this via !streaming.
  let n = 0;
  const t = setInterval(async () => {
    if (!streaming || ++n > 3) {
      clearInterval(t);
      return;
    }
    try {
      await pi.state(cwd);
      clearInterval(t); // proc answers: settled event owns completion
    } catch {
      if (n >= 3 && streaming) {
        clearInterval(t);
        finishRun();
      }
    }
  }, 2000);
}
const ICO_COPY = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="6.5" y="6.5" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M13.5 6.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.5"/></svg>`;
const ICO_REVERT = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3.5 8a6.5 6.5 0 1 1-1 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M3.5 3.5V8H8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICO_FORK = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="6" cy="5" r="2" stroke="currentColor" stroke-width="1.5"/><circle cx="6" cy="15" r="2" stroke="currentColor" stroke-width="1.5"/><circle cx="14" cy="10" r="2" stroke="currentColor" stroke-width="1.5"/><path d="M6 7v6M8 5.5h3.5a2 2 0 0 1 2 2V8M8 14.5h3.5a2 2 0 0 0 2-2V12" stroke="currentColor" stroke-width="1.5"/></svg>`;
async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* WebKitGTK/Tauri may reject it: legacy path below */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
async function doCopy(btn: HTMLButtonElement) {
  // User-bubble buttons live in .actions.overlay, a SIBLING after .msg
  // inside .umsgwrap — closest(".msg") misses them (null → copied "").
  // Assistant buttons sit inside their .msg. Cover both.
  const msg = btn.closest(".msg")
    ?? btn.closest(".umsgwrap")?.querySelector(":scope > .msg");
  const clone = msg?.cloneNode(true) as HTMLElement | null;
  clone?.querySelector(".mmenu-wrap")?.remove();
  const text = clone?.textContent?.trim() ?? "";
  const isIcon = btn.classList.contains("act-copy");
  const orig = btn.innerHTML;
  const ok = await copyText(text);
  if (!isIcon) return;
  btn.innerHTML = ok
    ? `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 10.5l4 4 7-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  btn.title = ok ? "Copied" : "Copy failed";
  setTimeout(() => {
    btn.innerHTML = orig;
    btn.title = "Copy";
  }, 1200);
}
// ---- changes pane (Claude-style diff sidebar) ----
type DiffRef = { tool: string; path: string; args: any; out: string };
const diffFiles = new Map<string, DiffRef>(); // path -> latest edit/write, this view
let selKey: string | null = null; // selected file in the pane list
let viewRef: DiffRef | null = null; // pinned read, or selected file
// True once the user explicitly picks a file (pane click / expanding its
// row): live edits then only extend the list, never yank the view away.
// Rebuilds and view switches clear it back to follow-latest.
let selPinned = false;
function diffKey(tool: string, path: string): string {
  return path && path !== tool ? path : `${tool}:${path}`;
}
function trackDiff(ref: DiffRef) {
  const k = diffKey(ref.tool, ref.path);
  diffFiles.set(k, ref);
  selKey = k;
  viewRef = ref;
}
function collectEdits(arr: any[], calls: Map<string, any>) {
  diffFiles.clear();
  selKey = null;
  viewRef = null;
  selPinned = false;
  for (const m of arr) {
    if (m?.role !== "toolResult") continue;
    const tn = (m.toolName ?? "").toLowerCase();
    if (tn !== "edit" && tn !== "write") continue;
    const a = calls.get(m.toolCallId);
    const p = a?.arguments?.path ?? tn;
    trackDiff({ tool: m.toolName, path: p, args: a?.arguments ?? {}, out: textOf(m.content).slice(0, 8000) });
  }
}
// Live tool result: edits/writes join the file list, reads pin view-only.
// Reads never touch the pane: only file changes (edit/write) appear there.
// Everything else expands inline in the transcript and leaves it alone.
function noteDiff(ref: DiffRef) {
  const tn = (ref.tool || "").toLowerCase();
  if (tn !== "edit" && tn !== "write") return;
  if (selPinned && selKey) {
    // User is reading a pinned file: extend the list, keep the view.
    diffFiles.set(diffKey(ref.tool, ref.path), ref);
  } else {
    trackDiff(ref);
  }
  if (changesVisible()) renderDiffPane();
}
function refCounts(r: DiffRef): string {
  const t = (r.tool || "").toLowerCase();
  if (t === "edit") return editCounts(r.args);
  if (t === "write" && typeof r.args?.content === "string") return `+${r.args.content.split("\n").length}`;
  return "";
}
// Code block with line numbers (reads in the Changes pane).
function codeLines(src: string): HTMLElement {
  const box = el("div", "codelines");
  const lines = src.split("\n");
  for (const ln of lines.slice(0, 400)) {
    box.appendChild(el("div", "cl", esc(ln || " ")));
  }
  if (lines.length > 400) box.appendChild(el("div", "cl dim", `…(${lines.length - 400} more lines)`));
  return box;
}
function renderDiffBody(ref: DiffRef): HTMLElement {
  const t = (ref.tool || "").toLowerCase();
  const content = typeof ref.args?.content === "string" ? ref.args.content : "";
  // Markdown files read better rendered than as a green wall of raw text.
  if (t === "write" && content && /\.(md|markdown|mdx)$/i.test(ref.path)) {
    // Rendered documents need no card frame — text on pane background.
    return el("div", "mdpreview", renderMd(content.slice(0, 12000)));
  }
  if (t === "edit" || t === "write") {
    const d = editDiff(ref.tool, ref.args);
    if (d) {
      // Pane title already names the file; drop the duplicate inner header.
      d.querySelector(":scope > .diffhead")?.remove();
      return d;
    }
  }
  if (t === "read") {
    const wrap = el("div", "diffblock");
    wrap.appendChild(el("div", "diffhead", `${esc(ref.path)} · read-only`));
    const txt = ref.out.length > 6000 ? ref.out.slice(0, 6000) + "\n…(truncated)" : ref.out;
    wrap.appendChild(codeLines(txt));
    return wrap;
  }
  const wrap = el("div", "diffblock");
  wrap.appendChild(el("div", "diffhead", esc(ref.path)));
  wrap.appendChild(el("div", "tgout", renderMd(ref.out.slice(0, 4000))));
  return wrap;
}
function renderDiffPane() {
  const body = $("diffbody");
  const title = $("difftitle");
  body.innerHTML = "";
  if (diffFiles.size) {
    const list = el("div", "filelist");
    for (const [k, r] of diffFiles) {
      const base = r.path.split("/").pop() || r.path;
      const o = el("button", "fileopt" + (k === selKey ? " cur" : ""),
        `<span class="fname">${esc(base)}</span><span class="fcount">${esc(refCounts(r))}</span>`) as HTMLButtonElement;
      o.title = r.path;
      o.addEventListener("click", () => {
        selKey = k;
        viewRef = r;
        selPinned = true; // explicit pick: live edits stop following
        renderDiffPane();
      });
      list.appendChild(o);
    }
    body.appendChild(list);
  }
  // Resolve the selection through the map: a pinned file shows its LATEST
  // snapshot, not the object identity from click time (edits replace map
  // entries). Unmapped pinned reads fall back to viewRef.
  let shown: DiffRef | null = viewRef;
  if (selKey) shown = diffFiles.get(selKey) ?? viewRef;
  if (!shown) {
    title.textContent = "Changes";
    if (!diffFiles.size) body.appendChild(el("div", "msg sys", "No changes to show"));
    return;
  }
  title.textContent = shown.path.split("/").pop() || shown.path;
  body.appendChild(renderDiffBody(shown));
  wireCopy(body);
}
// One shared sidebar, two tabs, one visible at a time. Changes and
// Subagents share the pane, the resize handle, and the saved width —
// never side by side, never crammed together.
let sideTabCur: "changes" | "agents" | "procs" = "changes";
// Last non-null tab, so the single header toggle reopens where you were.
let sideTabLast: "changes" | "agents" | "procs" = "changes";
function sideIsOpen(): boolean {
  return !$("sidepane").classList.contains("hidden");
}
function changesVisible(): boolean {
  return sideIsOpen() && sideTabCur === "changes";
}
function agentsVisible(): boolean {
  return sideIsOpen() && sideTabCur === "agents";
}
function procsVisible(): boolean {
  return sideIsOpen() && sideTabCur === "procs";
}
function setSidePane(tab: "changes" | "agents" | "procs" | null) {
  if (tab === null) {
    $("sidepane").classList.add("hidden");
  } else {
    sideTabCur = tab;
    sideTabLast = tab;
    $("sidepane").classList.remove("hidden");
    document.querySelectorAll("#sidetabs .sidetab").forEach((b) =>
      b.classList.toggle("cur", (b as HTMLElement).dataset.tab === tab));
    $("diffwrap").classList.toggle("hidden", tab !== "changes");
    $("agentswrap").classList.toggle("hidden", tab !== "agents");
    $("procswrap").classList.toggle("hidden", tab !== "procs");
    if (tab === "changes") renderDiffPane();
    else if (tab === "agents") {
      renderAgents();
      void refreshJobs(true);
    } else {
      renderProcs();
      void refreshJobs(true);
    }
  }
  syncPaneBtns();
}
function syncPaneBtns() {
  ($("panebtn") as HTMLButtonElement).classList.toggle("open", sideIsOpen());
}
let runT0 = 0;
let lastRun: HTMLElement | null = null;
function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
// Claude-style one-line tool summary from name + args.
function toolSummary(name: string, p: any): string {
  const s = (v: any) => (typeof v === "string" ? v : "");
  switch ((name || "").toLowerCase()) {
    case "read": return p?.path ? `Read ${s(p.path)}` : "Read";
    case "edit": {
      const c = editCounts(p);
      return p?.path ? `Edit ${s(p.path)}${c ? ` ${c}` : ""}` : "Edit";
    }
    case "write": {
      const n = typeof p?.content === "string" ? p.content.split("\n").length : 0;
      return p?.path ? `Write ${s(p.path)}${n ? ` (+${n})` : ""}` : "Write";
    }
    case "bash": return s(p?.command) ? `$ ${s(p.command).slice(0, 80)}` : "Bash";
    case "glob": return s(p?.pattern) ? `Glob ${s(p.pattern)}` : "Glob";
    case "grep": return s(p?.pattern) ? `Grep ${s(p.pattern)}` : "Grep";
    default: {
      const first = p && typeof p === "object" ? s(p.path || p.command || p.pattern || p.url || p.query) : "";
      return first ? `${name} ${first.slice(0, 60)}` : name;
    }
  }
}
function editCounts(p: any): string {
  try {
    let add = 0, del = 0;
    for (const e of p?.edits ?? []) {
      add += String(e?.newText ?? "").split("\n").length;
      del += String(e?.oldText ?? "").split("\n").length;
    }
    if (!add && !del) return "";
    return `+${add} −${del}`;
  } catch { return ""; }
}
// Unified diff block computed from edit/write args (the results carry no diff).
function editDiff(name: string, p: any): HTMLElement | null {
  try {
    const n = (name || "").toLowerCase();
    if (n === "edit" && Array.isArray(p?.edits) && p.edits.length) {
      const wrap = el("div", "diffblock");
      wrap.appendChild(el("div", "diffhead", esc(p.path ?? "edit")));
      for (const e of p.edits.slice(0, 5)) {
        wrap.appendChild(lineDiffBlock(String(e?.oldText ?? ""), String(e?.newText ?? "")));
      }
      if (p.edits.length > 5) wrap.appendChild(el("div", "dim", `…(${p.edits.length - 5} more edits)`));
      return wrap;
    }
    // A new file is a diff with an empty old side: same hunks, gutters
    // and colors as edits, every line an addition. No separate look.
    if (n === "write" && typeof p?.content === "string") {
      const wrap = el("div", "diffblock");
      wrap.appendChild(el("div", "diffhead", esc(p.path ?? "write")));
      const box = el("div", "dlblock");
      const lines = p.content.slice(0, 4000).split("\n");
      for (const t of lines.slice(0, 400)) {
        box.appendChild(el("div", "dlline dl-add", `<span class="dlgutter">+</span><code>${esc(t) || " "}</code>`));
      }
      if (lines.length > 400) box.appendChild(el("div", "dlline dl-ctx", `<span class="dlgutter"> </span><code>…(${lines.length - 400} more lines)</code>`));
      wrap.appendChild(box);
      return wrap;
    }
  } catch { /* fall through */ }
  return null;
}
function lineDiffBlock(oldS: string, newS: string): HTMLElement {
  const a = oldS.split("\n"), b = newS.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const box = el("div", "dlblock");
  const line = (cls: string, sig: string, t: string) => {
    box.appendChild(el("div", "dlline " + cls, `<span class="dlgutter">${sig}</span><code>${esc(t) || " "}</code>`));
  };
  // Cap per-hunk lines: a whole-file replacement would otherwise render
  // tens of thousands of divs and freeze the view. Context slices are
  // already tiny; the cap only bites on del/add walls.
  const show = (arr: string[], cls: string, sig: string) => {
    arr.slice(0, 200).forEach((t) => line(cls, sig, t));
    if (arr.length > 200) line("dl-ctx", " ", `…(${arr.length - 200} more lines)`);
  };
  show(a.slice(Math.max(0, pre - 2), pre), "dl-ctx", " ");
  show(a.slice(pre, a.length - suf), "dl-del", "−");
  show(b.slice(pre, b.length - suf), "dl-add", "+");
  show(b.slice(b.length - suf, b.length - suf + 2), "dl-ctx", " ");
  if (!a.length && !b.length) line("", " ", "(empty)");
  return box;
}

// One toolbar per user turn, at the end of that turn's whole agent reply
// (all interim texts + tool rows + final text share it). User bubbles keep
// their own hover toolbar; these rows cover agent replies.
function agentToolsRow(): HTMLElement {
  return el("div", "turn-tools",
    `<button class="act-tcopy iconbtn" title="Copy reply">${ICO_COPY}</button>`);
}
// All assistant-bubble texts of the turn containing `row` (oldest first).
// The row lives inside the turn's last bubble; walk back to the user bubble.
function turnText(row: HTMLElement): string {
  const parts: string[] = [];
  const nodes: HTMLElement[] = [];
  let n: Element | null = row.closest(".msg.assistant");
  while (n && !(n as HTMLElement).classList?.contains("umsgwrap")) {
    nodes.unshift(n as HTMLElement);
    n = n.previousElementSibling;
  }
  for (const el of nodes) {
    if (el.classList.contains("msg") && el.classList.contains("assistant")) {
      const c = el.cloneNode(true) as HTMLElement;
      c.querySelector(".turn-tools")?.remove();
      const t = c.textContent?.trim();
      if (t) parts.push(t);
    }
  }
  return parts.join("\n\n");
}
async function copyTurn(btn: HTMLButtonElement) {
  const row = btn.closest(".turn-tools") as HTMLElement | null;
  if (!row) return;
  // Same tick feedback as user-bubble copy (doCopy): swap the icon for
  // 1.2s so the click visibly lands. Restores the row's own title.
  const orig = btn.innerHTML;
  const origTitle = btn.title;
  const ok = await copyText(turnText(row));
  btn.innerHTML = ok
    ? `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 10.5l4 4 7-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  btn.title = ok ? "Copied" : "Copy failed";
  setTimeout(() => {
    if (!btn.isConnected) return;
    btn.innerHTML = orig;
    btn.title = origTitle;
  }, 1200);
}
function markTurnActions() {
  // Rows live INSIDE the turn's last assistant bubble (not as direct
  // #msgs children), so cleanup must be a descendant selector — the old
  // `#msgs > .turn-tools` never matched and rows duplicated on every
  // message_end/finish/refresh. One row per user turn, rebuilt each call.
  document.querySelectorAll("#msgs .turn-tools").forEach((n) => n.remove());
  // Copy appears only in true quiet: run settled AND nothing queued
  // behind it. A settle with queued follow-ups (or an accepted-but-silent
  // follow-up) means more output is coming — showing actions now reads
  // as "done" prematurely and they flicker when the next turn lands.
  const queued = (lastQueue != null && (lastQueue.steering.length > 0 || lastQueue.followUp.length > 0)) || queuedCount > 0;
  if (streaming || awaitingResponse || queued) return;
  const kids = Array.from(document.querySelectorAll("#msgs > *")) as HTMLElement[];
  let hasAsst = false;
  let lastIdx = -1;
  let segStart = 0;
  const flush = () => {
    // Row goes inside the turn's last assistant bubble so it hover-reveals
    // with that bubble (Claude-style: invisible at rest).
    if (hasAsst) {
      for (let i = lastIdx; i >= segStart; i--) {
        const k = kids[i];
        if (k.classList?.contains("msg") && k.classList.contains("assistant") && !k.classList.contains("stream")) {
          k.appendChild(agentToolsRow());
          break;
        }
      }
    }
    hasAsst = false;
    lastIdx = -1;
  };
  kids.forEach((k, i) => {
    if (k.classList.contains("umsgwrap")) {
      flush();
      segStart = i + 1;
      return;
    }
    lastIdx = i;
    if (k.classList.contains("msg") && k.classList.contains("assistant")) hasAsst = true;
  });
  flush();
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

// Non-blocking error surface. Native alert()/confirm() are routed by
// Tauri to the dialog plugin, which this app doesn't permit — they
// throw ("dialog.confirm not allowed") instead of asking. So errors
// toast, and destructive buttons arm-to-confirm in place.
function toastErr(msg: string): void {
  try {
    // Mirror into the persisted errlog so toasts survive to Settings → Debug.
    const raw = localStorage.getItem("errlog");
    const arr = raw ? (JSON.parse(raw) as unknown[]) : [];
    const list = Array.isArray(arr) ? arr : [];
    list.push({ at: new Date().toISOString(), msg: String(msg).slice(0, 500) });
    localStorage.setItem("errlog", JSON.stringify(list.slice(-20)));
  } catch { /* ignore */ }
  try {
    const t = el("div", "errtoast", esc(msg.slice(0, 300)));
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  } catch { /* ignore */ }
}

// Crash catcher: any uncaught error or unhandled rejection surfaces as a
// toast AND persists to a 20-entry ring in localStorage. Silent death is
// how send+switch style races hide; this makes the next repro self-reporting.
function trapErrors(): void {
  const show = (msg: string) => {
    try {
      const t = el("div", "errtoast", esc(msg.slice(0, 300)));
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 9000);
    } catch { /* last resort: stay silent */ }
  };
  const log = (msg: string) => {
    try {
      const raw = localStorage.getItem("errlog");
      const arr = raw ? (JSON.parse(raw) as unknown[]) : [];
      const list = Array.isArray(arr) ? arr : [];
      list.push({ at: new Date().toISOString(), msg: msg.slice(0, 500) });
      localStorage.setItem("errlog", JSON.stringify(list.slice(-20)));
    } catch { /* private mode */ }
  };
  window.addEventListener("error", (e) => {
    const msg = `Error: ${(e as ErrorEvent).message || String((e as ErrorEvent).error ?? e)}`;
    try {
      console.error("[app]", msg);
    } catch { /* ignore */ }
    log(msg);
    show(msg);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = (e as PromiseRejectionEvent).reason;
    const msg = `Unhandled: ${(r as any)?.message ?? String(r ?? e)}`;
    try {
      console.error("[app]", msg);
    } catch { /* ignore */ }
    log(msg);
    show(msg);
  });
}

function el(tag: string, cls: string, html = ""): HTMLElement {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (html) d.innerHTML = html;
  return d;
}

// ---- message rendering (AgentMessage shapes) ----

function textOf(c: any): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .filter((b) => b && (b.type === "text" || typeof b.text === "string"))
      .map((b) => b.text ?? "")
      .join("");
  return "";
}

// Running tool row: the same expandable shape as a completed row, but
// alive — pulsing dot, "running…" body fed by tool_execution_update,
// morphed into the final form at toolResult. Collapsed like history
// rows: one visible line per running tool, detail behind the click.
function liveToolRow(toolName: string, args: any): HTMLElement {
  const params = args && typeof args === "object" ? args : {};
  const path = typeof (params as any).path === "string" ? (params as any).path : toolName;
  const d = el("details", "toolrow liverow");
  d.appendChild(el("summary", "tgsum",
    `<span class="tstat run">◌</span> ` + esc(toolSummary(toolName, params)) +
    ` <span class="telapsed">· running…</span>`));
  const ran = esc(JSON.stringify(params)).slice(0, 500);
  if (ran && ran !== "{}") d.appendChild(el("div", "tgrun", `<code>${ran}</code>`));
  // No body until completion: the summary line already says running, and
  // the morph installs the real output. Nothing repeats while expanded.
  (d as any)._diff = { tool: toolName, path, args: params, out: "" };
  wireCopy(d);
  return d;
}

// Sent attachments arrive as `[attached file: PATH]` lines (see send()).
// Attachment taxonomy: images/video reuse the markdown media pipeline;
// pdf/audio/text/other render as their own cards below (see attachCard).
// TEXT_EXTS mirrors read_media's text list in src-tauri/src/lib.rs.
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"]);
const VIDEO_EXTS = new Set(["mp4", "m4v", "webm", "mov", "ogv"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac"]);
const SHEET_EXTS = new Set(["xlsx", "xls", "ods", "csv"]);
const DOC_EXTS = new Set(["docx", "pptx", "odt"]);
const TEXT_EXTS = new Set(["txt", "md", "markdown", "json", "tsv", "log", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rs", "go", "java", "c", "h", "cpp", "hpp", "cs", "rb", "php", "swift", "kt", "html", "htm", "css", "scss", "sh", "bash", "yaml", "yml", "toml", "ini", "cfg", "xml", "sql", "r", "dockerfile", "gitignore"]);
type AttachKind = "image" | "video" | "pdf" | "audio" | "text" | "sheet" | "doc" | "file";
interface AttachItem { kind: AttachKind; path: string; name: string; }
function splitUserAttachments(raw: string): { text: string; md: string; files: AttachItem[] } {
  const texts: string[] = [];
  const md: string[] = [];
  const files: AttachItem[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\[attached file: (.+)\]$/);
    const p = (m?.[1] ?? "").trim();
    if (!m || !p) { texts.push(line); continue; }
    const clean = p.split("?")[0];
    const ext = clean.split(".").pop()?.toLowerCase() ?? "";
    const name = (clean.split("/").pop() ?? clean).replace(/[\[\]]/g, "_") || clean;
    if (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext)) md.push(`![${name}](<${p}>)`);
    else if (ext === "pdf") files.push({ kind: "pdf", path: p, name });
    else if (AUDIO_EXTS.has(ext)) files.push({ kind: "audio", path: p, name });
    else if (SHEET_EXTS.has(ext)) files.push({ kind: "sheet", path: p, name });
    else if (DOC_EXTS.has(ext)) files.push({ kind: "doc", path: p, name });
    else if (TEXT_EXTS.has(ext)) files.push({ kind: "text", path: p, name });
    else files.push({ kind: "file", path: p, name });
  }
  return { text: texts.join("\n").trim(), md: md.join("\n"), files };
}

function attachCard(f: AttachItem): HTMLElement {
  const card = el("div", `acard ${f.kind}`);
  card.setAttribute("data-apath", f.path);
  if (f.kind === "pdf") {
    const cv = document.createElement("canvas");
    cv.className = "pdfthumb";
    cv.setAttribute("data-pdfpath", f.path);
    card.appendChild(cv);
  } else if (f.kind === "audio") {
    const au = document.createElement("audio");
    au.controls = true;
    au.preload = "none";
    au.setAttribute("data-audiopath", f.path);
    card.appendChild(au);
  } else if (f.kind === "text" || f.kind === "doc") {
    const pre = el("pre", "textthumb", "loading\u2026");
    pre.setAttribute(f.kind === "doc" ? "data-docpath" : "data-textpath", f.path);
    card.appendChild(pre);
  } else if (f.kind === "sheet") {
    const tbl = document.createElement("table");
    tbl.className = "sheetthumb";
    tbl.setAttribute("data-sheetpath", f.path);
    card.appendChild(tbl);
  } else {
    card.appendChild(el("span", "fext", esc((f.name.split(".").pop() ?? "file").toUpperCase().slice(0, 5))));
    const sz = el("span", "fsize", "\u2026");
    sz.setAttribute("data-sizepath", f.path);
    card.appendChild(sz);
  }
  card.appendChild(el("span", "aname", esc(f.name)));
  return card;
}

const attachCache = new Map<string, string>();
const inTauriMain = typeof window !== "undefined" && "__TAURI__" in window;
// Single preview pipeline: everything renders from read_media data URIs
// on both clients (no per-client transports, no parallel endpoints).
async function attachData(path: string): Promise<string | null> {
  const hit = attachCache.get(path);
  if (hit) return hit;
  try {
    const r = await invoke<{ mime: string; base64: string }>("read_media", { path, base: cwd || null });
    if (!r?.base64) return null;
    const uri = `data:${r.mime};base64,${r.base64}`;
    attachCache.set(path, uri);
    return uri;
  } catch { return null; }
}
async function attachText(path: string): Promise<string | null> {
  const uri = await attachData(path);
  if (!uri) return null;
  try {
    const b64 = uri.slice(uri.indexOf(",") + 1);
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch { return null; }
}
async function renderPdfBytes(cv: HTMLCanvasElement, data: Uint8Array, targetW?: number): Promise<void> {
  const pdf = await pdfjs.getDocument({ data }).promise;
  const page = await pdf.getPage(1);
  const solo = !!cv.closest(".uatt.solo");
  targetW = targetW ?? (solo ? 360 : 220);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: targetW / vp1.width });
  cv.width = Math.floor(vp.width);
  cv.height = Math.floor(vp.height);
  await page.render({ canvas: cv, viewport: vp }).promise;
}
async function renderPdfThumb(cv: HTMLCanvasElement, path: string, targetW?: number): Promise<void> {
  try {
    const uri = await attachData(path);
    if (!uri || !cv.isConnected) return;
    const b64 = uri.slice(uri.indexOf(",") + 1);
    await renderPdfBytes(cv, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), targetW);
  } catch {
    cv.closest(".acard")?.classList.add("broken");
  }
}
let attachZoomEsc = false;
// Full-content zoom: the browser renders the file itself — native PDF
// viewer, full table, full text — not a bigger thumbnail. Audio has
// controls already and opaque files have nothing to show: no zoom.
function openAttachZoom(card: HTMLElement): void {
  if (document.querySelector(".uatt-zoom")) return;
  const cls = card.classList;
  const kind = cls.contains("pdf") ? "pdf" : cls.contains("sheet") ? "sheet"
    : cls.contains("doc") ? "doc" : cls.contains("text") ? "text" : null;
  if (!kind) return;
  const path = card.getAttribute("data-apath") ?? "";
  const name = card.querySelector(".aname")?.textContent ?? "file";
  if (!path) return;
  const overlay = el("div", "uatt-zoom");
  const holder = el("div", "uatt-zoom-card");
  const head = el("div", "uatt-zoom-head");
  head.appendChild(el("span", "uatt-zoom-name", esc(name)));
  const closeBtn = el("button", "uatt-zoom-x", "\u00d7") as HTMLButtonElement;
  closeBtn.title = "Close";
  head.appendChild(closeBtn);
  holder.appendChild(head);
  const body = el("div", "uatt-zoom-body", "loading\u2026");
  holder.appendChild(body);
  overlay.appendChild(holder);
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  const close = () => { overlay.remove(); document.body.style.overflow = ""; };
  closeBtn.onclick = (e) => { e.stopPropagation(); close(); };
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  if (!attachZoomEsc) {
    attachZoomEsc = true;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") document.querySelector(".uatt-zoom button.uatt-zoom-x")?.dispatchEvent(new Event("click"));
    });
  }
  if (kind === "pdf") {
    const cv = document.createElement("canvas");
    cv.className = "fullpdf";
    body.innerHTML = "";
    body.appendChild(cv);
    attachData(path).then((uri) => {
      if (!uri || !cv.isConnected) { if (cv.isConnected) body.textContent = "could not load file"; return; }
      const b64 = uri.slice(uri.indexOf(",") + 1);
      void renderPdfBytes(cv, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), 720).catch(() => {
        if (body.isConnected) body.textContent = "could not load file";
      });
    }).catch(() => { if (body.isConnected) body.textContent = "could not load file"; });
  } else if (kind === "sheet") {
    invoke<{ sheets: string[]; sheet: string; rows: string[][]; truncated: boolean } | null>("read_sheet", { path, base: cwd || null, maxRows: 200, maxCols: 20 })
      .then((r) => {
        if (!body.isConnected) return;
        if (!r?.rows?.length) { body.textContent = "could not load sheet"; return; }
        const tbl = document.createElement("table");
        tbl.className = "fullsheet";
        const tb = document.createElement("tbody");
        for (const row of r.rows) {
          const tr = document.createElement("tr");
          for (const cell of row) {
            const td = document.createElement("td");
            td.textContent = cell;
            tr.appendChild(td);
          }
          tb.appendChild(tr);
        }
        tbl.appendChild(tb);
        body.innerHTML = "";
        body.appendChild(tbl);
        if (r.truncated) body.appendChild(el("div", "uatt-zoom-note", "showing first 200 rows"));
      })
      .catch(() => { if (body.isConnected) body.textContent = "could not load sheet"; });
  } else {
    // text + doc: full content, not the card's 24-line excerpt.
    const load = kind === "doc"
      ? invoke<{ text: string } | null>("read_office_text", { path, base: cwd || null }).then((r) => r?.text ?? null)
      : attachText(path);
    load.then((txt) => {
      if (!body.isConnected) return;
      if (txt == null) { body.textContent = "could not load file"; return; }
      const pre = el("pre", "fulltext", "");
      pre.textContent = txt || "(empty file)";
      body.innerHTML = "";
      body.appendChild(pre);
    }).catch(() => { if (body.isConnected) body.textContent = "could not load file"; });
  }
}
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function wireAttachFiles(container: HTMLElement): void {
  container.querySelectorAll<HTMLCanvasElement>("canvas[data-pdfpath]").forEach((cv) => {
    const path = cv.getAttribute("data-pdfpath") ?? "";
    cv.removeAttribute("data-pdfpath");
    void renderPdfThumb(cv, path);
  });
  container.querySelectorAll<HTMLAudioElement>("audio[data-audiopath]").forEach((au) => {
    const path = au.getAttribute("data-audiopath") ?? "";
    au.removeAttribute("data-audiopath");
    void attachData(path).then((uri) => { if (uri && au.isConnected) au.src = uri; });
  });
  container.querySelectorAll<HTMLElement>("pre[data-textpath]").forEach((pre) => {
    const path = pre.getAttribute("data-textpath") ?? "";
    pre.removeAttribute("data-textpath");
    void attachText(path).then((txt) => {
      if (!pre.isConnected) return;
      if (txt == null) { pre.textContent = "could not load file"; return; }
      pre.textContent = txt.split("\n").slice(0, 24).join("\n").slice(0, 1500) || "(empty file)";
    });
  });
  container.querySelectorAll<HTMLTableElement>("table[data-sheetpath]").forEach((tbl) => {
    const path = tbl.getAttribute("data-sheetpath") ?? "";
    tbl.removeAttribute("data-sheetpath");
    invoke<{ sheets: string[]; sheet: string; rows: string[][]; truncated: boolean } | null>("read_sheet", { path, base: cwd || null })
      .then((r) => {
        if (!tbl.isConnected) return;
        if (!r?.rows?.length) { tbl.outerHTML = "<span class='dim'>could not load sheet</span>"; return; }
        const tb = document.createElement("tbody");
        for (const row of r.rows.slice(0, 8)) {
          const tr = document.createElement("tr");
          for (const cell of row.slice(0, 8)) {
            const td = document.createElement("td");
            td.textContent = cell;
            td.title = cell;
            tr.appendChild(td);
          }
          tb.appendChild(tr);
        }
        tbl.appendChild(tb);
      })
      .catch(() => {});
  });
  container.querySelectorAll<HTMLElement>("pre[data-docpath]").forEach((pre) => {
    const path = pre.getAttribute("data-docpath") ?? "";
    pre.removeAttribute("data-docpath");
    invoke<{ text: string; truncated: boolean } | null>("read_office_text", { path, base: cwd || null })
      .then((r) => {
        if (!pre.isConnected) return;
        if (!r?.text) { pre.textContent = "could not load file"; return; }
        pre.textContent = r.text.split("\n").slice(0, 24).join("\n").slice(0, 1500) + (r.truncated ? "\n\u2026" : "");
      })
      .catch(() => { if (pre.isConnected) pre.textContent = "could not load file"; });
  });
  // Click a card (not audio controls) to zoom it in an overlay.
  container.querySelectorAll<HTMLElement>(".acard").forEach((card) => {
    if ((card as any)._zoomwired) return;
    (card as any)._zoomwired = true;
    card.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("audio,button,a")) return;
      if (card.classList.contains("audio")) return;
      openAttachZoom(card);
    });
  });
  container.querySelectorAll<HTMLElement>("span[data-sizepath]").forEach((sp) => {
    const path = sp.getAttribute("data-sizepath") ?? "";
    sp.removeAttribute("data-sizepath");
    invoke<{ mtimeMs: number; size: number } | null>("media_stat", { path, base: cwd || null })
      .then((st) => { if (sp.isConnected) sp.textContent = st && typeof st.size === "number" ? fmtSize(st.size) : ""; })
      .catch(() => {});
  });
}

function msgNode(m: any, calls?: Map<string, any>, forkId?: string): HTMLElement {
  const role = m.role ?? "unknown";
  // Jobs via pi-jobs: one collapsed card per job — dispatch + result
  // inline, detail behind the click, index in the Agents/Processes panel.
  // Tracked here so history rebuilds and live appends share one path.
  // Legacy spawn-* cards (pre-jobs histories) render through the same
  // card; only job-* rows are live-tracked with pids and log detail.
  if (role === "custom" && typeof m.customType === "string"
    && (m.customType.startsWith("job-") || m.customType.startsWith("spawn-"))) {
    return jobCard(m);
  }
  if (role === "user") {
    const wrap = el("div", "umsgwrap");
    // Source text for fork-id matching: rendered markdown can't match pi's
    // fork entries exactly. Kept for the life of the bubble — clicks resolve
    // a missing entry id lazily via this text (see resolveForkEntry).
    wrap.dataset.forkText = textOf(m.content) || "";
    // Attached previews render ABOVE the bubble as their own wrapping
    // row (scales to many files); the bubble holds text only.
    let { text: utext, md: umd, files: ufiles } = splitUserAttachments(textOf(m.content) || "");
    if (!utext && !umd && !ufiles.length) utext = "(empty)";
    if (umd || ufiles.length) {
      const prev = el("div", "uatt");
      if (!ufiles.length && umd.split("\n").length === 1) prev.classList.add("solo");
      if (umd) prev.innerHTML = renderMd(umd);
      for (const f of ufiles) prev.appendChild(attachCard(f));
      wrap.appendChild(prev);
      wireAttachFiles(prev);
    }
    if (utext) {
      const box = el("div", "msg user");
      box.appendChild(el("div", "ubody", renderMd(utext)));
      wrap.appendChild(box);
    }
    // Hover toolbar, icon-only and hidden at rest (Claude-style): copy +
    // revert. Overlay takes no layout space so the bubble hugs the text.
    // Fork/revert icons render immediately (fast UI); the entry id fills
    // in when pi's fork list arrives, or lazily on click.
    const acts = el(
      "div",
      "actions overlay",
      `<button class="act-fork iconbtn" ${forkId ? `data-entry="${forkId}"` : ""} title="Fork to new chat (keep both)">${ICO_FORK}</button>` +
        `<button class="act-revert iconbtn" ${forkId ? `data-entry="${forkId}"` : ""} title="Revert to this message (replaces current chat)">${ICO_REVERT}</button>` +
        `<button class="act-copy iconbtn" title="Copy">${ICO_COPY}</button>`
    );
    wrap.appendChild(acts);
    return wrap;
  }
  if (role === "assistant") {
    const box = el("div", "msg assistant");
    const blocks = Array.isArray(m.content) ? m.content : [];
    void CHEV;
    const text = blocks
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    if (text) {
      const body = el("div", "atext", renderMd(text));
      box.appendChild(body);
    }
    // No toolbar here: markFinalActions() puts one only under the final
    // agent message. Revert lives on user messages (pi forks at the user
    // turn; Claude's Rewind equivalent).
    // Model already lives in the composer chip; stop reasons like toolUse are
    // routine. Surface only real problems.
    if (m.stopReason === "error" || m.stopReason === "aborted")
      box.appendChild(el("div", "meta warn", esc(m.errorMessage ?? `stopped: ${m.stopReason}`)));
    return box;
  }
  // One expandable row per tool call: "⚙ name" → ran-command + output.
  // No copy buttons anywhere in tool territory. `calls` maps toolCallId
  // to the ToolCall block (name + arguments) from the assistant turn.
  if (role === "toolResult") {
    const args = calls?.get(m.toolCallId);
    const params = args?.arguments ?? {};
    const ok = !m.isError;
    // Duration comes from the message itself (the file's durationMs) —
    // no memory cache; rebuilds and reloads show the same number.
    const elapsed = typeof m.durationMs === "number" ? m.durationMs : undefined;
    const d = el("details", "toolrow");
    d.appendChild(el("summary", "tgsum",
      `<span class="tstat ${ok ? "ok" : "err"}">${ok ? "✓" : "✗"}</span> ` +
      esc(toolSummary(m.toolName ?? "tool", params)) +
      (elapsed != null ? ` <span class="telapsed">· ${fmtMs(elapsed)}</span>` : "")));
    const diff = editDiff(m.toolName ?? "", params);
    if (diff) {
      d.appendChild(diff);
    } else {
      const ran = args?.arguments ? esc(JSON.stringify(args.arguments)).slice(0, 500) : "";
      const out = textOf(m.content).slice(0, 2000);
      if (ran) d.appendChild(el("div", "tgrun", `<code>${ran}</code>`));
      if (out) d.appendChild(el("div", "tgout", renderMd(out)));
    }
    (d as any)._diff = { tool: m.toolName ?? "tool", path: params.path ?? (m.toolName ?? "tool"), args: params, out: textOf(m.content).slice(0, 8000) };
    wireCopy(d);
    return d;
  }
  if (role === "bashExecution") {
    const d = el("details", "toolrow");
    d.appendChild(el("summary", "tgsum", `<span class="tstat ok">✓</span> $ ${esc((m.command ?? "bash").slice(0, 80))}`));
    d.appendChild(el("div", "tgrun", `<code>$ ${esc(m.command ?? "")}</code>`));
    if (m.output) d.appendChild(el("div", "tgout", `<pre><code>${esc(m.output.slice(0, 2000))}</code></pre>`));
    (d as any)._diff = { tool: "bash", path: "bash", args: {}, out: (m.output ?? "").slice(0, 8000) };
    return d;
  }
  if (role === "compactionSummary" || role === "branchSummary") {
    return el("div", "msg sys", `<em>summary:</em> ${esc((m.summary ?? "").slice(0, 500))}`);
  }
  return el("div", "msg sys", esc(`[${role}]`));
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- jobs via pi-jobs: native sidebar ----
// The DB is the source of truth, scoped per session (pi-jobs records
// the submitting session file on every job). The panel renders
// list_session_jobs directly — no message scraping, no tombstones, no
// pid probes. Chat cards below are stateless receipts; live state lives
// here. kind split: a session-jsonl log means the pi-subagent recipe
// (Agents tab), anything else is a plain background process.
type JobInfo = { id: string; label: string; state: string; kind: "agent" | "proc"; startedAt?: number; durationMs?: number; runId?: string; pid?: number; logFile?: string; exitCode?: number; command?: string };
let jobRows: JobInfo[] = [];

function kindOf(d: any): "agent" | "proc" {
  if (typeof d.logFile === "string" && d.logFile.endsWith(".jsonl")) return "agent";
  if (typeof d.command === "string" && d.command.includes("pi --session")) return "agent";
  return "proc";
}

let jobsFetchInFlight = false;
let lastJobsFetch = 0;
// Re-read this session's jobs from the DB (scoped by session file).
// Prunes selections for vanished rows; safe to call from any trigger.
async function refreshJobs(force = false): Promise<void> {
  const file = curFile ?? "";
  if (!file) {
    if (jobRows.length) {
      jobRows = [];
      updateAgentsBtn();
      if (agentsVisible()) renderAgents();
      if (procsVisible()) renderProcs();
    }
    return;
  }
  if (jobsFetchInFlight) return;
  if (!force && Date.now() - lastJobsFetch < 5000) return;
  lastJobsFetch = Date.now();
  jobsFetchInFlight = true;
  try {
    const data = await sessionJobs.list(file);
    if ((curFile ?? "") !== file) return; // moved on: drop stale fetch
    const rows: JobInfo[] = ((data as any).jobs ?? []).map((j: any) => ({
      id: String(j.id),
      label: String(j.label ?? j.id),
      state: String(j.state ?? "running"),
      kind: j.kind === "proc" ? "proc" : "agent",
      ...(typeof j.startedAt === "number" ? { startedAt: j.startedAt } : {}),
      ...(typeof j.durationMs === "number" ? { durationMs: j.durationMs } : {}),
      ...(typeof j.runId === "string" ? { runId: j.runId } : {}),
      ...(typeof j.pid === "number" ? { pid: j.pid } : {}),
      ...(typeof j.logFile === "string" && j.logFile ? { logFile: j.logFile } : {}),
      ...(typeof j.exitCode === "number" ? { exitCode: j.exitCode } : {}),
    }));
    jobRows = rows;
    if (selJob && !rows.some((r) => r.id === selJob)) {
      selJob = null;
      detailCount = -1;
    }
    if (selProc && !rows.some((r) => r.id === selProc)) selProc = null;
    updateAgentsBtn();
    if (agentsVisible()) renderAgents();
    if (procsVisible()) renderProcs();
  } catch { /* backend without list_session_jobs: panels stay empty */ }
  finally { jobsFetchInFlight = false; }
}
function scheduleJobsRefresh(): void {
  void refreshJobs();
}

function jobElapsed(s: JobInfo): string {
  const ms = typeof s.durationMs === "number" ? s.durationMs
    : typeof s.startedAt === "number" ? Date.now() - s.startedAt : -1;
  if (ms < 0) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function jobDot(state: string): string {
  const cls = state === "running" ? "running" : state === "done" ? "done" : state === "lost" ? "lost" : "stopped";
  const glyph = state === "running" ? "◌" : state === "done" ? "●" : state === "lost" ? "○" : "■";
  return `<span class="sdot ${cls}">${glyph}</span>`;
}

function jobSummaryHTML(s: JobInfo): string {
  const running = s.state === "running";
  const isProc = s.kind === "proc";
  // Actions target the JOB (kills its running runs); deletes bury the row.
  // pi-jobs has no steering — running rows offer stop only.
  const exit = isProc && typeof s.exitCode === "number" ? `<span class="spexit">exit ${s.exitCode}</span>` : "";
  const acts = running
    ? `<span class="spacts">` +
      `<button class="sstop" data-id="${esc(s.id)}" title="Stop this ${isProc ? "process" : "subagent"}">stop</button></span>`
    : "";
  return jobDot(s.state) +
    `<span class="splabel">${esc(s.label)}</span>` +
    `<span class="spsid">${esc(s.id.slice(-6))}</span>` +
    `<span class="spelapsed">${esc(jobElapsed(s))}</span>` +
    exit + acts;
}

// A done/stopped notice supersedes its dispatch receipt: morph the
// summary in place (state, elapsed, buttons) so no stale "running +
// stop" lingers. Receipts never grow a body — detail lives in the panel.
function jobCard(m: any): HTMLElement {
  const ct: string = m.customType ?? "";
  const isJob = ct.startsWith("job-");
  const d = m.details ?? {};
  // Delete + stop confirmations never render (the row vanishing or its
  // state flipping IS the feedback). Other job notes still show.
  if ((ct === "job-note" || ct === "spawn-note")
    && (d.deleted === true || /^Deleted \S+\.?$/.test(textOf(m.content).trim())
      || /^Killed running runs of \S+\.?$/.test(textOf(m.content).trim())
      || /^Kill signaled on \S+\.?$/.test(textOf(m.content).trim()))) {
    return el("div", "hidden");
  }
  if (ct === "job-note" || ct === "spawn-note") {
    return el("div", "msg sys spawnnote", renderMd(textOf(m.content).slice(0, 2000)));
  }
  const key: string = isJob
    ? (typeof d.jobId === "string" && d.jobId ? d.jobId : d.runId ?? "")
    : (d.id ?? "");
  // Stateless receipt: live state lives in the DB-backed side panel.
  // History cards show dispatch-time truth; completions arrive as their
  // own (silent) messages and morph nothing here.
  const kind = isJob ? kindOf(d) : (ct.startsWith("spawn-bg-") ? "proc" : "agent");
  const isProc = kind === "proc";
  const label = d.label ?? (isProc ? "process" : "subagent");
  const running = ct === "job-started" || ct === "spawn-started" || ct === "spawn-bg-started";
  const state = running ? "running" : (d.status ?? (ct.endsWith("-done") ? "done" : "stopped"));
  const info: JobInfo = {
    id: key, label, state, kind: isProc ? "proc" : "agent",
    ...(typeof d.durationMs === "number" ? { durationMs: d.durationMs } : {}),
    ...(typeof d.startedAt === "number" ? { startedAt: d.startedAt } : {}),
    ...(typeof d.exitCode === "number" ? { exitCode: d.exitCode } : {}),
    ...(typeof d.logFile === "string" ? { logFile: d.logFile } : {}),
  };
  const wrap = el("div", "spawncard");
  // Receipt identity is the JOB (retries morph the same receipt).
  // No expandable body — clicking jumps to the row in the side panel,
  // where the transcript/log detail lives.
  if (key) wrap.dataset.spawnId = key;
  wrap.dataset.state = state;
  wrap.dataset.kind = isProc ? "proc" : "agent";
  wrap.title = isProc ? "Open in Processes tab" : "Open in Subagents tab";
  wrap.appendChild(el("div", "spsum", jobSummaryHTML(info)));
  wrap.addEventListener("click", (e) => {
    // Stop buttons handle themselves (see the delegated send).
    if ((e.target as HTMLElement).closest?.(".sstop")) return;
    if (key) gotoJobPanel(key);
  });
  return wrap;
}

function updateAgentsBtn(): void {
  const all = jobRows;
  const n = all.filter((s) => s.state === "running").length;
  const badge = $("panebadge");
  badge.textContent = n ? String(n) : "";
  badge.classList.toggle("hidden", !n);
  const na = all.filter((s) => s.kind !== "proc" && s.state === "running").length;
  const np = all.filter((s) => s.kind === "proc" && s.state === "running").length;
  $("tabagents").textContent = na ? `Subagents ·${na}` : "Subagents";
  $("tabprocs").textContent = np ? `Processes ·${np}` : "Processes";
}

function renderAgents(): void {
  renderAgentsList();
  const t = $("agenttranscript");
  if (selJob) {
    void renderJobDetail(selJob);
  } else {
    t.innerHTML = "";
    t.dataset.detail = "";
    detailCount = -1;
  }
}

let listSig = "";

function renderAgentsList(): void {
  const body = $("agentsbody");
  $("agentstitle").textContent = "Subagents";
  const all = jobRows.filter((s) => s.kind !== "proc");
  if (!all.length) {
    listSig = "";
    body.innerHTML = "";
    body.appendChild(el("div", "msg sys", "No subagents this session. Ask Pi to start one."));
    return;
  }
  const running = all.filter((s) => s.state === "running");
  const past = all.filter((s) => s.state !== "running");
  const sig = `sel=${selJob}|` + all.map((s) => `${s.id}:${s.state}`).join("|");
  if (sig === listSig && body.dataset.sig === sig) return;
  listSig = sig;
  body.dataset.sig = sig;
  body.innerHTML = "";
  // Flat list, running first: no collapsing. One glance, everything.
  for (const s of running) body.appendChild(agentRow(s, s.id === selJob));
  for (const s of past) body.appendChild(agentRow(s, s.id === selJob));
}

function agentRow(s: JobInfo, selected: boolean): HTMLElement {
  const isProc = s.kind === "proc";
  const sub = s.state +
    (isProc && typeof s.exitCode === "number" ? ` · exit ${s.exitCode}` : "") +
    (jobElapsed(s) ? ` · ${jobElapsed(s)}` : "");
  const row = el("button", "agentrow" + (selected ? " cur" : ""),
    jobDot(s.state) +
    `<span class="fname">${esc(s.label)}</span>` +
    `<span class="fcount">${esc(sub)}</span>`) as HTMLButtonElement;
  row.title = s.id;
  row.addEventListener("click", () => isProc ? openProc(s.id) : openJob(s.id));
  const reveal = el("button", "sreveal", "chat") as HTMLButtonElement;
  reveal.title = "Reveal in chat";
  reveal.addEventListener("click", (e) => {
    e.stopPropagation();
    gotoJob(s.id);
  });
  row.appendChild(reveal);
  if (s.state === "running") {
    const x = el("button", "sstop", "stop") as HTMLButtonElement;
    x.title = isProc ? "Stop this process" : "Stop this subagent";
    // Direct send: stopPropagation here would also hide the click from
    // the document-level delegation, so don't rely on it.
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      sendJobCmd(`/job-kill ${s.id}`);
    });
    row.appendChild(x);
  }
  const del = el("button", "sdel", "×") as HTMLButtonElement;
  del.title = isProc ? "Delete this process and its log files" : "Delete this subagent and its transcript files";
  del.dataset.id = s.id;
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteJob(s.id);
  });
  row.appendChild(del);
  return row;
}

// Index ToolCall blocks by id so rows can show what ran.
function indexToolCalls(messages: any[]): Map<string, any> {
  const calls = new Map<string, any>();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === "toolCall" && b.id) calls.set(b.id, b);
    }
  }
  return calls;
}

// One message loop for main history and the subagent detail pane: same
// blocks, same order, same renderer. Callers differ only in options, so
// message-handling fixes can never land in one view and miss the other.
// (Live-vs-poll stays a caller concern: detail re-renders whole from the
// transcript file; main chat streams live elsewhere.)
function appendMsgList(
  box: HTMLElement,
  messages: any[],
  calls: Map<string, any>,
  opts: {
    // Which customs render (via msgNode).
    // Main history renders every non-silent custom; the detail pane
    // only job-* ones.
    keepCustom?: (m: any) => boolean;
    // Silent customs never render; the detail pane skips them cold.
    // Fork/revert entry ids for user bubbles (main chat only).
    takeForkId?: (text: string) => string | undefined;
    // Rendered-key dedup hook (main history only).
    onRendered?: (m: any) => void;
  } = {},
): number {
  const isTool = (m: any) => m.role === "toolResult" || m.role === "bashExecution";
  let shown = 0;
  // One Activity container per user request: thoughts and tool rows
  // interleave chronologically. A new user message starts a new one.
  let run: HTMLElement | null = null;
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") run = null;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === "thinking" && b.thinking) {
          run = runAppend(box, run, thoughtDiv(b.thinking), msgSpan(m));
        }
      }
    }
    if (isTool(m)) {
      opts.onRendered?.(m);
      run = runAppend(box, run, msgNode(m, calls), msgSpan(m));
      shown++;
      continue;
    }
    // Textless assistant turns (tool-call-only) would flash as empty
    // boxes; their content already lives in the Activity container.
    if (m.role === "assistant" && !textOf(m.content)) { opts.onRendered?.(m); continue; }
    // Silent customs never render (completions, tombstones).
    if (m.role === "custom" && (m as any).display === false) {
      opts.onRendered?.(m);
      continue;
    }
    if (m.role === "custom" && opts.keepCustom && !opts.keepCustom(m)) continue;
    // Mirror: repeats render. (Dedup was ours; pi shows them.)
    const fid = m.role === "user" ? opts.takeForkId?.(textOf(m.content)) : undefined;
    opts.onRendered?.(m);
    const n = msgNode(m, calls, fid);
    box.appendChild(n);
    // Rendered text splits the Activity stream: thoughts/tools after
    // this bubble belong to a NEW container below it, not clumped
    // into the one above. (User messages already reset; textless
    // assistant turns continued out earlier.)
    if (m.role === "assistant") run = null;
    shown++;
  }
  // Thought-only containers never earn a dropdown: unwrap them into flow.
  box.querySelectorAll("details.runact").forEach((r) => maybeUnwrapRun(r as HTMLElement));
  // History groups stamp time from the file's own timestamps.
  box.querySelectorAll("details.runact").forEach((r) => stampRunTime(r as HTMLElement));
  return shown;
}

// One transcript at a time: click a child → its full session transcript
// renders here (same renderer as chat). Running ones re-poll; the count
// guard avoids clobbering scroll when nothing changed.
let selJob: string | null = null;
let detailCount = -1;

function gotoJob(id: string): void {
  const cards = Array.from(document.querySelectorAll(`.spawncard[data-spawn-id="${CSS.escape(id)}"]`)) as HTMLElement[];
  const card = cards[cards.length - 1];
  if (!card) return;
  card.scrollIntoView({ block: "center" });
}

// Chat receipt → side panel: open the owning tab and select the row, so
// the transcript/log detail renders below the list.
function gotoJobPanel(tid: string): void {
  const s = jobRows.find((r) => r.id === tid);
  if (s?.kind === "proc") {
    selProc = tid;
    setSidePane("procs");
  } else {
    selJob = tid;
    detailCount = -1;
    setSidePane("agents");
  }
}

function openJob(id: string): void {
  // Split view: transcript renders below the list, no navigation.
  // Clicking the selected row again collapses its transcript.
  selJob = selJob === id ? null : id;
  detailCount = -1;
  renderAgents();
}

// Throttle for the transcript re-read below: the 5s elapsed ticker
// re-renders the panel, and without this every beat re-reads + re-parses
// the whole file even when nothing changed. Selection changes force via
// detailCount = -1 (see openJob); content changes apply on the next
// beat (≤5s lag in a side panel, main chat stays live via events).
let lastDetailRead = 0;
async function renderJobDetail(id: string): Promise<void> {
  const body = $("agenttranscript");
  if (detailCount >= 0 && body.dataset.detail === id && Date.now() - lastDetailRead < 5000) return;
  lastDetailRead = Date.now();
  let messages: any[] = [];
  try {
    const data = await jobTranscript.read(id);
    messages = data.messages ?? [];
  } catch (e: any) {
    body.innerHTML = "";
    body.dataset.detail = "";
    body.appendChild(el("div", "msg sys", esc(`transcript unavailable: ${e.message ?? e}`)));
    return;
  }
  // Selected child may have finished since: keep the header honest.
  if (selJob !== id) return;
  if (detailCount === messages.length && body.dataset.detail === id) return;
  detailCount = messages.length;
  const keepScroll = body.scrollTop;
  const nearBottom = body.scrollHeight - keepScroll - body.clientHeight < 120 || !body.hasChildNodes();
  body.innerHTML = "";
  body.dataset.detail = id;
  const calls = indexToolCalls(messages);
  // Borrow the chat renderer; quarantine its Activity-container pointer
  // so detail containers never leak into the main view's run state.
  const keepRun = lastRun;
  lastRun = null;
  try {
    const shown = appendMsgList(body, messages, calls, {
      keepCustom: (m) => typeof m.customType === "string"
        && (m.customType.startsWith("job-") || m.customType.startsWith("spawn-")),
    });
    if (!shown) body.appendChild(el("div", "msg sys", "No transcript yet — child hasn't produced output."));
    // No collectEdits here: the Changes pane belongs to the main session.
    // Collecting the child's edits would wipe and refill it with another
    // session's files (same reason lastRun is quarantined above).
    wireCopy(body);
  } finally {
    lastRun = keepRun;
  }
  if (nearBottom) body.scrollTop = body.scrollHeight;
  else body.scrollTop = keepScroll;
}

// ---- background processes tab (plain jobs) ------------------------------------
// Same index map as subagents, filtered on kind === "proc". Detail is a
// live log tail (read_job_log), not a transcript: plain <pre>, same 5s
// re-poll throttle as the agents panel.
function renderProcs(): void {
  renderProcsList();
  const t = $("proctranscript");
  if (selProc) {
    void renderProcDetail(selProc);
  } else {
    t.innerHTML = "";
    t.dataset.detail = "";
    t.dataset.key = "";
  }
}

let procListSig = "";
function renderProcsList(): void {
  const body = $("procsbody");
  $("procstitle").textContent = "Processes";
  const all = jobRows.filter((s) => s.kind === "proc");
  if (!all.length) {
    procListSig = "";
    body.innerHTML = "";
    body.appendChild(el("div", "msg sys", "No background processes this session."));
    return;
  }
  const running = all.filter((s) => s.state === "running");
  const past = all.filter((s) => s.state !== "running");
  const sig = `sel=${selProc}|` + all.map((s) => `${s.id}:${s.state}`).join("|");
  if (sig === procListSig && body.dataset.sig === sig) return;
  procListSig = sig;
  body.dataset.sig = sig;
  body.innerHTML = "";
  // Flat list, running first: no collapsing. One glance, everything.
  for (const s of running) body.appendChild(agentRow(s, s.id === selProc));
  for (const s of past) body.appendChild(agentRow(s, s.id === selProc));
}

let selProc: string | null = null;
function openProc(id: string): void {
  // Split view: log tail renders below the list, no navigation.
  // Clicking the selected row again collapses it.
  selProc = selProc === id ? null : id;
  renderProcs();
}

let lastProcDetailRead = 0;
async function renderProcDetail(id: string): Promise<void> {
  const body = $("proctranscript");
  if (body.dataset.detail === id && Date.now() - lastProcDetailRead < 5000) return;
  lastProcDetailRead = Date.now();
  const s = jobRows.find((r) => r.id === id);
  let text = "";
  let size = 0;
  let truncated = false;
  try {
    // Backend resolves the job id to its latest run's log server-side.
    const data = await jobLog.read(id);
    text = data.text ?? "";
    size = data.size ?? 0;
    truncated = !!data.truncated;
  } catch (e: any) {
    body.innerHTML = "";
    body.dataset.detail = "";
    body.dataset.key = "";
    body.appendChild(el("div", "msg sys", esc(`log unavailable: ${e.message ?? e}`)));
    return;
  }
  if (selProc !== id) return;
  const key = `${text.length}:${size}:${s?.state ?? ""}`;
  if (body.dataset.detail === id && body.dataset.key === key) return;
  body.dataset.detail = id;
  body.dataset.key = key;
  const keepScroll = body.scrollTop;
  const nearBottom = body.scrollHeight - keepScroll - body.clientHeight < 120 || !body.hasChildNodes();
  body.innerHTML = "";
  if (s?.logFile) body.appendChild(el("div", "msg sys", esc(s.logFile)));
  if (truncated) body.appendChild(el("div", "msg sys", esc(`… showing last ${text.length} chars of ${size}`)));
  const pre = document.createElement("pre");
  pre.textContent = text || "(no output yet)";
  body.appendChild(pre);
  if (nearBottom) body.scrollTop = body.scrollHeight;
  else body.scrollTop = keepScroll;
}

// setSidePane owns visibility now (single shared sidebar); the old
// per-pane setters are gone. Header buttons toggle their tab.

// Optimistic delete: the row vanishes now; the agent's /job-delete does
// the real work (kill + files + DB rows) and the next poll confirms.
// The confirmation note stays hidden (see jobCard) so chat stays clean.
async function deleteJob(id: string): Promise<void> {
  const file = curFile;
  jobRows = jobRows.filter((r) => r.id !== id);
  if (selJob === id) {
    selJob = null;
    detailCount = -1;
  }
  if (selProc === id) selProc = null;
  updateAgentsBtn();
  if (agentsVisible()) renderAgents();
  if (procsVisible()) renderProcs();
  try {
    await pi.prompt(cwd, `/job-delete ${id}`, undefined, viewKey || undefined);
  } catch (e: any) {
    if ((curFile ?? "") !== (file ?? "")) return; // moved on
    $("msgs").appendChild(el("div", "msg sys", esc(`delete failed: ${e.message ?? e}`)));
  }
  void refreshJobs(true);
}

// Fire-and-forget job command (handled disposition: no run starts, no
// agent_settled follows). Live job-note events append via route(); the
// delayed rebuild covers a missed event. Never touches run UI.
async function sendJobCmd(text: string): Promise<void> {
  hideCmdList();
  const sk = viewKey;
  try {
    await pi.prompt(cwd, text, undefined, sk || undefined);
    scheduleSessionsRefresh(); // job command appended: sidebar order follows
  } catch (e: any) {
    if (viewKey !== sk) return; // moved on: don't scribble on the new view
    $("msgs").appendChild(el("div", "msg sys", esc(`job command failed: ${e.message ?? e}`)));
    return;
  }
  if (!streaming) {
    setTimeout(() => {
      // Fenced to the sending session: a mid-flight switch must not
      // rebuild (and wipe the live stream of) the newly viewed session.
      if (!streaming && viewKey === sk) refreshMsgs();
    }, 1200);
  }
}

// ---- streaming ----

// Thinking indicator lives in the message flow, where the answer will
// stream — never parked in a separate row above the composer.
// dotsToEnd: content appended after the dots would strand them mid-flow
// (stream text, tool rows, late messages). Re-pin them last on every
// append so they always sit under the newest content.
function dotsToEnd(): void {
  const d = $("runstatus");
  if (d) $("msgs").appendChild(d);
}
function showThinking() {
  if (refreshActive) return; // rebuild owns the tree; dots re-arm after
  hideThinking();
  const d = el("div", "msg thinking-row", THINKING_DOTS);
  d.id = "runstatus";
  $("msgs").appendChild(d);
  pin();
}
function hideThinking() {
  $("runstatus")?.remove();
}

function route(rec: any) {
  if (!rec) return;
  // Turn boundaries gate the stream: deltas arriving after their
  // message completed (provider stragglers, IPC bursts around switches)
  // would otherwise birth a second ghost bubble of the same text.
  // message_end closes; the next turn/message/run reopens.
  if (rec.type === "turn_start" || rec.type === "agent_start") {
    streamClosed = false;
    queuedCount = 0; // held messages went live: count fallback consumed
    healStick(); // agent responded: forgive a jitter-unlatched pin
  }
  if (rec.type === "message_start") {
    streamClosed = false;
    healStick();
  }
  // A new turn starting (follow-ups, steering continuations, retries)
  // locks the composer even though no send() ran: startRun's flag is
  // per-send, but turns are per-agent. finishRun (settled / watchdog)
  // is the matching unlock. Without this the UI idles mid-turn and
  // action rows pop in prematurely.
  if (rec.type === "turn_start" || rec.type === "agent_start") {
    if (!refreshActive) {
      streaming = true;
      // A turn is work: mirror startRun's liveness marks (follow-up and
      // steered turns never pass through startRun, so without this the
      // composer locks while the sidebar dot stays dark).
      if (viewKey) noteRunLive(viewKey, true);
      if (viewPath) {
        runLive.set(viewPath, true);
        paintRunDots();
      }
      syncSendBtn();
      // New work invalidates settled rows immediately: the previous
      // turn's actions must not sit visible while the next turn streams.
      // (They return via markTurnActions at the next real settle.)
      document.querySelectorAll("#msgs .turn-tools").forEach((n) => n.remove());
    }
  }
  // Streaming deltas (wire records are delta-only).
  if (rec.type === "message_update") {
    const ev = rec.assistantMessageEvent ?? {};
    if (ev.type === "text_delta" && typeof ev.delta === "string") {
      if (streamClosed) return; // straggler from a completed message: drop      // Dots stay until the final answer (agent_settled), even while text
      // streams or tools run in gaps. No flicker clearing anywhere else.
      // First token takes the indicator's place in the flow.
      if (streamBuf === "") hideThinking();
      awaitingResponse = false; // agent output: bridge no longer needed
      streamBuf += ev.delta;
      // A history rebuild owns the tree while active: accumulate only.
      // Wiring/DOM resumes on later deltas once the rebuild lands.
      if (refreshActive) return;
      if (!streamDiv) {
        streamDiv = el("div", "msg assistant stream");
        $("msgs").appendChild(streamDiv);
      }
      // Full re-parse + relayout per token is O(n^2) on long answers and
      // janks WebKitGTK visibly. Paint at ~4Hz mid-stream; completion
      // paths (message_end/flush) always render the full text, so nothing
      // is ever lost to the throttle.
      const nowRender = Date.now();
      if (nowRender - lastStreamRender < 250 && ev.delta.length < 200) {
        dotsToEnd();
        pin();
        return;
      }
      lastStreamRender = nowRender;
      streamDiv.innerHTML = renderMd(streamBuf);
      // Throttled mid-stream wiring: local images/cards resolve while the
      // answer is still coming. Resolve-once cache keeps this to one
      // backend read per path; guards skip already-wired elements, and
      // resolved bytes inline synchronously on the next token (no flicker).
      const now = Date.now();
      if (now - lastStreamWire > 1500) {
        lastStreamWire = now;
        wireCopy(streamDiv);
      }
      dotsToEnd();
      pin();
    } else if (ev.type === "toolcall_start") {
      // Early args capture (may be partial — deltas/end refine it) so
      // rows can show what ran even for joins that missed the start.
      const tc = (ev as any).toolCall;
      if (tc && typeof tc.id === "string") liveCalls.set(tc.id, tc);
      showThinking();
    } else if (ev.type === "toolcall_end") {
      // Full name + arguments (see ToolCall shape): completes the capture.
      const tc = ev as any;
      if (tc && typeof tc.id === "string") {
        liveCalls.set(tc.id, { type: "toolCall", id: tc.id, name: tc.name, arguments: tc.arguments ?? {} });
      }
    } else if (typeof ev.type === "string" && ev.type.includes("think")) {
      if (streamClosed) return; // same straggler guard as text
      if (refreshActive) return; // partial thinks; full blocks via history
      awaitingResponse = false;
      const d = (ev as any).delta ?? (ev as any).text ?? "";
      if (typeof d === "string" && d) {
        if (!liveThinkDiv) {
          const wasNewThink = !liveRun;
          liveRun = runAppend($("msgs"), liveRun, thoughtDiv(""));
          if (wasNewThink) openFreshRun($("msgs"), liveRun as HTMLElement);
          liveThinkDiv = (liveRun as HTMLElement).querySelector(".tgbody > .runthought:last-child");
          liveThinkBuf = "";
        }
        liveThinkBuf += d;
        if (liveThinkDiv) liveThinkDiv.innerHTML = renderMd(liveThinkBuf.slice(-4000));
        dotsToEnd();
      }
    }
    return;
  }
  // Authoritative completed message (top-level per json.md).
  if (rec.type === "message_end" && rec.message) {
    if (rec.message.role === "assistant" || rec.message.role === "toolResult" || rec.message.role === "bashExecution") {
      awaitingResponse = false;
    }
    // A history rebuild in flight can't be trusted to include this
    // message (its snapshot may predate it) — buffer it and replay
    // after the rebuild, instead of dropping it into the void.
    if (refreshActive) {
      if (rec.message.role === "assistant" && Array.isArray(rec.message.content)) {
        for (const b of rec.message.content) {
          if (b && b.type === "toolCall" && b.id) liveCalls.set(b.id, b);
        }
      }
      if (!liveBuffer) liveBuffer = [];
      if (liveBuffer.length < 100) liveBuffer.push({ key: getKey(), message: rec.message });
      return;
    }
    // Dedupe against history just rendered: a message_end landing just
    // after a rebuild would otherwise double with the snapshot. Keys are
    // unique per message (response/toolCall ids, timestamps), so genuine
    // repeats still render.
    const rk = msgKey(rec.message);
    if (!renderedKeys.has(rk)) {
      renderedKeys.add(rk);
      appendMessageEnd(rec.message);
    }
    return;
  }

  if (rec.type === "tool_execution_start") {
    showThinking();
    // Live row: WHAT is running, visible for the whole execution — not
    // just dots. Morphed into the final form at toolResult completion.
    if (!refreshActive && rec && typeof rec.toolCallId === "string") {
      liveCalls.set(rec.toolCallId, { type: "toolCall", id: rec.toolCallId, name: rec.toolName, arguments: rec.args ?? {} });
      if (!liveToolRows.has(rec.toolCallId)) {
        const row = liveToolRow(rec.toolName ?? "tool", rec.args ?? {});
        // Auto-open a FRESH Activity container so the running tool is
        // actually visible (the whole point), collapsing older ones.
        // An existing container is left alone — the user may have
        // collapsed it deliberately.
        const wasNew = !liveRun;
        liveRun = runAppend($("msgs"), liveRun, row);
        if (wasNew) openFreshRun($("msgs"), liveRun as HTMLElement);
        liveToolRows.set(rec.toolCallId, row);
        dotsToEnd();
        pin();
      }
    }
    return;
  }
  // tool_execution_update intentionally has no branch: with no live body
  // there is nothing to stream into, and the completion morph renders
  // the authoritative full output. (Summary line stays the indicator.)
  if (rec.type === "tool_execution_end") {
    if (rec && typeof rec.toolCallId === "string" && typeof rec.durationMs === "number") {
      // Stamp the live row too: the completion morph below may already
      // have run (event order is end-then-result, but never assume it).
      const row = liveToolRows.get(rec.toolCallId) as HTMLElement | undefined;
      const t = row?.querySelector(":scope > summary .telapsed");
      if (t && row?.isConnected) t.textContent = `· ${fmtMs(rec.durationMs)}`;
    }
    return;
  }
  if (rec.type === "agent_settled") {
    finishRun();
    return;
  }
  // Mirror of pi's queue: authoritative {steering[], followUp[]} snapshot.
  // Already key-filtered to the viewed session upstream. Renders the
  // queued bar (edit / promote-to-steer live here now, not on bubbles).
  if (rec.type === "queue_update") {
    queuedCount = 0; // authoritative texts arrived: count superseded
    lastQueue = {
      steering: Array.isArray(rec.steering) ? rec.steering.filter((s: any) => typeof s === "string") : [],
      followUp: Array.isArray(rec.followUp) ? rec.followUp.filter((s: any) => typeof s === "string") : [],
    };
    renderQueued();
    // Queued means not quiet: settled action rows (if any) must hide
    // until the queue drains. Empty queue re-arms them via the same call.
    markTurnActions();
    return;
  }
}


function appendMessageEnd(message: any): void {
  const m = message;
  // The stream preview can never become permanent content: drop it
  // unconditionally at assistant completions and render the authoritative
  // message below. No compare, no freeze, no second bubble ever.
  if (m.role === "assistant" && streamDiv) {
    streamDiv.remove();
    streamDiv = null;
    streamBuf = "";
  }
  if (m.role === "system") return;
  // This message's stream is over: any later delta is a straggler.
  if (m.role === "assistant") streamClosed = true;
  // Remember ToolCall args so rows can show what ran.
  if (m.role === "assistant" && Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b && b.type === "toolCall" && b.id) liveCalls.set(b.id, b);
    }
    // Full thinking blocks replace the live-streamed partial version.
    liveThinkDiv?.remove();
    liveThinkDiv = null;
    liveThinkBuf = "";
  }
  if (m.role === "user") {
    // Mirror: pi echoes user messages at delivery time, in true order.
    // Always render the echo — no optimistic bubbles, no skip tokens,
    // so the transcript can never disagree with pi's own history.
    liveRun = null;
    // Echoes land before pi's fork list knows them (buttonless): patch
    // revert buttons in once the list catches up (debounced, in place).
    patchForkButtonsSoon();
  }
  if (m.role === "assistant" && Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b && b.type === "thinking" && b.thinking) {
        const wasNewThink = !liveRun;
        liveRun = runAppend($("msgs"), liveRun, thoughtDiv(b.thinking), msgSpan(m));
        if (wasNewThink) openFreshRun($("msgs"), liveRun as HTMLElement);
        dotsToEnd();
      }
    }
  }
  if (m.role === "toolResult" || m.role === "bashExecution") {
    // A running row exists: morph it into the final form in place — no
    // second row, no scroll jump. Otherwise append fresh, as before.
    // (bashExecution has no toolCallId to match on: always appended.)
    const liveRow = m.role === "toolResult" && typeof m.toolCallId === "string"
      ? liveToolRows.get(m.toolCallId)
      : undefined;
    if (liveRow && liveRow.isConnected) {
      liveToolRows.delete(m.toolCallId);
      const fresh = msgNode(m, liveCalls);
      liveRow.innerHTML = "";
      for (const kid of Array.from(fresh.childNodes)) liveRow.appendChild(kid);
      liveRow.classList.remove("liverow");
      (liveRow as any)._diff = (fresh as any)._diff;
      wireCopy(liveRow);
    } else {
      if (m.role === "toolResult" && typeof m.toolCallId === "string") liveToolRows.delete(m.toolCallId);
      const wasNewTool = !liveRun;
      liveRun = runAppend($("msgs"), liveRun, msgNode(m, liveCalls), msgSpan(m));
      if (wasNewTool) openFreshRun($("msgs"), liveRun as HTMLElement);
    }
    dotsToEnd();
    pin();
    if (m.role === "toolResult") {
      const tn = (m.toolName ?? "").toLowerCase();
      // Pane tracks file changes only (edit/write). Reads, bash and
      // friends expand inline and never touch it.
      if (tn === "edit" || tn === "write") {
        const a = liveCalls.get(m.toolCallId);
        noteDiff({ tool: m.toolName, path: a?.arguments?.path ?? tn, args: a?.arguments ?? {}, out: textOf(m.content).slice(0, 8000) });
      }
    }
    return;
  }
  if (m.role === "assistant" && (m as any).usage) noteCtxUsage((m as any).usage);
  if (m.role === "assistant" && !textOf(m.content)) return;
  // Job completions (display:false) carry no card-worthy content —
  // the DB-backed panel refetches instead. Notes still render below
  // (they carry human text). Legacy spawn-bg completions likewise.
  if (m.role === "custom" && (m as any).display === false
    && typeof (m as any).customType === "string"
    && ((m as any).customType === "job-done" || (m as any).customType === "job-failed"
      || (m as any).customType === "job-killed" || (m as any).customType.startsWith("spawn-bg-"))) {
    scheduleJobsRefresh();
    return;
  }
  // Any job message may change panel state (dispatch, retry, tombstone):
  // refetch (throttled) so rows follow without a rebuild.
  if (m.role === "custom" && typeof (m as any).customType === "string"
    && ((m as any).customType.startsWith("job-") || (m as any).customType.startsWith("spawn-"))) {
    scheduleJobsRefresh();
  }
  // Mirror: every assistant text renders, even exact repeats. pi shows
  // them; suppressing was our invention (streaming made benign dupes,
  // but the transcript must never disagree with pi's history).
  const n = msgNode(m, liveCalls);
  $("msgs").appendChild(n);
  wireCopy(n);
  dotsToEnd();
  pin();
  // Live text splits the Activity stream like history does: later
  // thoughts/tools start a new container below this bubble. Clear the
  // partial-think pointer too, or new deltas bleed into the old box.
  // An agent message after a group collapses it (pinned ones stay) —
  // one rule for every group, last one included.
  if (m.role === "assistant") {
    collapseAllRuns($("msgs"));
    liveRun = null;
    liveThinkDiv = null;
    liveThinkBuf = "";
  }
  markTurnActions();
  pin(); // actions row + collapse changed heights after the earlier pin
}

const THINKING_DOTS = `<span class="thinking" aria-label="thinking"><i></i><i></i><i></i></span>`;

function startRun() {
  streaming = true;
  lastTransmit = Date.now();
  if (viewKey) noteRunLive(viewKey, true);
  if (viewPath) {
    runLive.set(viewPath, true);
    paintRunDots();
  }
  streamBuf = "";
  streamClosed = false; // new turn: reopen the stream gate
  markTurnActions();
  runT0 = Date.now();
  syncSendBtn();
  showThinking();
}

const autoNamed = new Set<string>();

// ChatGPT auto-titles chats: name an unnamed session from its first prompt.
// (Deliberate divergence from pi defaults — pi's generated names are ids.)
async function maybeAutoName() {
  try {
    const s = await pi.state(cwd);
    if (s.sessionName || !s.sessionFile || autoNamed.has(s.sessionFile)) return;
    // The sidebar already scanned this file's first user text
    // (list_sessions preview window): titling needs no transcript read.
    const cached = sessCache.find((x) => x.path === s.sessionFile);
    const raw = typeof cached?.preview === "string" ? cached.preview : "";
    const text = raw.split(/\s+/).slice(0, 6).join(" ").slice(0, 48);
    if (!text) return;
    autoNamed.add(s.sessionFile);
    await pi.setName(cwd, text);
  } catch { /* best effort */ }
}

// Truth-based run watchdog, scoped to one session key: while the UI
// believes that session's run is live, poll the agent's own isStreaming
// flag. Settles the UI when the agent is actually done (normal path is
// still agent_settled; this covers lost events and dead children). Settles
// UI only while viewing that key — a background run settles on revisit
// (syncRunFlag + rebuild). Never settles while the agent reports work in
// progress, no matter how long the run takes. 30min cap so a wedged
// poller dies.
function watchRun(watchCwd: string, watchKey?: string): void {
  // The run belongs to wk; UI settles only while viewing it. State is
  // queried with the explicit key so a background run is still observed.
  const wk = watchKey ?? viewKey;
  let n = 0;
  let fails = 0;
  const t = setInterval(async () => {
    if (watchCwd !== cwd) {
      clearInterval(t);
      return;
    }
    const viewing = viewKey === wk && getKey() === wk;
    if (!streaming && viewing) {
      clearInterval(t);
      return;
    }
    if (++n > 120) {
      if (viewing) finishRun();
      clearInterval(t);
      return;
    }
    try {
      const s: any = await pi.state(watchCwd, wk || undefined);
      fails = 0; // proc answers (even mid-run): keep watching for idle
      if (s && s.isStreaming === false) {
        if (viewing) finishRun();
        clearInterval(t);
      }
    } catch {
      // State is backend-answered, so consecutive failures mean the proc
      // is gone — not a busy agent. Stop polling a corpse long before
      // the 30min cap (settle mirrors the cap path: viewing only).
      if (++fails >= 5) {
        if (viewing) finishRun();
        clearInterval(t);
      }
    }
  }, 15_000);
}

// settled=true only when the agent genuinely finished (agent_settled
// event, or watchdog-observed idle). Send-failure and cap paths pass
// false and never auto-send: firing into a dead/busy backend loops errors.
function finishRun() {
  streaming = false;
  if (viewKey) noteRunLive(viewKey, false);
  if (viewPath) {
    runLive.set(viewPath, false);
    paintRunDots();
  }
  clearMediaCache(); // regenerated files must re-read next run
  streaming = false;
  clearMediaCache(); // regenerated files must re-read next run
  if (streamDiv && streamBuf) {
    // No message_end arrived: flush what we streamed.
    const n = el("div", "msg assistant", renderMd(streamBuf));
    streamDiv.replaceWith(n);
    wireCopy(n);
  }
  streamDiv = null;
  streamBuf = "";
  syncSendBtn();
  hideThinking();
  // Retire running tool rows a crashed/aborted run left behind: no
  // permanent spinners. Rebuilt from history on revisit (completed form).
  for (const [, row] of liveToolRows) {
    if (!row.isConnected) continue;
    const sum = row.querySelector(":scope > summary");
    const diff = (row as any)._diff as { tool?: string; args?: any } | undefined;
    if (sum) {
      sum.innerHTML = `<span class="tstat">■</span> ` +
        esc(toolSummary(diff?.tool ?? "tool", diff?.args ?? {})) +
        ` <span class="telapsed">· ended</span>`;
    }
    row.classList.remove("liverow");
  }
  liveToolRows.clear();
  // Runs just settled: stop all pulsing and restore static labels before
  // the lastRun tail below reads _label. Open/closed untouched.
  calmRuns($("msgs"));
  // Follow-up bridge: turn A settled with our message accepted but turn
  // B silent so far — stay visibly working instead of dead idle. Any
  // agent output, abort, or 90s clears it; first token hides dots anyway.
  if (awaitingResponse) {
    awaitingResponse = false;
    showThinking();
    setTimeout(() => {
      if (!streaming) hideThinking();
    }, 90_000);
  }
  pin();
  markTurnActions();
  // No settle-collapse here: the last group follows the same rule as
  // every other — it collapses when the next agent message lands.
  if (lastRun && runT0 > 0) {
    // Thought-only tail: unwrap into flow instead of labeling a box.
    maybeUnwrapRun(lastRun);
    const sum = lastRun.isConnected ? lastRun.querySelector(":scope > summary") : null;
    if (sum) {
      // Group span from the file's timestamps; omitted when unknown
      // (still running) — never the memory wall clock.
      const rs = runSecs(lastRun);
      const secs = rs == null ? "" : ` · ${rs.toFixed(1)}s`;
      const label = (((lastRun as any)._label as string) || "Activity");
      // The label already breaks down what ran — only time and failures
      // are appended here.
      const nFail = lastRun.querySelectorAll(":scope .tgbody .tstat.err").length;
      sum.innerHTML = `<span class="tgsum-txt">${esc(label)}` +
        `${secs}</span>` +
        `${nFail ? ` <span class="tstat err">· ${nFail} failed</span>` : ""} ${CHEV}`;
    }
    lastRun = null;
  }
  pin(); // label/actions/collapse changed heights after the earlier pin
  // Definitive scroll AFTER paint: fonts, images and late layout all
  // land before this fires, so one pin catches everything trailing.
  // (pin is a no-op if you scrolled up to read.)
  requestAnimationFrame(() => requestAnimationFrame(() => pin()));
  maybeAutoName().finally(() => refreshLight());
}

// First message sent, file not yet on disk: optimistic sidebar row.
// Set at send time (your action), cleared on view change or landing.
let pendingSend: { title: string; at: number } | null = null;
// Synchronous optimistic row: no API wait, no polling. Rebuilds wipe
// and re-add it via refreshSessions until the real entry lands.
function paintPendingRow(): void {
  if (!pendingSend) return;
  const list = $("sesslist");
  if (list.querySelector(":scope > .sess.pending")) return;
  const d = el("div", "sess pending",
    `<div class="stitle">${esc(pendingSend.title)}</div><div class="ssub">sending…</div>`);
  list.prepend(d);
}

// Cross-session run tracking (sidebar dots): path -> live. Fed by the
// status channel (background agent_start/settled) plus a snapshot on
// every sidebar refresh. The viewed session is driven by run events
// directly; this map covers everything else.
const runLive = new Map<string, boolean>();
let lastBootId = "";
// Session file -> live proc key. A run keeps the key it started with
// (fresh id); switching by file path must reattach to THAT proc,
// not spawn an idle duplicate that reports a dead-quiet session.
const fileToKey = new Map<string, string>();
// Reverse lookup: live proc key -> session file (procs keep the key
// they started with, so fresh-id runs map back to their file row).
function fileForProc(procKey: string): string | null {
  for (const [f, k] of fileToKey) if (k === procKey) return f;
  return null;
}
// Single choke point for event-driven liveness. runLive is keyed by
// session FILE (rows match on file path), but backend events carry PROC
// keys (fresh ids for app-started chats) — storing the raw proc key
// alone never matches a row and the dot never lights. Mirror both.
function noteRunLive(procKey: string, live: boolean): void {
  runLive.set(procKey, live);
  if (procKey.includes("/")) {
    fileToKey.set(procKey, procKey);
  } else {
    const f = fileForProc(procKey);
    if (f) runLive.set(f, live);
  }
  paintRunDots();
}
function paintRunDots(): void {
  document.querySelectorAll("#sesslist .sess").forEach((d) => {
    const p = (d as HTMLElement).title;
    const live = !!p && runLive.get(p) === true;
    d.classList.toggle("live", live);
  });
}

let sessRefreshTimer: ReturnType<typeof setTimeout> | null = null;
// Sidebar order comes from file mtimes, so it goes stale between
// re-lists. Sends and background settles don't re-list (only view
// changes and viewed settles do) — schedule a trailing re-list so the
// sidebar follows activity within ~a second. Debounced: rapid-fire
// events collapse into one backend list call. Skipped in direct mode
// (no backend sessions listed there).
function scheduleSessionsRefresh(): void {
  if (directMode) return;
  if (sessRefreshTimer) return;
  sessRefreshTimer = setTimeout(() => {
    sessRefreshTimer = null;
    void refreshSessions();
  }, 1200);
}
async function refreshSessions() {
  hideSessMenu(); // rows rebuild: any open menu points at stale nodes
  try {
    sessCache = await sessions.list(cwd);
  } catch {
    sessCache = [];
    return;
  }
  // Optimistic row for a just-sent first message: pi materializes the
  // file on first model activity, but the chat exists from YOUR send.
  // Display-only (no click, no delete — nothing exists on disk yet);
  // replaced by the real entry once listed.
  if (pendingSend) {
    try {
      const s: any = await pi.state(cwd);
      const f: string | null = s?.sessionFile ?? null;
      // Live file mapping: the proc key here may still be the fresh id,
      // but rows match on file path. Keep both pointed at the truth.
      if (f && streaming) runLive.set(f, true);
      if (f) fileToKey.set(f, viewKey);
      if (f && sessCache.some((x) => x.path === f)) {
        pendingSend = null; // landed: real entry takes over
      } else if (!f && !streaming) {
        pendingSend = null; // settled with no file (aborted/handled): nothing coming
      } else {
        sessCache.unshift({
          path: f ?? "",
          id: s?.sessionId ?? "",
          timestamp: new Date(pendingSend.at).toISOString(),
          updated: new Date(pendingSend.at).toISOString(),
          cwd,
          name: pendingSend.title,
          preview: null,
        });
      }
    } catch { /* pi starting */ }
  }
  // Merge cross-session run states (cheap map read, no pi traffic).
  // Backend keys are proc keys: file paths for resumed sessions,
  // fresh ids for new chats. Fresh ids resolve via one state call each
  // (only for live ones — usually zero or one). Entries self-correct
  // on the next event or snapshot. A backend reboot (bootId change)
  // clears everything: supervised runs don't survive it.
  // (Old backends return a bare array: accept it, skip the boot check.)
  try {
    const snapRaw: any = await runStates.snapshot();
    const snap = Array.isArray(snapRaw) ? snapRaw : snapRaw?.runs ?? [];
    if (!Array.isArray(snapRaw) && typeof snapRaw?.bootId === "string") {
      if (snapRaw.bootId !== lastBootId) {
        lastBootId = snapRaw.bootId;
        runLive.clear();
      }
    }
    const next = new Map<string, boolean>();
    for (const s of snap) {
      if (s.tag && s.tag !== "main") continue;
      if (!s.key || !s.streaming) continue;
      if (s.key.includes("/")) {
        next.set(s.key, true);
        fileToKey.set(s.key, s.key);
      } else {
        try {
          const st: any = await pi.state(cwd, s.key);
          if (st?.sessionFile) {
            next.set(st.sessionFile, true);
            fileToKey.set(st.sessionFile, s.key);
          }
        } catch { /* proc gone */ }
      }
    }
    runLive.clear();
    for (const [k, v] of next) runLive.set(k, v);
    // Re-apply the viewed session's authoritative local state.
    if (viewKey && viewKey.includes("/")) runLive.set(viewKey, streaming);
  } catch { /* backend without pi_states: skip */ }
  const f = ($("sessfilter") as HTMLInputElement).value.toLowerCase();
  const list = $("sesslist");
  // Rebuilds run after every finish/switch: preserve sidebar scroll or
  // a long chat list snaps to top under the user each time.
  const keepScroll = list.scrollTop;
  list.innerHTML = "";
  for (const s of sessCache) {
    // Never spoken in, not live: fresh new_session or aborted-instantly
    // leftovers with no name and no user text. Not chats yet — hide.
    // Live sessions are exempt: pi buffers file writes, so a running
    // chat's file can momentarily lack its user text.
    if (!s.name && !s.preview && runLive.get(s.path) !== true) continue;
    const label = `${s.name ?? ""} ${s.id.slice(0, 8)} ${s.timestamp} ${s.updated ?? ""}`.toLowerCase();
    if (f && !label.includes(f)) continue;
    const d = el(
      "div",
      "sess" + (s.path === (list as any)._active ? " active" : ""),
      `<div class="stitle">${esc(titleText(s))}</div>` +
        `<div class="ssub">${esc(subText(s))}</div>`
    );
    d.title = s.path;
    if (!s.path) {
      // Optimistic row: display-only. No click (nothing to open yet),
      // no delete (nothing on disk yet). The real entry replaces it.
      d.classList.add("pending");
    } else {
      d.addEventListener("click", () => switchSession(s.path));
    }
    // Claude-style row menu: hover "…" button or right-click opens a
    // floating menu (Delete lives there, red, with its own confirm
    // step). Native confirm() throws under Tauri, so the menu itself
    // hosts the confirmation — no popups, no timeouts, no overlap.
    if (s.path) {
      const more = el("button", "sdel smore", "…");
      more.title = "Session options";
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openSessMenu(s, r.left, r.bottom + 4);
      });
      d.appendChild(more);
      d.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openSessMenu(s, e.clientX, e.clientY);
      });
    }
    list.appendChild(d);
  }
  // Restore pre-rebuild scroll (clamped: rows may have come or gone).
  list.scrollTop = Math.min(keepScroll, Math.max(0, list.scrollHeight - list.clientHeight));
  paintRunDots();
}

// Floating per-session menu (Claude-style): hover "…" or right-click a
// sidebar row. One shared element, positioned at the anchor, clamped
// into the viewport. Same .dd-list chrome as the other menus.
let sessMenuEl: HTMLElement | null = null;
function sessMenuEsc(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    hideSessMenu();
  }
}
function hideSessMenu() {
  sessMenuEl?.remove();
  sessMenuEl = null;
  document.removeEventListener("keydown", sessMenuEsc, true);
}
function openSessMenu(s: SessionInfo, x: number, y: number) {
  closeDrops();
  hideSessMenu();
  const label = titleText(s);
  const m = document.createElement("div");
  m.id = "sessmenu";
  m.className = "dd-list";
  m.addEventListener("click", (e) => e.stopPropagation());
  const ren = el("div", "dd-opt", "Rename");
  ren.addEventListener("click", () => {
    m.innerHTML = "";
    m.appendChild(el("div", "sessmenu-head", "Rename session"));
    const inp = document.createElement("input");
    inp.className = "sessmenu-input";
    inp.value = s.name ?? "";
    inp.placeholder = "Name this session";
    inp.setAttribute("spellcheck", "false");
    m.appendChild(inp);
    const row = el("div", "sessmenu-row");
    const cancel = el("button", "sessmenu-btn", "Cancel");
    cancel.addEventListener("click", () => hideSessMenu());
    const save = el("button", "sessmenu-btn primary", "Save");
    const doRename = async () => {
      const name = inp.value.trim();
      hideSessMenu();
      if (!name) return;
      try {
        await sessions.rename(s.path, name);
      } catch (e: any) {
        toastErr(`rename failed: ${e.message ?? e}`);
        return;
      }
      if (s.path === curFile) $("sesstitle").textContent = name;
      refreshSessions();
    };
    save.addEventListener("click", doRename);
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") doRename();
    });
    row.appendChild(cancel);
    row.appendChild(save);
    m.appendChild(row);
    inp.focus();
    inp.select();
  });
  m.appendChild(ren);
  const del = el("div", "dd-opt danger", "Delete");
  del.addEventListener("click", () => {
    // Confirm step, inline: native confirm() throws under Tauri.
    m.innerHTML = "";
    m.appendChild(el("div", "sessmenu-head", "Delete this session?"));
    m.appendChild(el("div", "sessmenu-sub", esc(label)));
    const row = el("div", "sessmenu-row");
    const cancel = el("button", "sessmenu-btn", "Cancel");
    cancel.addEventListener("click", () => hideSessMenu());
    const yes = el("button", "sessmenu-btn danger", "Delete");
    yes.addEventListener("click", async () => {
      hideSessMenu();
      await deleteSessionFile(s);
    });
    row.appendChild(cancel);
    row.appendChild(yes);
    m.appendChild(row);
  });
  m.appendChild(del);
  document.body.appendChild(m);
  positionSessMenu(m, x, y);
  sessMenuEl = m;
  document.addEventListener("keydown", sessMenuEsc, true);
}

// Shared viewport clamp for floating menus (session + direct-chat):
// innerHeight spans behind the system bars, so reserve those insets.
function positionSessMenu(m: HTMLElement, x: number, y: number): void {
  const r = m.getBoundingClientRect();
  const cs = getComputedStyle(document.documentElement);
  const px = (v: string) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const sat = px(cs.getPropertyValue("--sat"));
  const sab = px(cs.getPropertyValue("--sab"));
  m.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
  m.style.top = Math.max(8 + sat, Math.min(y, window.innerHeight - r.height - 8 - sab)) + "px";
}
async function deleteSessionFile(s: SessionInfo) {
  const wasActive = s.path === curFile;
  try {
    await sessions.del(s.path);
  } catch (e: any) {
    toastErr(`delete failed: ${e.message ?? e}`);
    return;
  }
  // Deleting the viewed session: stop its child (it keeps running
  // otherwise, orphaned) and open a fresh one. Procs keep the key
  // they started with (fresh id), so stop by the mapped proc key —
  // the file path alone matches no proc for app-started chats.
  try {
    await stopChild(cwd, fileToKey.get(s.path) ?? s.path).catch(() => {});
  } catch { /* no child */ }
  // Drop tracking for the deleted file: stale marks would otherwise
  // linger (and a future file reusing the path would inherit them).
  runLive.delete(s.path);
  fileToKey.delete(s.path);
  if (wasActive) {
    try {
      resetRunState();
      await openFresh();
    } catch { /* fall through to refresh */ }
    refreshAll(false);
    return;
  }
  refreshSessions();
}

// ChatGPT-style titles: explicit /name wins, else first words of first prompt.
function titleText(s: SessionInfo): string {
  if (s.name) return s.name;
  const auto = (s.preview ?? "").split(/\s+/).slice(0, 6).join(" ").slice(0, 48);
  return auto || s.id.slice(0, 8);
}
function subText(s: SessionInfo): string {
  if (s.name) return (s.preview ?? "").slice(0, 90) || stamp(s);
  return stamp(s);
}
function stamp(s: SessionInfo): string {
  // Backend stamps are UTC ISO; render in the viewer's local timezone.
  const iso = s.updated ?? s.timestamp;
  const d = new Date(iso);
  if (!isNaN(d.getTime())) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  return (s.timestamp ?? "").replace("T", " ").slice(0, 19);
}

// Activity auto-collapse: only the newest container stays open. A manual
// expand pins that container (dataset.userOpen) so later collapses skip
// it; a manual close unpins. Programmatic opens go through setRunOpen
// so the toggle listener can tell them apart.
// Elements flipped programmatically: their (async) toggle events are
// ours, not the user's. A counter/microtask can't work here — toggle
// dispatches after microtasks — so track per-element until seen.
const progRunToggle = new Set<HTMLDetailsElement>();
function setRunOpen(d: HTMLDetailsElement, open: boolean): void {
  if (d.open === open) return;
  progRunToggle.add(d);
  d.open = open;
}
function collapseRuns(box: HTMLElement, except: HTMLElement | null): void {
  box.querySelectorAll(":scope > details.runact").forEach((r) => {
    calmRun(r as HTMLElement);
    if (r === except) return;
    if ((r as HTMLElement).dataset.userOpen === "1") return;
    stampRunTime(r as HTMLElement);
    setRunOpen(r as HTMLDetailsElement, false);
  });
}
// Settle a group's live state without touching open/closed: drop the
// pulsing marker and recompute the static (completed) label. Open/close
// stays the user's (or the collapse caller's) decision.
function calmRun(run: HTMLElement): void {
  if (run.dataset.live !== "1") return;
  delete run.dataset.live;
  refreshRunLabel(run);
}
function calmRuns(box: HTMLElement): void {
  box.querySelectorAll(":scope > details.runact").forEach((r) => calmRun(r as HTMLElement));
}
// Group span from the file's own message timestamps. No wall clock,
// no memory: still-running groups show no time until they close.
function runSecs(run: HTMLElement): number | null {
  const r = run as any;
  if (typeof r._ts0 === "number" && typeof r._ts1 === "number" && r._ts1 > r._ts0)
    return (r._ts1 - r._ts0) / 1000;
  return null;
}
function stampRunTime(run: HTMLElement): void {
  try {
    if (run.dataset.tstamped) return;
    const secs = runSecs(run);
    if (secs == null) return;
    const tag = secs.toFixed(1);
    const sum = run.querySelector(":scope > summary");
    if (!sum) return;
    const txt = sum.querySelector(":scope > .tgsum-txt");
    if (txt) txt.innerHTML += ` <span class="dim">· ${tag}s</span>`;
    else sum.innerHTML += ` <span class="dim">· ${tag}s</span>`;
    run.dataset.tstamped = "1";
  } catch { /* keep previous label */ }
}
// Closed-group live style: a running group never opens. The summary
// carries the latest activity with a pulsing dot; the body stays shut
// until the user opens it. Completed groups keep the old behavior
// (collapsed, static label). Only one group pulses at a time.
function openFreshRun(box: HTMLElement, run: HTMLElement): void {
  box.querySelectorAll(":scope > details.runact").forEach((r) => {
    if (r !== run) delete (r as HTMLElement).dataset.live;
  });
  run.dataset.live = "1";
  refreshRunLabel(run);
}
// Final answer / settle: collapse every Activity except user-pinned ones.
function collapseAllRuns(box: HTMLElement): void {
  collapseRuns(box, null);
}
document.addEventListener("toggle", (e) => {
  const t = e.target as HTMLElement | null;
  if (!t?.matches?.("details.runact")) return;
  if (progRunToggle.has(t as HTMLDetailsElement)) {
    progRunToggle.delete(t as HTMLDetailsElement);
    return;
  }
  if ((t as HTMLDetailsElement).open) t.dataset.userOpen = "1";
  else delete t.dataset.userOpen;
}, true);

// One collapsed "Activity" container per user request: thoughts and tool
// rows interleaved in chronological order. No counts, no copy buttons.
// A message's wall span from file fields: completion timestamp minus
// its own duration (tools) — a point for anything else. Parallel batches
// share one timestamp, so the span alone would read zero; durations
// recover the true burst width.
function msgSpan(m: any): [number, number] | undefined {
  if (typeof m?.timestamp !== "number") return undefined;
  const dur = typeof m?.durationMs === "number" ? m.durationMs : 0;
  return [m.timestamp - dur, m.timestamp];
}
function runAppend(box: HTMLElement, run: HTMLElement | null, item: HTMLElement, span?: [number, number]): HTMLElement {
  const merge = (r: HTMLElement, s: [number, number]) => {
    const o = r as any;
    if (typeof o._ts0 !== "number") { o._ts0 = s[0]; o._ts1 = s[1]; }
    else {
      o._ts0 = Math.min(o._ts0, s[0]);
      o._ts1 = Math.max(o._ts1, s[1]);
    }
  };
  if (!run) {
    run = el("details", "runact");
    run.appendChild(el("summary", "tgsum", `Activity ${CHEV}`));
    lastRun = run;
    if (span) merge(run, span);
    run.appendChild(el("div", "tgbody"));
    box.appendChild(run);
  } else if (span) {
    merge(run, span);
  }
  run.querySelector(".tgbody")!.appendChild(item);
  // Claude-style: the collapsed container says what happened instead of
  // repeating "Activity" — a thought's first sentence, or (for a pure
  // burst of tool calls with no thinking) an aggregate "Ran N commands".
  // Raw commands never become the header.
  refreshRunLabel(run);
  return run;
}

// Recompute a runact container's collapsed label from its whole body.
// Pure tool bursts name what ran (reads / edits / tool calls / commands);
// anything with thinking
// leads with the latest thought's first sentence.
function refreshRunLabel(run: HTMLElement): void {
  try {
    const body = run.querySelector(":scope > .tgbody");
    if (!body) return;
    const rows = body.querySelectorAll(":scope > details.toolrow");
    const thoughts: string[] = [];
    body.querySelectorAll(":scope > div.runthought").forEach((d) => {
      const t = (d.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t && t !== "Thought") thoughts.push(t.split(/[.?!]\s/)[0].slice(0, 110));
    });
    const live = run.dataset.live === "1";
    let base = "";
    // Live groups name the LATEST activity (it pulses in the summary);
    // completed groups keep the aggregate breakdown.
    if (thoughts.length) base = thoughts[thoughts.length - 1];
    else if (rows.length > 0) base = live ? lastToolText(rows) : toolMixLabel(rows);
    else return;
    if (!base) return;
    (run as any)._label = base;
    const sum = run.querySelector(":scope > summary");
    if (sum) {
      sum.innerHTML = `${live ? `<span class="tstat run">◌</span> ` : ""}` +
        `<span class="tgsum-txt">${esc(base)}</span> ${CHEV}`;
    }
  } catch { /* keep previous label */ }
}

// Newest tool row's one-line summary, glyphs and extra whitespace
// stripped — the group's pulse label while running.
function lastToolText(rows: NodeListOf<Element>): string {
  const last = rows[rows.length - 1];
  const t = (last.querySelector(":scope > summary")?.textContent ?? "")
    .replace(/\s+/g, " ").trim()
    .replace(/^[^A-Za-z0-9$]+/, "")
    // The pulse dot already says running — the word is noise.
    .replace(/\s·\s(running|ended)…?\s*$/, "")
    .slice(0, 120);
  return t;
}

// Explicit per-kind summary, counts only — never file names or tool
// details. Only nonzero buckets appear: read 3 files, edited 1 file,
// used 2 tools, ran 1 command.
function toolMixLabel(rows: NodeListOf<Element>): string {
  let reads = 0, edits = 0, writes = 0, tools = 0, cmds = 0;
  rows.forEach((r) => {
    const d = (r as any)._diff as { tool?: string } | undefined;
    const tn = (d?.tool ?? "").toLowerCase();
    if (tn === "read") reads++;
    else if (tn === "edit") edits++;
    else if (tn === "write") writes++;
    else if (tn === "bash" || tn === "") cmds++;
    else tools++;
  });
  const n = (c: number, one: string, many: string) =>
    c === 1 ? `1 ${one}` : `${c} ${many}`;
  const parts: string[] = [];
  if (reads) parts.push(`read ${n(reads, "file", "files")}`);
  if (edits) parts.push(`edited ${n(edits, "file", "files")}`);
  if (writes) parts.push(`wrote ${n(writes, "file", "files")}`);
  if (tools) parts.push(`used ${n(tools, "tool", "tools")}`);
  if (cmds) parts.push(`ran ${n(cmds, "command", "commands")}`);
  const s = parts.join(", ").slice(0, 140);
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// A dropdown with no tool rows behind it is chrome around plain musing —
// unwrap it into flow text. Thought-only bursts ("Clarifying capabilities…"
// with nothing run) never earn a box; the dim runthought style already
// marks them as asides.
function maybeUnwrapRun(run: HTMLElement): void {
  try {
    if (run.querySelector(":scope > .tgbody > details.toolrow")) return;
    const body = run.querySelector(":scope > .tgbody");
    const keep: Node[] = [];
    body?.childNodes.forEach((n) => {
      const t = (n.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t && t !== "Thought") keep.push(n);
    });
    if (keep.length) run.replaceWith(...keep);
    else run.remove();
  } catch { /* leave boxed */ }
}

function thoughtDiv(text: string): HTMLElement {
  if (!text.trim()) return el("div", "runthought dim", "Thought");
  return el("div", "runthought", renderMd(text.slice(0, 4000)));
}

const CHEV = `<svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

// True while a history rebuild owns #msgs. Live event appends during the
// load window would duplicate history (same message rendered live AND from
// the load) and strand the thinking dots mid-flow — route() skips DOM
// writes while set (bookkeeping maps still update).
let refreshActive = false;
// Messages that complete DURING a rebuild: the rebuild's snapshot may
// predate them, so they're buffered here and replayed (deduped) after.
// Without this, a reply landing mid-switch vanishes from the view.
let liveBuffer: any[] | null = null;
// Identity of messages already rendered (replay dedup). Response and
// tool-call ids are stable; user/custom fall back to role+text+time.
const renderedKeys = new Set<string>();
function msgKey(m: any): string {
  if (m?.role === "assistant" && typeof m.responseId === "string" && m.responseId) return `a:${m.responseId}`;
  if (m?.role === "toolResult" && typeof m.toolCallId === "string") return `t:${m.toolCallId}`;
  if (m?.role === "bashExecution") return `b:${m.command ?? ""}:${(m.output ?? "").length}`;
  // Fallback kinds have no stable ids: key on a hash of the FULL text,
  // not a 200-char prefix — two long messages sharing a prefix (pasted
  // logs, same attachment header) must not dedup each other away.
  if (m?.role === "custom") return `c:${m.customType ?? ""}:${txtKey(textOf(m.content))}`;
  return `${m?.role ?? "?"}:${m?.timestamp ?? ""}:${txtKey(textOf(m?.content))}`;
}
function txtKey(t: string): string {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return `${h}:${t.length}`;
}
function replayLiveBuffer(): void {
  const buf = liveBuffer;
  liveBuffer = null;
  if (!buf?.length) return;
  let added = 0;
  for (const e of buf) {
    // Only this view's messages: another session's rebuild may have
    // superseded us (its own replay covers those).
    if (!e || e.key !== viewKey) continue;
    const m = e.message;
    const k = msgKey(m);
    if (renderedKeys.has(k)) continue;
    renderedKeys.add(k);
    appendMessageEnd(m);
    added++;
  }
  if (added) pin();
}

let rebuildGen = 0;

// History windowing: sessions grow without bound, so the view renders the
// newest window only and pages back on demand. Windows are BYTE-budgeted
// (counts lie: one tool result can outweigh a thousand chats). histArr is
// the accumulated oldest-first window, histBytes its measured size;
// histPath keys both (file switches reset). Paging offset stays a plain
// newest-first message count (offset = already-loaded count).
const HIST_INITIAL_BYTES = 256 * 1024;
const HIST_PAGE_BYTES = 512 * 1024;
let histPath: string | null = null;
let histArr: any[] = [];
let histBytes = 0;
let histTotal = 0;
let histMore = false;
let histLoading = false;

// Fork entry ids for copy/revert buttons. Needs a live proc: fails fast
// with no proc, waits out a cold boot (~1s+). Fills the passed map in
// place (shared with the background repaint). Never rejects.
async function fetchForkMapInto(map: Map<string, string[]>): Promise<void> {
  try {
    const fm: any = await pi.forkMessages(cwd);
    for (const e of fm.messages ?? []) {
      if (e?.entryId && typeof e?.text === "string") {
        const k = e.text;
        if (!map.has(k)) map.set(k, []);
        map.get(k)!.push(e.entryId);
      }
    }
  } catch { /* forks unavailable; buttons fill on a later refresh */ }
}
let lastForkMap = new Map<string, string[]>();

// Post-boot fork fill: a cold switch paints from disk before ensure()
// boots the proc, so the first paint is buttonless. Gated on proc
// readiness (poll pi.ready), then refetches once and repaints (scroll
// preserved) — only if the view hasn't moved on.
async function refreshForkButtons(): Promise<void> {
  const vk = viewKey, vp = viewPath;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (viewKey !== vk || viewPath !== vp) return;
    if (await pi.ready(cwd, viewKey || undefined)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (viewKey !== vk || viewPath !== vp) return;
  const map = new Map<string, string[]>();
  await Promise.race([
    fetchForkMapInto(map),
    new Promise<void>((r) => setTimeout(() => r(), 10000)),
  ]);
  if (viewKey !== vk || viewPath !== vp || !map.size) return;
  const myGen = rebuildGen;
  const alive = () => myGen === rebuildGen && viewKey === vk;
  lastForkMap = map;
  await renderHist($("msgs"), true, alive, map);
}

let forkPatchTimer: ReturnType<typeof setTimeout> | null = null;
// Live echoes render before pi's fork list knows them. Schedule one
// hydration of entry ids; clicks resolve lazily regardless, so a single
// attempt is enough. Patch-in-place (no repaint) so open Activity rows
// and scroll position survive.
function patchForkButtonsSoon(): void {
  if (forkPatchTimer) return;
  forkPatchTimer = setTimeout(() => {
    forkPatchTimer = null;
    void patchMissingForkButtons();
  }, 800);
}
async function patchMissingForkButtons(): Promise<void> {
  const vk = viewKey, vp = viewPath;
  const box = $("msgs");
  const wraps = [...box.querySelectorAll(".umsgwrap")].filter((w) => {
    const elw = w as HTMLElement;
    if (!elw.isConnected || !elw.dataset.forkText) return false;
    const r = elw.querySelector(".act-revert") as HTMLElement | null;
    const f = elw.querySelector(".act-fork") as HTMLElement | null;
    return !r?.dataset.entry || !f?.dataset.entry;
  }) as HTMLElement[];
  if (!wraps.length) return;
  const map = new Map<string, string[]>();
  await Promise.race([
    fetchForkMapInto(map),
    new Promise<void>((r) => setTimeout(() => r(), 2000)),
  ]);
  if (viewKey !== vk || viewPath !== vp || !map.size) return;
  // Merge without duplicating: later repaints derive buttons from these
  // same maps, so each id must stay listed exactly once.
  for (const [k, v] of map) {
    const cur = lastForkMap.get(k) ?? [];
    for (const id of v) if (!cur.includes(id)) cur.push(id);
    lastForkMap.set(k, cur);
  }
  // Ids already in the DOM stay where they are: assign in DOM order,
  // skipping used, mirroring takeForkId so a later repaint agrees.
  const used = new Set<string>();
  box.querySelectorAll(".act-revert, .act-fork").forEach((b) => {
    const id = (b as HTMLElement).dataset.entry;
    if (id) used.add(id);
  });
  for (const wrap of wraps) {
    if (!wrap.isConnected) continue;
    const t = wrap.dataset.forkText ?? "";
    const ids = lastForkMap.get(t) ?? [];
    const id = ids.find((x) => !used.has(x));
    if (!id) continue;
    wrap.querySelectorAll(".act-revert, .act-fork").forEach((b) => {
      (b as HTMLElement).dataset.entry = id;
    });
    used.add(id);
  }
}

// Older-page fetch: prepends the next HIST_PAGE messages and re-renders
// the accumulated window in one pass (fork ids + spawn tracking keep
// full-load order). Scroll position survives via delta math in renderHist.
// Repaint the in-DOM Show-earlier button from the live paging state.
// renderHist builds the button from these same flags, but a flag flip
// with no render after it (success painted while still loading, a lost
// refresh race, a failed fetch) would otherwise strand it disabled at
// "Loading…" forever — with no later render coming to fix it. The
// finally below calls this on every path, so the button always reflects
// reality. Null-safe: no button, nothing to do.
function paintShowEarlierBtn(): void {
  const b = document.querySelector("#msgs .showearlier") as HTMLButtonElement | null;
  if (!b || !histMore) return;
  const more = Math.max(histTotal - histArr.length, 0);
  b.disabled = histLoading;
  b.textContent = histLoading
    ? "Loading earlier messages…"
    : more > 0 ? `Show earlier messages (${more} more)` : "Show earlier messages";
  b.onclick = histLoading ? null : () => void showEarlier();
}

async function showEarlier() {
  if (histLoading || !histMore || !histPath) return;
  histLoading = true;
  refreshActive = true;
  paintShowEarlierBtn();
  const myGen = ++rebuildGen;
  const alive = () => myGen === rebuildGen;
  try {
    const data = await sessions.read(histPath, HIST_PAGE_BYTES, histArr.length);
    if (!alive()) return; // stale page: dropped, button restored below
    // Overlap guard: the file can grow between pages (live run); offset
    // counts from newest so growth shifts indices. msgKey-dedupe (same
    // keys as the live replay path) keeps the prepend exact.
    const seen = new Set(histArr.map((m) => msgKey(m)));
    const fresh = (data.messages ?? []).filter((m: any) => !seen.has(msgKey(m)));
    histArr = [...fresh, ...histArr];
    histTotal = data.total ?? histTotal;
    histMore = !!data.has_more;
    histBytes += data.bytes ?? 0;
    scanCtxUsage(histArr);
    // The wipe below detaches any live stream preview: drop the reference
    // (keep streamBuf) so the next delta rebuilds it in the new tree.
    // Completion still renders authoritatively via replayLiveBuffer.
    streamDiv = null;
    // Flag down BEFORE paint: renderHist builds the button from this flag,
    // so painting while still loading bricks it disabled (the stuck state).
    histLoading = false;
    // Paint first with what we have (same speed as before); then refill
    // fork ids in the background — lastForkMap may be the empty remnant
    // of a cold-switch paint. Repaint only when fresh ids arrived.
    await renderHist($("msgs"), true, alive, lastForkMap);
    if (!alive()) return;
    const fmap = new Map<string, string[]>();
    await Promise.race([
      fetchForkMapInto(fmap),
      new Promise<void>((r) => setTimeout(() => r(), 1000)),
    ]);
    if (!alive() || !fmap.size) return;
    lastForkMap = fmap;
    await renderHist($("msgs"), true, alive, fmap);
  } catch (e: any) {
    // Silent failure + disabled button was the brick: surface it, the
    // button stays for retry via the finally repaint below.
    try {
      toastErr(`Couldn't load earlier messages: ${e?.message ?? e}`);
    } catch { /* last resort: stay silent */ }
  } finally {
    histLoading = false;
    if (alive()) refreshActive = false;
    paintShowEarlierBtn();
  }
}
async function refreshMsgs(): Promise<boolean> {
  const box = $("msgs");
  // No wipe here: the old view stays visible until the new window is
  // fetched (tens of ms from disk), then renderHist swaps it in. Wiping
  // first is what made every switch flash blank through the whole load.
  jobRows = [];
  // Authoritative wipe: drop live partials too (stream preview, partial
  // Activity, half-streamed thought). Post-wipe deltas rebuild cleanly;
  // without this they write into a detached tree and vanish.
  streamDiv = null;
  streamBuf = "";
  liveRun = null;
  liveThinkDiv = null;
  liveThinkBuf = "";
  hideThinking();
  refreshActive = true;
  liveBuffer = [];
  // Superseded rebuilds abort at the next await: two interleaved rebuilds
  // would otherwise both write #msgs (scrambled order) and both replay
  // the live buffer (duplicates). Only the latest finishes.
  const myGen = ++rebuildGen;
  const alive = () => myGen === rebuildGen;
  try {
    // History comes from the FILE, not the pi process: the file is the
    // truth every writer shares, so a stale, dead, or busy child can
    // never hide a reply from the view again. Fresh chats have no file
    // yet — those (and only those) read via live RPC. Windowed by bytes:
    // only the newest window loads up front (HIST_INITIAL_BYTES, or the
    // already-loaded size when refreshing); older pages arrive via
    // "show earlier" (showEarlier) — never a full-file parse + transfer
    // + render.
    const fp = viewPath ?? curFile;
    if (fp !== histPath) { histPath = fp; histArr = []; histTotal = 0; histMore = false; histBytes = 0; }
    const want = Math.max(histBytes, HIST_INITIAL_BYTES);
    if (fp) {
      try {
        const data = await sessions.read(fp, want, 0);
        histArr = data.messages ?? [];
        histTotal = data.total ?? histArr.length;
        histMore = !!data.has_more;
        histBytes = data.bytes ?? 0;
      } catch {
        const data = await pi.messages(cwd);
        histArr = data.messages ?? [];
        histTotal = histArr.length;
        histMore = false;
        histBytes = 0;
      }
    } else {
      const data = await pi.messages(cwd);
      histArr = data.messages ?? [];
      histTotal = histArr.length;
      histMore = false;
      histBytes = 0;
    }
    scanCtxUsage(histArr);
    if (!alive()) return false;
    // Fork ids need a live proc; a cold switch boots one (~1s+). Race a
    // short timeout so the transcript paints from disk immediately: warm
    // procs answer in ms (single pass, buttons included), cold ones
    // repaint with buttons when the fetch lands (scroll preserved).
    const forkByText = new Map<string, string[]>();
    lastForkMap = forkByText;
    const forkP = fetchForkMapInto(forkByText);
    const forkFast = await Promise.race([forkP.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 250))]);
    if (!alive()) return false;
    await renderHist(box, false, alive, forkByText);
    if (!forkFast) void forkP.then(() => { if (alive() && lastForkMap === forkByText) void renderHist(box, true, alive, forkByText); });
    return forkFast;
  } catch (e: any) {
    if (!alive()) return false;
    refreshActive = false;
    replayLiveBuffer();
    box.appendChild(el("div", "msg sys", esc(`could not load messages: ${e.message ?? e}`)));
    return false;
  }
}
// Windowed history render: paints the accumulated newest-first window
// (histArr) in a single pass. keepScroll preserves position when older
// pages prepend above (scroll-delta math); otherwise jumps to newest.
async function renderHist(box: HTMLElement, keepScroll: boolean, alive: () => boolean, forkMap: Map<string, string[]>) {
  // Stale renders must not touch the tree: the wipe below would blank a
  // newer generation's fresh paint (then the late fork repaint guards
  // against clobbering it via lastForkMap identity in refreshMsgs).
  if (!alive()) return;
  renderedKeys.clear();
  const sc = $("scrollwrap");
  const prevH = sc.scrollHeight, prevT = sc.scrollTop;
  box.innerHTML = "";
  const arr = histArr;
  try {
    // Entry ids so each sent message gets copy + revert + fork actions.
    // Matched by text (order-independent): index mapping breaks if pi ever
    // returns entries in any other order. Cloned per render: takeForkId
    // consumes queues, and one map serves first paint + background repaint.
    const forkByText = new Map<string, string[]>();
    for (const [k, v] of forkMap) forkByText.set(k, [...v]);
    if (!alive()) return;
    const takeForkId = (text: string): string | undefined => {
      const q = forkByText.get(text);
      return q?.length ? (q.shift() as string) : undefined;
    };
    // Index ToolCall blocks so rows can show what ran.
    const calls = indexToolCalls(arr);
    const shown = appendMsgList(box, arr, calls, {
      takeForkId,
      onRendered: (m) => renderedKeys.add(msgKey(m)),
    });
    collectEdits(arr, calls);
    if (changesVisible()) renderDiffPane();
    if (!shown) {
      const g = el("div", "greet", `<h2>Ready when you are.</h2>`);
      box.appendChild(g);
    }
    wireCopy(box);
    markTurnActions();
    // Paging affordance: older history stays on disk until asked for.
    if (histMore) {
      const more = Math.max(histTotal - histArr.length, 0);
      const btn = el("button", "showearlier",
        esc(more > 0 ? `Show earlier messages (${more} more)` : "Show earlier messages")) as HTMLButtonElement;
      btn.disabled = histLoading;
      if (histLoading) btn.textContent = "Loading earlier messages…";
      else btn.onclick = () => void showEarlier();
      box.prepend(btn);
    }
    if (keepScroll) sc.scrollTop = sc.scrollHeight - prevH + prevT;
    else sc.scrollTop = sc.scrollHeight;
    if (!alive()) return;
    refreshActive = false;
    // Replay anything that completed during the rebuild window above.
    // Deduped against what history just rendered: no drops, no doubles.
    replayLiveBuffer();
    // Panels re-read from the DB: settles that landed while away show.
    void refreshJobs(true);
  } catch (e: any) {
    if (!alive()) return;
    refreshActive = false;
    replayLiveBuffer();
    box.appendChild(el("div", "msg sys", esc(`could not load messages: ${e.message ?? e}`)));
  }
}

let curFile: string | null = null;

// ---- context-window ring (chathead) ----
// Usage comes from the latest assistant message's `usage` block
// (totalTokens ~= context consumed); the limit from get_state's
// model.contextWindow. Scan history on load, update live on
// message_end. Hover tooltip shows the full breakdown.
let ctxWindow: number | null = null;
let ctxModelName = "";
let ctxUsage: { total: number; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number } | null = null;
const CTX_CIRC = 62.83;
function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}
function setCtxWindow(n: number, modelName?: string): void {
  ctxWindow = n;
  if (modelName) ctxModelName = modelName;
  updateCtxUI();
}
function noteCtxUsage(u: any): void {
  if (!u || typeof u !== "object") return;
  const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const total = num(u.totalTokens) || num(u.total) || (num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite) + num(u.reasoning));
  if (!total) return;
  ctxUsage = { total, input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead), cacheWrite: num(u.cacheWrite), reasoning: num(u.reasoning) };
  updateCtxUI();
}
function scanCtxUsage(arr: any[]): void {
  ctxUsage = null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i]?.message ?? arr[i];
    if (m?.role === "assistant" && m?.usage) { noteCtxUsage(m.usage); return; }
  }
  updateCtxUI();
}
function updateCtxUI(): void {
  const wrap = $("ctxwrap") as HTMLElement | null;
  const arc = $("ctxarc") as unknown as SVGCircleElement | null;
  const pct = $("ctxpct") as HTMLElement | null;
  const tip = $("ctxtip") as HTMLElement | null;
  if (!wrap || !arc || !pct || !tip) return;
  if (document.body.classList.contains("direct") || !ctxWindow) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  const total = ctxUsage?.total ?? 0;
  const frac = Math.min(1, total / ctxWindow);
  arc.style.strokeDashoffset = String(CTX_CIRC * (1 - frac));
  arc.style.stroke = frac >= 0.9 ? "#e89b8b" : frac >= 0.7 ? "#e8c06b" : "#7aa2f7";
  pct.textContent = total ? `${Math.round(frac * 100)}%` : "–";
  const u = ctxUsage;
  tip.innerHTML =
    `<div class="ctx-tip-title">${esc(ctxModelName || "Context")}</div>` +
    `<div class="ctx-tip-sub">${esc(fmtTok(total))} / ${esc(fmtTok(ctxWindow))} tokens (${Math.round(frac * 100)}%)</div>` +
    (u
      ? `<div class="ctx-tip-row"><span>Input</span><span>${esc(fmtTok(u.input))}</span></div>` +
        `<div class="ctx-tip-row"><span>Cache read</span><span>${esc(fmtTok(u.cacheRead))}</span></div>` +
        `<div class="ctx-tip-row"><span>Output</span><span>${esc(fmtTok(u.output))}</span></div>` +
        (u.reasoning ? `<div class="ctx-tip-row"><span>Reasoning</span><span>${esc(fmtTok(u.reasoning))}</span></div>` : "") +
        (u.cacheWrite ? `<div class="ctx-tip-row"><span>Cache write</span><span>${esc(fmtTok(u.cacheWrite))}</span></div>` : "")
      : `<div class="ctx-tip-row"><span>No usage yet — send a message.</span></div>`) +
    (frac >= 0.9 ? `<div class="ctx-tip-warn">Near the limit — consider /compact or a fresh chat.</div>` : "");
  (wrap as HTMLElement).title = total ? `${fmtTok(total)} / ${fmtTok(ctxWindow)} tokens (${Math.round(frac * 100)}%)` : `${fmtTok(ctxWindow)} token context`;
}

async function refreshState() {
  try {
    const s = await pi.state(cwd);
    curFile = s.sessionFile ?? null;
    const cached = sessCache.find((x) => x.path === s.sessionFile);
    $("sesstitle").textContent =
      s.sessionName ?? (cached ? titleText(cached) : null) ?? "New chat";
    (listActive(s.sessionFile));
    if (s.model) syncModelSelect(s.model, s.thinkingLevel);
  } catch {
    /* pi may be starting */
  }
  syncSendBtn();
}

function listActive(path?: string) {
  ( $("sesslist") as any)._active = path ?? null;
  document.querySelectorAll("#sesslist .sess").forEach((d) => {
    d.classList.toggle("active", (d as HTMLElement).title === path);
  });
}

let allModels: any[] = [];
let allLevels: string[] = [];

// Arrow-key navigation shared by every custom menu. Moves a highlight
// among visible options; Enter picks highlighted (else first visible).
function menuMove(list: HTMLElement, dir: 1 | -1): void {
  const vis = Array.from(list.querySelectorAll(".dd-opt[data-v]")) as HTMLElement[];
  const open = vis.filter((o) => o.offsetParent !== null);
  if (!open.length) return;
  let i = open.findIndex((o) => o.classList.contains("hl"));
  if (i < 0) {
    // No highlight yet: start from the current selection, then step.
    const cur = open.findIndex((o) => o.classList.contains("cur"));
    i = cur < 0 ? (dir > 0 ? -1 : open.length) : cur;
  }
  i = Math.min(Math.max(i + dir, 0), open.length - 1);
  open.forEach((o) => o.classList.remove("hl"));
  open[i].classList.add("hl");
  open[i].scrollIntoView({ block: "nearest" });
}
function menuPick(list: HTMLElement): void {
  const hl = list.querySelector(".dd-opt.hl[data-v]") as HTMLElement | null;
  const first = list.querySelector(".dd-opt[data-v]") as HTMLElement | null;
  (hl ?? first)?.click();
}

// Autofocus a dropdown search field only where there is no touch
// keyboard to fight: on touch, focus() pops the keyboard over the just
// opened menu (adjustNothing: the view never shrinks), burying the
// options. Touch users tap an option directly, or tap the search field
// itself when they want to filter.
function focusSearch(el: HTMLInputElement): void {
  // Touch-first devices: focusing pops the keyboard over the just-opened
  // menu (adjustNothing: the view never shrinks). Media queries can't be
  // trusted here (VMs report hover-capable mice that don't exist), so gate
  // on real touch hardware. Touch users tap an option directly, or tap the
  // search field itself when they want to filter.
  if (navigator.maxTouchPoints > 0) return;
  el.focus();
}

// Mobile: the dropdown lists live inside the horizontally scrolling
// .ctools row. overflow-x:auto forces overflow-y into auto as well, which
// clips the upward-opening menus entirely. Pop them to <body> with fixed
// positioning on open (desktop keeps the CSS-anchored absolute lists).
function popMenu(list: HTMLElement, btn: HTMLElement): void {
  if (!window.matchMedia("(max-width: 768px)").matches) return;
  const r = btn.getBoundingClientRect();
  document.body.appendChild(list);
  list.style.position = "fixed";
  list.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  list.style.left = `${Math.min(Math.max(8, r.left), window.innerWidth - 268)}px`;
  list.style.right = "auto";
  list.style.width = "min(260px, calc(100vw - 16px))";
  list.style.zIndex = "90";
}

function closeDrops() {
  hideSessMenu();
  $("modellist").classList.add("hidden");
  $("thinklist").classList.add("hidden");
  $("dirlist").classList.add("hidden");
  hideCmdList();
  $("modelbtn").classList.remove("open");
  $("thinkbtn").classList.remove("open");
  $("dirbtn").classList.remove("open");
}

function syncModelSelect(cur: any, thinking?: string) {
  const id = `${cur.provider}/${cur.id ?? cur.modelId ?? ""}`;
  curModelId = id;
  const m = allModels.find((x) => `${x.provider}/${x.id}` === id);
  $("modellabel").textContent = m?.name ?? m?.id ?? id;
  markCurModel();
  // Context-window ring tracks the active model's limit (+ display name).
  if (typeof cur.contextWindow === "number" && cur.contextWindow > 0) setCtxWindow(cur.contextWindow, m?.name ?? cur.id ?? id);
  else if (typeof m?.contextWindow === "number" && m.contextWindow > 0) setCtxWindow(m.contextWindow, m?.name ?? m?.id ?? id);
  if (thinking) $("thinklabel").textContent = thinking;
  document.querySelectorAll("#thinklist .dd-opt").forEach((d) =>
    d.classList.toggle("cur", (d as HTMLElement).dataset.v === (thinking ?? $("thinklabel").textContent))
  );
}

// Visible search over the (large) model list. Filters as you type,
// Enter picks the first visible match.
function renderModelOpts() {
  const ml = $("modelopts");
  ml.innerHTML = "";
  const q = (($("modeltype") as HTMLInputElement).value || "").toLowerCase();
  const shown = allModels.filter((m) => {
    const hay = `${m.name ?? ""} ${m.provider ?? ""} ${m.id ?? ""}`.toLowerCase();
    return !q || hay.includes(q);
  });
  for (const m of shown) {
    const v = `${m.provider}/${m.id}`;
    const o = el("div", "dd-opt", esc(m.name ?? m.id));
    (o as HTMLElement).dataset.v = v;
    o.addEventListener("click", async () => {
      // Capture the cwd: a mid-flight directory switch must not retarget
      // the choice at the new session (pi.* resolves curKey lazily).
      const mc = cwd;
      closeDrops();
      try {
        await pi.setModel(mc, m.provider, m.id);
      } catch (err: any) {
        toastErr(`model switch failed: ${err.message ?? err}`);
      }
      refreshModels();
    });
    ml.appendChild(o);
  }
  if (!shown.length) ml.appendChild(el("div", "dd-opt", allModels.length ? "(no match)" : "(models unavailable)"));
  markCurModel();
}

let curModelId = "";

function markCurModel() {
  document.querySelectorAll("#modelopts .dd-opt").forEach((d) =>
    d.classList.toggle("cur", (d as HTMLElement).dataset.v === curModelId)
  );
}

async function refreshModels() {
  try {
    const data = await pi.models(cwd);
    allModels = data.models ?? [];
  } catch {
    allModels = [];
  }
  renderModelOpts();
  try {
    const data = await pi.thinkingLevels(cwd);
    allLevels = data.levels ?? ["off"];
  } catch {
    allLevels = ["off"];
  }
  renderThinkOpts();
  await refreshState();
}

function renderThinkOpts() {
  const tl = $("thinkopts");
  tl.innerHTML = "";
  const q = (($("thinktype") as HTMLInputElement).value || "").toLowerCase();
  const shown = allLevels.filter((l) => !q || l.toLowerCase().includes(q));
  for (const l of shown) {
    const o = el("div", "dd-opt", esc(l));
    (o as HTMLElement).dataset.v = l;
    o.addEventListener("click", async () => {
      const mc = cwd; // see model picker: fence against dir switches
      closeDrops();
      try {
        await pi.setThinking(mc, l);
      } catch (err: any) {
        toastErr(`thinking switch failed: ${err.message ?? err}`);
      }
      refreshModels();
    });
    tl.appendChild(o);
  }
  if (!shown.length) tl.appendChild(el("div", "dd-opt", "(no match)"));
  const cur = $("thinklabel").textContent;
  tl.querySelectorAll(".dd-opt").forEach((d) =>
    d.classList.toggle("cur", (d as HTMLElement).dataset.v === cur)
  );
}

// ---- slash commands (get_commands + local TUI equivalents) ----
// pi RPC executes /cmd via prompt(); get_commands lists extension +
// prompt-template + skill commands. Built-in TUI commands never come
// over RPC, so a small local set is handled client-side.
let allCommands: PiCommand[] = [];

async function refreshCommands(): Promise<void> {
  if (!cwd) return;
  try {
    const data = await pi.commands(cwd);
    allCommands = data?.commands ?? [];
  } catch {
    allCommands = [];
  }
  renderCmdList();
}

function localCmds(): PiCommand[] {
  return [
    { name: "new", description: "Start a new chat", source: "extension" },
    { name: "model", description: "Open model picker", source: "extension" },
    { name: "thinking", description: "Open thinking picker", source: "extension" },
    { name: "reload", description: "Reload models + commands", source: "extension" },
  ];
}

function cmdPool(): PiCommand[] {
  const seen = new Set(allCommands.map((c) => c.name));
  return [...localCmds().filter((c) => !seen.has(c.name)), ...allCommands];
}

function slashFrag(): string | null {
  const v = composerText();
  if (!v.startsWith("/")) return null;
  // Only the leading token drives completion ("/fix arg" -> "fix").
  const m = v.match(/^\/(\S*)/);
  if (m == null) return null;
  // Multiline paste: only complete when caret is still on line 1.
  const nl = v.indexOf("\n");
  if (nl >= 0 && composerCursor() > nl) return null;
  return m[1].toLowerCase();
}

function renderCmdList(): void {
  const box = $("cmdlist");
  if (!box) return;
  cmdArrowed = false;
  const frag = slashFrag();
  if (frag == null) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  const shown = cmdPool()
    .filter((c) => c.name.toLowerCase().includes(frag))
    .slice(0, 12);
  box.innerHTML = "";
  if (!shown.length) {
    box.appendChild(el("div", "dd-opt", "(no matching command — Enter to send anyway)"));
    box.classList.remove("hidden");
    return;
  }
  for (const c of shown) {
    const o = el(
      "div",
      "dd-opt cmdopt" + (box.childElementCount === 0 ? " hl" : ""),
      `<span class="cmdname">/${esc(c.name)}</span><span class="cmddesc">${esc(c.description ?? c.source)}</span>`
    );
    (o as HTMLElement).dataset.v = c.name;
    o.addEventListener("mousedown", (e) => {
      // mousedown (not click): complete before textarea blur hides us.
      e.preventDefault();
      pickCmd(c.name);
    });
    box.appendChild(o);
  }
  box.classList.remove("hidden");
}

// True once the user arrow-navigates the open popup. Enter sends by
// default (Tab completes); Enter only picks after explicit navigation.
let cmdArrowed = false;

function pickCmd(name: string): void {
  const rest = composerText().match(/^\/\S*(.*)$/s)?.[1] ?? "";
  setComposerText(`/${name}` + (rest.startsWith(" ") || rest === "" ? rest : ` ${rest}`));
  // Caret to end so args can be typed immediately.
  composerFocus();
  renderCmdList();
  syncSendBtn();
}

function hideCmdList(): void {
  $("cmdlist")?.classList.add("hidden");
}

// Returns true when the text was a local command and is fully handled.
async function runLocalCmd(text: string): Promise<boolean> {
  const m = text.match(/^\/(\S+)\s*(.*)$/s);
  if (!m) return false;
  const name = m[1].toLowerCase();
  if (name === "new") {
    cwdGen++; // invalidate any in-flight setCwd (see switchSession)
    resetRunState();
    hideCmdList();
    paintEmpty();
    try {
      await openFresh();
    } catch (e: any) {
      toastErr(`new chat failed: ${e.message ?? e}`);
    }
    setComposerText("");
    syncSendBtn();
    refreshAll(false);
    return true;
  }
  if (name === "model") {
    hideCmdList();
    setComposerText("");
    syncSendBtn();
    closeDrops();
    $("modellist").classList.remove("hidden");
    popMenu($("modellist"), $("modelbtn"));
    ($("modelbtn") as HTMLButtonElement).classList.add("open");
    renderModelOpts();
    focusSearch($("modeltype") as HTMLInputElement);
    return true;
  }
  if (name === "thinking") {
    hideCmdList();
    setComposerText("");
    syncSendBtn();
    closeDrops();
    $("thinklist").classList.remove("hidden");
    popMenu($("thinklist"), $("thinkbtn"));
    ($("thinkbtn") as HTMLButtonElement).classList.add("open");
    renderThinkOpts();
    focusSearch($("thinktype") as HTMLInputElement);
    return true;
  }
  if (name === "reload") {
    hideCmdList();
    setComposerText("");
    syncSendBtn();
    await refreshModels();
    await refreshCommands();
    $("msgs").appendChild(el("div", "msg sys", "reloaded models + commands"));
    dropToBottom();
    return true;
  }
  return false;
}

// Async: history load is awaited so late arrivers (thinking dots) can
// never land before the transcript they belong under. Callers that don't
// care may ignore the promise.
async function refreshAll(withModels: boolean): Promise<void> {
  refreshSessions();
  await refreshMsgs();
  if (withModels) await refreshModels();
  else await refreshState();
  // Commands are cheap + drive "/" completion; never block the view on them.
  refreshCommands().catch(() => {});
}

// Light refresh: sidebar + header only. The live stream already built the
// transcript in place; rebuilding it here flashes the whole view.
function refreshLight() {
  refreshSessions();
  refreshState();
}

// Viewing another session must never disturb running ones: no aborts here.
// Each session owns its pi child; switching only repoints this window at a
// different child and re-renders. Local partial UI is reset so a stale
// stream doesn't linger in the new view.

// Revert rewinds this chat in place, fork keeps both: pi always forks
// into a new file. Revert then deletes the pre-fork file so the sidebar
// keeps one entry (latest survives); fork keeps the old file so the
// sidebar shows old + new.
// Lazy fork-id resolution: icons render before pi's fork list arrives,
// so a click may need to map bubble → entry id itself. Matches by source
// text (ordinal among duplicates, mirroring takeForkId) and stashes the
// win on both buttons so the next click is instant. Null = pi didn't
// answer or hasn't ingested the echo yet — caller toasts, user retries.
async function resolveForkEntry(btn: HTMLButtonElement): Promise<string | null> {
  const vk = viewKey;
  const wrap = btn.closest(".umsgwrap") as HTMLElement | null;
  const text = wrap?.dataset.forkText;
  if (!wrap || !text) return null;
  const map = new Map<string, string[]>();
  await Promise.race([
    fetchForkMapInto(map),
    new Promise<void>((r) => setTimeout(() => r(), 8000)),
  ]);
  if (viewKey !== vk || !wrap.isConnected) return null;
  const ids = map.get(text);
  if (!ids?.length) return null;
  let id: string;
  if (ids.length === 1) {
    id = ids[0];
  } else {
    const same = [...$("msgs").querySelectorAll(".umsgwrap")].filter(
      (w) => (w as HTMLElement).dataset.forkText === text
    );
    const idx = same.indexOf(wrap);
    id = ids[Math.min(Math.max(idx, 0), ids.length - 1)] ?? ids[0];
  }
  if (!id) return null;
  wrap.querySelectorAll(".act-revert, .act-fork").forEach((b) => {
    (b as HTMLElement).dataset.entry = id;
  });
  return id;
}

let reverting = false;
async function doForkAt(entryId: string, keepBoth: boolean) {
  if (reverting) return;
  if (streaming || awaitingResponse) {
    toastErr(`wait for the run to finish before ${keepBoth ? "forking" : "reverting"}`);
    return;
  }
  reverting = true;
  // Same in-flight-setCwd invalidation as switchSession (see above).
  cwdGen++;
  try {
    resetRunState();
    const before = curFile;
    const oldKey = viewKey;
    const r: any = await pi.fork(cwd, entryId);
    if (r?.cancelled) return;
    const file = await awaitSession(cwd, before);
    // The fork switched this child; retire it and open a dedicated child
    // so the key always means the file it names.
    await stopChild(cwd, oldKey).catch(() => {});
    // The retired proc is dead: drop its marks, or the abandoned branch
    // keeps a live dot and the mapping points at a corpse.
    runLive.delete(oldKey);
    for (const [f, k] of fileToKey) {
      if (k === oldKey) fileToKey.delete(f);
    }
    if (file) {
      await ensure(cwd, file, file);
      setKey(file);
      viewKey = file;
      viewPath = file;
      curFile = file;
    }
    // Fork keeps both files; revert drops the pre-fork file so only the
    // rewound version remains. Best-effort — the new file is
    // self-contained (pi copies the root-to-leaf path into it).
    if (!keepBoth && before && file && file !== before) {
      try { await sessions.del(before); } catch { /* keep both on failure */ }
    }
    await refreshAll(false);
    if (r?.text) {
      setComposerText(r.text);
      composerFocus();
    }
  } catch (err: any) {
    toastErr(`${keepBoth ? "fork" : "revert"} failed: ${err.message ?? err}`);
  } finally {
    reverting = false;
  }
}
async function doRevert(entryId: string) { await doForkAt(entryId, false); }
async function doFork(entryId: string) { await doForkAt(entryId, true); }

// Local run state must die with the session: settled events arriving
// across a switch gap otherwise leave streaming stuck (dead UI) or bleed
// the old run into the new session's view.
function resetRunState() {
  streaming = false;
  // A queued follow-up's bridge flag belongs to its own view: without
  // this, switching sessions mid-bridge hides the new (idle) session's
  // action rows and a later finishRun shows thinking spuriously.
  awaitingResponse = false;
  clearMediaCache();
  pendingSend = null;
  freshUnsent = false;
  jobRows = [];
  selJob = null;
  selProc = null;
  detailCount = -1;
  listSig = "";
  procListSig = "";
  updateAgentsBtn();
  void refreshJobs(true);
  streamDiv?.remove();
  streamDiv = null;
  streamBuf = "";
  liveRun = null;
  liveThinkDiv = null;
  liveThinkBuf = "";
  // Fresh view, fresh run maps: stale tool args/rows belong to the old
  // session (ids are unique, so this is a leak cap as much as hygiene).
  liveCalls = new Map<string, any>();
  liveToolRows.clear();
  lastQueue = null;
  queuedCount = 0;
  $("qbar")?.replaceChildren();
  selPinned = false;
  hideCmdList();
  lastRun = null;
  diffFiles.clear();
  selKey = null;
  viewRef = null;
  if (changesVisible()) renderDiffPane();
  syncSendBtn();
  hideThinking();
}

// Viewing key: backend child this window currently talks to. For saved
// sessions it is the session file; for unsaved ones a fresh id.
let viewKey = "";
let viewPath: string | null = null;

// Fresh backend child for a brand-new session. The key/viewpoint switch
// is synchronous (instant UI); the heavy parts (spawning pi, newSession)
// run in the background. send() awaits initPromise for the viewed key,
// so a fast Enter can never land in the fresh process's stale session.
let initForKey = "";
let initPromise: Promise<void> | null = null;
// A fresh chat with nothing sent yet: the row appears on YOUR send,
// not on file landing. Set by openFresh, cleared on first prompt success.
let freshUnsent = false;
// Virgin fresh procs (opened, never sent on): rapid New-chat clicks each
// spawned a pi child and only the latest was ever viewed — the rest
// leaked forever. Retired by the next openFresh (see below).
const virginFresh = new Set<string>();
// Condemned virgins: kill orders issued while their ensure was still in
// flight (nothing registered yet, so the kill missed). The init checks
// this after ensure and retires itself instead of leaking idle. Entries
// are single-use keys — consumed on first observation, never reused.
const condemnedFresh = new Set<string>();
async function openFresh(): Promise<void> {
  const key = `fresh-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  // Retire superseded virgins first: keys with a sent message left the
  // set on send success, so anything remaining here never served a view
  // and holds no transcript — safe to stop, even mid-boot.
  for (const k of [...virginFresh]) {
    if (k !== key) {
      virginFresh.delete(k);
      // Condemn first: if its ensure hasn't registered yet the kill
      // below misses, and the init's post-ensure check retires it.
      condemnedFresh.add(k);
      stopChild(cwd, k).catch(() => {});
    }
  }
  virginFresh.add(key);
  setKey(key);
  viewKey = key;
  viewPath = null;
  curFile = null;
  initForKey = key;
  initPromise = (async () => {
    await ensure(cwd, key, null);
    if (condemnedFresh.has(key)) {
      // A newer New-chat retired us mid-boot (this check runs first:
      // condemned keys are always moved-on ones). Stop the just-spawned
      // proc instead of leaking it idle, then get out of the way.
      condemnedFresh.delete(key);
      virginFresh.delete(key);
      await stopChild(cwd, key).catch(() => {});
      return;
    }
    if (viewKey !== key) return; // user moved on: leave it alone
    setKey(key);
    await pi.newSession(cwd);
  })();
  freshUnsent = true;
  await initPromise;
}

// Instant empty view for new chats: paint first, backend catches up.
// No sidebar entry until the first prompt lands (no ghost rows).
function paintEmpty(): void {
  const box = $("msgs");
  box.innerHTML = "";
  box.appendChild(el("div", "greet", `<h2>Ready when you are.</h2>`));
  $("sesstitle").textContent = "New chat";
  listActive(undefined);
  syncSendBtn();
}

async function switchSession(path: string) {
  // Mobile: the sidebar is an overlay drawer — picking a session
  // dismisses it so the transcript is actually visible.
  if (window.matchMedia("(max-width: 768px)").matches) {
    document.body.classList.add("side-collapsed");
    ($("expandbtn") as HTMLButtonElement).classList.remove("hidden");
  }
  // Invalidate any in-flight setCwd: it would otherwise complete after us
  // and steal the view back to its own session. Last click wins.
  cwdGen++;
  // Relative embeds (./shots/…) resolve against the viewed session's own
  // cwd, which may differ from the window cwd after cross-dir navigation.
  const info = sessCache.find((x) => x.path === path);
  if (info?.cwd) setMediaBase(info.cwd);
  // Reattach to the live proc when one already serves this file (fresh
  // key from its first send). Otherwise a duplicate idle proc jobs
  // and the view reports a dead-quiet session while the real run
  // continues invisibly elsewhere.
  const key = fileToKey.get(path) ?? path;
  try {
    resetRunState();
    // Paint-first order: history reads straight from disk (no proc
    // needed), so the transcript lands in ~tens of ms. Booting a cold
    // `pi --mode rpc` child costs ~1s+ of extension loading — awaiting it
    // before the first paint is what made every cold switch stare blank.
    // Proc-dependent bits (fork buttons on a cold open, title, run dots,
    // stream reseed) fill in right after, same relative order as before:
    // rebuild, then state, then sync — so dots/stream re-arm correctly.
    // ensure failing now leaves a readable (if idle) view, not the old
    // session: reselect to retry the proc.
    setKey(key);
    viewKey = key;
    viewPath = path;
    curFile = path;
    // Optimistic chrome: highlight + title straight from the sidebar
    // cache. Both used to wait behind proc boot (refreshState), leaving
    // the fresh transcript visibly unselected for ~1s on cold switches.
    // refreshState refines both once the proc answers (live rename wins).
    listActive(path);
    const pre = sessCache.find((x) => x.path === path);
    if (pre) $("sesstitle").textContent = titleText(pre);
    refreshSessions();
    refreshCommands().catch(() => {});
    const forkFast = await refreshMsgs();
    await ensure(cwd, key, path);
    await refreshState();
    // AFTER the rebuild: re-arming here is the only order that survives.
    // Returning to a still-running session shows its thinking indicator
    // again, with the live stream continuing underneath.
    await syncRunFlag();
    // Cold paint ran with no proc: refill fork ids now that one is up.
    // Fire-and-forget — the view is already complete (dots re-armed
    // above); buttons fill in when the fetch lands. Awaiting here is
    // what made every cold switch feel late.
    if (!forkFast) void refreshForkButtons();
  } catch (e: any) {
    toastErr(`switch failed: ${e.message ?? e}`);
    // View already moved (paint-first): at least leave the header naming
    // the session actually shown. Reselect retries the proc.
    const cached = sessCache.find((x) => x.path === path);
    if (cached) $("sesstitle").textContent = titleText(cached);
    return;
  }
}

// If the session we just opened is still running server-side, reflect it
// locally so the composer locks and completion settles normally.
async function syncRunFlag() {
  try {
    const s: any = await pi.state(cwd);
    // Working = run lifecycle truth (runLive, fed by agent_start/settled
    // for every session), not just the isStreaming sample — the sample
    // can read false mid-run (between turns, long tools) while the run
    // is obviously still alive. Sidebar dot and transcript dots must agree.
    const live = !!s?.isStreaming || (viewKey !== "" && runLive.get(viewKey) === true);
    if (viewKey) {
      noteRunLive(viewKey, live);
      // Rows match on file path, not proc key: a fresh-keyed view
      // must mirror its file entry or the sidebar dot disagrees.
      if (viewPath) {
        fileToKey.set(viewPath, viewKey);
        runLive.set(viewPath, live);
      }
      paintRunDots();
    }
    if (live) {
      streaming = true;
      syncSendBtn();
      // The rebuild just ran assuming idle and left settled copy/speak
      // rows under the last reply. A live run must never show them:
      // strip first, then re-arm the thinking indicator.
      document.querySelectorAll("#msgs .turn-tools").forEach((n) => n.remove());
      showThinking();
      // The rebuild also dropped the live marker (file has no live
      // state), orphaning the activity UI: the last group would sit
      // settled while the run continues, and the next live event would
      // open a duplicate group. Re-anchor onto the last group so it
      // pulses again and appends continue inside it.
      const runs = document.querySelectorAll<HTMLElement>("#msgs > details.runact");
      const last = runs[runs.length - 1];
      if (last) {
        liveRun = last;
        last.dataset.live = "1";
        refreshRunLabel(last);
      }
    }
    // Count-only queue fallback: texts arrive via queue_update, but a
    // background queue predates our view of the session. Never invent
    // texts — show the count until an event refines it (or zero clears).
    // The count also feeds markTurnActions so settled rows stay hidden.
    if (typeof s?.pendingMessageCount === "number") {
      queuedCount = s.pendingMessageCount;
      if (s.pendingMessageCount > 0 && !lastQueue) {
        lastQueue = { steering: [], followUp: [] };
        const bar = $("qbar");
        bar.innerHTML = "";
        bar.appendChild(el("div", "qit", `<span class="qbadge">queue</span><span class="qtxt">${s.pendingMessageCount} message(s) queued with the agent…</span>`));
      } else if (s.pendingMessageCount === 0 && lastQueue && !lastQueue.steering.length && !lastQueue.followUp.length) {
        lastQueue = null;
        $("qbar")?.replaceChildren();
      }
    }
    // Reconcile settled rows with the now-known state: live strips the
    // rebuild's premature rows (no-op if stripped above); idle re-arms
    // them only when truly quiet (streaming/queue guards inside).
    markTurnActions();
  } catch { /* ignore */ }
}

// Pending uploads: files picked/pasted/dropped but not yet sent. Stored
// as data URLs client-side; uploaded at send time into the session cwd
// with paths appended to the message text. 64MB cap matches save_upload.
// Two flavors: bytes (browser file input/paste/drop — must upload) and
// path (desktop native picker/drop — real path, referenced in place).
interface PendingAttachment { name: string; dataUrl: string; size: number; kind: string; source: "bytes" | "path"; path?: string; }
const pendingAttachments: PendingAttachment[] = [];
function addFiles(files: FileList | File[]) {
  for (const f of Array.from(files)) {
    if (f.size > 64 * 1024 * 1024) { toastErr(`${f.name}: over 64MB, skipped`); continue; }
    const rd = new FileReader();
    rd.onload = () => {
      pendingAttachments.push({ name: f.name, dataUrl: String(rd.result ?? ""), size: f.size, kind: f.type, source: "bytes" });
      renderAttachbar();
    };
    rd.readAsDataURL(f);
  }
}
function addFilesByPath(paths: string[]) {
  for (const p of paths) {
    const name = p.split("/").pop() ?? p;
    pendingAttachments.push({ name, dataUrl: "", size: 0, kind: "", source: "path", path: p });
  }
  renderAttachbar();
}
function clearAttachments() { pendingAttachments.length = 0; renderAttachbar(); }
function renderAttachbar() {
  const bar = $("attachbar");
  bar.innerHTML = "";
  bar.classList.toggle("hidden", !pendingAttachments.length);
  syncSendBtn();
  pendingAttachments.forEach((a, i) => {
    const chip = el("span", "achip");
    if (a.source === "path") {
      chip.appendChild(el("span", "fext", esc((a.name.split(".").pop() ?? "file").toUpperCase().slice(0, 5))));
    } else if (a.kind.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = a.dataUrl; img.className = "athumb"; img.alt = "";
      chip.appendChild(img);
    } else if (a.kind === "application/pdf" || a.name.toLowerCase().endsWith(".pdf")) {
      const cv = document.createElement("canvas");
      cv.className = "athumbpdf";
      chip.appendChild(cv);
      try {
        const b64 = a.dataUrl.slice(a.dataUrl.indexOf(",") + 1);
        void renderPdfBytes(cv, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), 128).catch(() => {});
      } catch { /* thumbnail optional; chip remains */ }
    }
    chip.appendChild(el("span", "aname", esc(a.name)));
    const x = el("button", "ax", "×") as HTMLButtonElement;
    x.title = "Remove";
    x.onclick = () => { pendingAttachments.splice(i, 1); renderAttachbar(); };
    chip.appendChild(x);
    bar.appendChild(chip);
  });
}

async function send() {
  let text = composerText().trim();
  if (!text && !pendingAttachments.length) {
    // Empty fire while streaming still means stop (the button's job).
    if (streaming) stopOnly();
    return;
  }
  // No agent, no backend: straight to the provider.
  if (directMode) {
    await directSend(text);
    return;
  }
  // Uploads first: dropped/pasted files become paths the agent can read.
  if (pendingAttachments.length) {
    try {
      const paths: string[] = [];
      for (const a of pendingAttachments) {
        // Desktop native paths reference in place (no copy); browser
        // blobs upload into the session dir (see save_upload).
        if (a.source === "path" && a.path) { paths.push(a.path); continue; }
        const b64 = a.dataUrl.slice(a.dataUrl.indexOf(",") + 1);
        paths.push(await pi.upload(cwd, a.name, b64));
      }
      clearAttachments();
      text = (text ? text + "\n" : "") + paths.map((p) => `[attached file: ${p}]`).join("\n");
    } catch (e: any) {
      toastErr(`upload failed: ${e.message ?? e}`);
      return;
    }
  }
  const isSlash = text.startsWith("/");
  // Local commands (/new, /model, …) never reach the agent.
  if (!streaming && isSlash && (await runLocalCmd(text))) return;
  // Slash commands execute immediately via prompt() even mid-run —
  // never queue them as steer/followUp (pi rejects those).
  if (streaming) {
    if (isSlash) await sendSlashMidRun(text);
    else await sendFollowUp(text);
    return;
  }
  stick = true;
  hideCmdList();
  dropToBottom();
  // The chat exists from YOUR send: paint the row synchronously, titled
  // "New chat", before any API roundtrip. Replaced by the real entry
  // once pi writes it (a later title generator will rename it).
  if (freshUnsent && !pendingSend) {
    pendingSend = { title: "New chat", at: Date.now() };
    paintPendingRow();
  }
  // Transmit-only: the bubble appears when pi echoes (milliseconds when
  // idle). startRun's dots are the send acknowledgment. On failure the
  // text goes back to the composer instead of being lost.
  setComposerText("");
  syncSendBtn();
  $("msgs").querySelector(".greet")?.remove();
  liveRun = null;
  liveThinkDiv = null;
  liveThinkBuf = "";
  liveCalls = new Map<string, any>();
  liveToolRows.clear(); // previous run settled (rows morphed); belt up
  startRun();
  // Fence the whole send to the session it started in: viewKey/curKey
  // are mutable and a mid-send switch must abandon (restore + note),
  // never misdirect the prompt into the newly viewed session.
  const sendKey = viewKey;
  const sendPath = viewPath;
  const movedOn = () => viewKey !== sendKey;
  // Settle run UI only while still viewing this send's session (whether
  // continuously or after switching away and back). After a mid-send
  // switch the other view owns the UI; settling here would flush its
  // partial stream, kill its dots, and unlock its composer mid-run.
  // A backgrounded run settles its own view on revisit (rebuild + sync).
  const settleIfViewing = () => {
    if (!movedOn()) finishRun();
  };
  const abandon = (note: string) => {
    // Never clobber what the user typed in the new view: restore only
    // into an empty composer, and only then explain with a note.
    if (!composerText().trim()) {
      setComposerText(text);
      $("msgs").appendChild(el("div", "msg sys", esc(note)));
    }
    syncSendBtn();
    settleIfViewing();
  };
  // Fresh chat still initializing: wait for its backend first, or the
  // text lands in the new process's stale (most-recent) session.
  if (initPromise && sendKey === initForKey) {
    try {
      await initPromise;
    } catch {
      // A transient new_session failure would otherwise brick this tab:
      // every later send re-awaits the same cached rejection. Retry once
      // on the same key (same session, no routing change), then restore.
      initPromise = null;
      initForKey = "";
      try {
        await ensure(cwd, sendKey || undefined, sendPath);
        await pi.newSession(cwd);
      } catch {
        if (!composerText().trim()) setComposerText(text);
        syncSendBtn();
        if (!movedOn()) {
          $("msgs").appendChild(el("div", "msg sys", esc("new chat failed to start (kept in composer)")));
        }
        settleIfViewing();
        return;
      }
    }
  }
  if (movedOn()) {
    abandon("switched sessions before send completed (message kept in composer)");
    return;
  }
  try {
    await ensure(cwd, sendKey || undefined, sendPath);
    if (movedOn()) {
      abandon("switched sessions before send completed (message kept in composer)");
      return;
    }
    // NOTE: no setKey here — the key rides the payload (see below), so
    // the viewed session's routing is never disturbed by a background send.
  } catch (e: any) {
    // Same fence as the prompt path below: a mid-ensure switch must not
    // scribble on, or settle, the newly viewed session.
    if (!movedOn()) {
      $("msgs").appendChild(el("div", "msg sys", esc(`pi failed to start: ${e.message ?? e}`)));
      finishRun();
    }
    return;
  }
  // Transmit-only: the bubble appears when pi echoes (milliseconds when
  // idle). startRun's dots are the send acknowledgment. On failure the
  // text goes back to the composer instead of being lost.
  try {
    // Key rides the payload: lands in sendKey's session even if the
    // user has moved on. watchRun settles UI only if still viewing it.
    const res: any = await pi.prompt(cwd, text, undefined, sendKey || undefined);
    freshUnsent = false;
    virginFresh.delete(sendKey); // sent-on: no longer a leak candidate
    scheduleSessionsRefresh(); // file mtime moved: sidebar order follows
    if (movedOn()) {
      watchRun(cwd, sendKey);
      return;
    }
    if (res?.disposition === "handled") {
      // Extension command consumed the prompt: no run started, so no
      // agent_settled will ever arrive. Settle now and reload history —
      // the command's own output (if any) arrives as messages.
      // Note: handled commands add no user echo to history; what you
      // typed won't show as a bubble, only the command's output does.
      settleIfViewing();
      if (!movedOn()) await refreshMsgs();
    } else {
      // Completion arrives via agent_settled. Watchdog (not a fixed timer):
      // the old 180s safety net declared the run finished while long agents
      // were still working. Now we poll the agent's own isStreaming flag and
      // only settle the UI when it is actually done (or lost, or 30min cap).
      watchRun(cwd, sendKey);
    }
  } catch (e: any) {
    // Same fence on failure: restore + note only if still viewing.
    if (!movedOn()) {
      $("msgs").appendChild(el("div", "msg sys", esc(`send failed (kept in composer): ${e.message ?? e}`)));
      setComposerText(text);
      syncSendBtn();
    } else {
      if (!composerText().trim()) setComposerText(text);
      syncSendBtn();
    }
    settleIfViewing();
  }
  persistLastCwd();
}

// Mirror of pi's send path: transmit only, never render. The bubble appears
// when pi echoes (message_end role=user) — at delivery, in true order.
// Mid-run the echo lands when the message is accepted; idle, within ms.
// Failures restore the text to the composer instead of losing it.
async function sendFollowUp(text: string): Promise<void> {
  setComposerText("");
  lastTransmit = Date.now();
  syncSendBtn();
  stick = true;
  dropToBottom();
  // Follow-up continues the run: settled rows from the previous turn
  // must go now, not when the next message completes.
  document.querySelectorAll("#msgs .turn-tools").forEach((n) => n.remove());
  // Fenced like send(): a mid-flight switch must not requeue elsewhere.
  // The composer is shared across views: restore into it only when still
  // viewing (or when it is empty), never clobbering the new view's draft.
  const fk = viewKey;
  const fp = viewPath;
  const stillHere = () => viewKey === fk;
  const restoreFollowUp = (note: string) => {
    if (stillHere()) {
      $("msgs").appendChild(el("div", "msg sys", esc(note)));
      setComposerText(text);
    } else if (!composerText().trim()) {
      setComposerText(text);
    }
    syncSendBtn();
  };
  try {
    await ensure(cwd, fk || undefined, fp);
  } catch (e: any) {
    restoreFollowUp(`pi failed to start: ${e.message ?? e}`);
    return;
  }
  try {
    await pi.prompt(cwd, text, "followUp", fk || undefined);
    awaitingResponse = true;
    scheduleSessionsRefresh(); // file mtime moved: sidebar order follows
  } catch (e: any) {
    // (restoreFollowUp already syncs the button.)
    restoreFollowUp(`follow-up failed, kept in composer (run continues): ${e.message ?? e}`);
  }
  persistLastCwd();
}

// Slash command fired mid-run: pi runs extension commands immediately
// (no queue), so transmit via bare prompt() without touching run UI.
// No startRun/watchRun — a run is already live and owns completion.
async function sendSlashMidRun(text: string): Promise<void> {
  hideCmdList();
  dropToBottom();
  setComposerText("");
  lastTransmit = Date.now();
  syncSendBtn();
  const sk = viewKey;
  try {
    await pi.prompt(cwd, text, undefined, sk || undefined);
    scheduleSessionsRefresh(); // mid-run command appended: sidebar order follows
  } catch (e: any) {
    // Shared composer: never clobber the new view's draft on a switch.
    if (viewKey === sk) {
      $("msgs").appendChild(el("div", "msg sys", esc(`command failed: ${e.message ?? e}`)));
      setComposerText(text);
    } else if (!composerText().trim()) {
      setComposerText(text);
    }
    syncSendBtn();
  }
}

// Mirror of pi's queue: renders the authoritative queue_update snapshot
// ({steering[], followUp[]}) as a slim bar above the composer. Edit and
// promote-to-steer live here — on pi's data, not on guessed bubbles.
// clear_queue returns the held texts, so edit/promote never lose content:
// the target goes where asked, the rest are silently re-queued in order.
function renderQueued(): void {
  const bar = $("qbar");
  bar.innerHTML = "";
  const q = lastQueue;
  if (!q || (!q.steering.length && !q.followUp.length)) return;
  const items: Array<{ text: string; kind: "steer" | "followUp" }> = [
    ...q.steering.map((text) => ({ text, kind: "steer" as const })),
    ...q.followUp.map((text) => ({ text, kind: "followUp" as const })),
  ];
  for (const it of items) {
    const row = el("div", "qit");
    const badge = el("span", "qbadge" + (it.kind === "steer" ? " steer" : ""),
      esc(it.kind === "steer" ? "steer" : "follow-up"));
    const txt = el("span", "qtxt", esc(it.text));
    txt.title = it.text;
    const edit = el("button", "qedit", "edit") as HTMLButtonElement;
    edit.title = "Edit queued message";
    edit.addEventListener("click", () => editQueued(it.text, it.kind));
    row.appendChild(badge);
    row.appendChild(txt);
    row.appendChild(edit);
    if (it.kind === "followUp") {
      const promote = el("button", "qpromote", "steer") as HTMLButtonElement;
      promote.title = "Promote to steer (redirects the live run)";
      promote.addEventListener("click", () => promoteQueued(it.text));
      row.appendChild(promote);
    }
    bar.appendChild(row);
  }
}

// Edit a queued message, mirroring pi's own abort flow: clear the queue,
// restore the target to the composer, re-queue everything else untouched.
// View-fenced throughout: the composer, bar and queue state are shared
// globals, so a mid-surgery switch must neither misroute texts nor
// clobber the new view (all backend calls carry the captured key).
async function editQueued(text: string, kind: "steer" | "followUp"): Promise<void> {
  const qk = viewKey;
  const stillHere = () => viewKey === qk;
  let q: { steering: string[]; followUp: string[] };
  try {
    q = await pi.clearQueue(cwd);
  } catch (e: any) {
    if (stillHere()) {
      $("msgs").appendChild(el("div", "msg sys", esc(`queue edit failed: ${e.message ?? e}`)));
      pin();
    }
    return;
  }
  if (stillHere()) {
    lastQueue = { steering: [], followUp: [] };
    renderQueued();
  }
  const dropOnce = (arr: string[]): string[] => {
    const i = arr.indexOf(text);
    if (i < 0) return arr;
    return [...arr.slice(0, i), ...arr.slice(i + 1)];
  };
  const reSteer = kind === "steer" ? dropOnce(q.steering) : q.steering;
  const reFollow = kind === "followUp" ? dropOnce(q.followUp) : q.followUp;
  // Success buckets (identity, not text-match: duplicate queued texts are
  // legal and must not over-filter on partial failure).
  const okSteer: string[] = [];
  const okFollow: string[] = [];
  const put = async (k2: "steer" | "followUp", t: string, lost: string[]): Promise<void> => {
    try {
      if (k2 === "steer") await pi.steerMsg(cwd, t, qk || undefined);
      else await pi.followUpMsg(cwd, t, qk || undefined);
      (k2 === "steer" ? okSteer : okFollow).push(t);
    } catch {
      lost.push(t); // backend busy: surface instead of dropping silently
    }
  };
  const lost: string[] = [];
  if (stillHere()) {
    setComposerText(text);
    syncSendBtn();
    composerFocus();
  } else if (!composerText().trim()) {
    setComposerText(text);
    syncSendBtn();
  } else {
    // Switched with a draft in the composer: park the target back in
    // its own queue rather than losing it or clobbering the draft.
    await put(kind, text, lost);
  }
  for (const s of reSteer) await put("steer", s, lost);
  for (const f of reFollow) await put("followUp", f, lost);
  if (stillHere()) {
    // Exact state from known outcomes — no waiting on the next event.
    // Composer-held target and failures excluded; parked target included.
    lastQueue = { steering: [...okSteer], followUp: [...okFollow] };
    queuedCount = okSteer.length + okFollow.length;
    renderQueued();
    markTurnActions();
  }
  if (lost.length && stillHere()) {
    $("msgs").appendChild(el("div", "msg sys", esc(`queue edit: ${lost.length} message(s) could not be re-queued and were lost: ${lost.join(" / ").slice(0, 300)}`)));
    pin();
  }
}

// Promote a queued follow-up to steer: same clear + re-queue, but the
// target goes back via steer so it jumps ahead of the next model call.
// (pi has no in-place promote; clear + resubmit is its own documented
// shape for queue surgery.)
async function promoteQueued(text: string): Promise<void> {
  const qk = viewKey;
  const stillHere = () => viewKey === qk;
  let q: { steering: string[]; followUp: string[] };
  try {
    q = await pi.clearQueue(cwd);
  } catch (e: any) {
    if (stillHere()) {
      $("msgs").appendChild(el("div", "msg sys", esc(`steer failed: ${e.message ?? e}`)));
      pin();
    }
    return;
  }
  if (stillHere()) {
    lastQueue = { steering: [], followUp: [] };
    renderQueued();
  }
  const rest = q.followUp.filter((f) => f !== text);
  // Target outcomes: steered-live (still queued server-side until the
  // next turn drains it), composer-held (not queued), or parked
  // follow-up (queued). Tracked explicitly below.
  const parked: string[] = [];
  let steeredLive = false;
  try {
    await pi.steerMsg(cwd, text, qk || undefined);
    steeredLive = true;
  } catch (e: any) {
    if (stillHere()) {
      $("msgs").appendChild(el("div", "msg sys", esc(`steer failed: ${e.message ?? e}`)));
      setComposerText(text);
      syncSendBtn();
    } else if (!composerText().trim()) {
      setComposerText(text);
      syncSendBtn();
    } else {
      // Switched with a draft: re-park as follow-up on its own session
      // rather than losing it or clobbering the draft.
      try {
        await pi.followUpMsg(cwd, text, qk || undefined);
        parked.push(text);
      } catch {
        if (!composerText().trim()) {
          setComposerText(text);
          syncSendBtn();
        }
      }
    }
  }
  const lost: string[] = [];
  const okRest: string[] = [];
  for (const f of rest) {
    try {
      await pi.followUpMsg(cwd, f, qk || undefined);
      okRest.push(f);
    } catch {
      lost.push(f);
    }
  }
  if (stillHere()) {
    // Exact state from known outcomes (see editQueued). The steered
    // target IS still queued server-side (steering lane, drained next
    // turn), so it stays in the pill until an event or the turn echo
    // supersedes it — never in neither place.
    lastQueue = {
      steering: steeredLive ? [text] : [],
      followUp: [...okRest, ...parked],
    };
    queuedCount = (steeredLive ? 1 : 0) + okRest.length + parked.length;
    renderQueued();
    markTurnActions();
  }
  if (lost.length && stillHere()) {
    $("msgs").appendChild(el("div", "msg sys", esc(`promote: ${lost.length} queued message(s) could not be re-queued and were lost: ${lost.join(" / ").slice(0, 300)}`)));
    pin();
  }
}
async function persistLastCwd() {
  try {
    await config.set({ last_cwd: cwd });
  } catch { /* ignore */ }
}

function baseName(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return (i < 0 ? t : t.slice(i + 1)) || t;
}

let cwdGen = 0;

async function setCwd(next: string, save = true, resume = true) {
  const gen = ++cwdGen;
  cwd = next;
  setMediaBase(next);
  resetRunState();
  $("dirlabel").textContent = baseName(cwd) || cwd;
  ($("dirbtn") as HTMLButtonElement).title = cwd;
  syncDirMenu();
  try {
    const files = await sessions.list(cwd).catch(() => []);
    if (gen !== cwdGen) return;
    if (files.length && resume) {
      // Continue the most recent session in its own child — reattaching
      // to a live proc when one already serves it (see switchSession).
      const f = files[0].path;
      const key = fileToKey.get(f) ?? f;
      await ensure(cwd, key, f);
      if (gen !== cwdGen) return;
      setKey(key);
      viewKey = key;
      viewPath = f;
      curFile = f;
    } else {
      await openFresh();
      if (gen !== cwdGen) return;
    }
  } catch (e: any) {
    $("msgs").innerHTML = "";
    $("msgs").appendChild(el("div", "msg sys", esc(`pi failed to start in ${cwd}: ${e.message ?? e}. Is pi on PATH?`)));
    return;
  }
  if (gen !== cwdGen) return; // superseded by a newer switch
  // Subscribe here (not at the top): every early return above must leave
  // the previous subscription intact, or live updates die silently with
  // no error. Same fn reference, so the Set dedupes — no double delivery.
  unsub?.();
  unsub = onRecord(cwd, route);
  if (save) {
    try {
      const c = await config.get();
      const recents = [cwd, ...c.recents.filter((d) => d !== cwd)].slice(0, 12);
      await config.set({ last_cwd: cwd, recents });
    } catch { /* ignore */ }
    syncDirMenu();
  }
  await refreshAll(true);
  await syncRunFlag();
}

// Directory menu: recents + visible type-to-use field + browse. Same
// custom-menu chrome as the model/thinking dropdowns, no native popups.
function syncDirMenu() {
  $("dirlabel").textContent = baseName(cwd) || cwd;
  ($("dirbtn") as HTMLButtonElement).title = cwd;
  renderDirRecents();
}

function renderDirRecents() {
  config.get().then((c) => {
    const box = $("dirrecents");
    box.innerHTML = "";
    const q = (($("dirtype") as HTMLInputElement).value || "").toLowerCase();
    const defDir = c.default_dir;
    const opts = [defDir, ...c.recents.filter((d) => d !== defDir)];
    const seen = new Set<string>();
    for (const d of [cwd, ...opts]) {
      if (!d || seen.has(d)) continue;
      seen.add(d);
      if (q && !d.toLowerCase().includes(q)) continue;
      const o = el("div", "dd-opt dirrow2");
      const label = el("span", "dd-dirname", esc(d));
      label.addEventListener("click", () => {
        closeDrops();
        setCwd(d);
      });
      o.appendChild(label);
      if (d !== cwd && d !== defDir) {
        const x = el("button", "ddx", "×");
        x.title = "Remove from recents";
        x.addEventListener("click", async (e) => {
          e.stopPropagation();
          try {
            const cc = await config.get();
            await config.set({ recents: cc.recents.filter((r) => r !== d) });
          } catch { /* ignore */ }
          renderDirRecents();
        });
        o.appendChild(x);
      }
      box.appendChild(o);
    }
  }).catch(() => {});
}

// ---- settings ----

async function openSettings() {
  $("appver").textContent = `v${__APP_VERSION__}`;
  // Backend fields need a live backend; connection + direct fields are
  // local-only so Settings stays usable while the backend is down.
  let cfgSnap: any = null;
  try {
    const c = await config.get();
    cfgSnap = c;
    ($("cfg-quick") as HTMLInputElement).value = c.quickbar_hotkey;
    ($("cfg-main") as HTMLInputElement).value = c.main_hotkey;
    parseHotChords(c.quickbar_hotkey, c.main_hotkey);
    ($("cfg-dir") as HTMLInputElement).value = c.default_dir;
    ($("cfg-bg") as HTMLInputElement).checked = c.run_in_bg !== false;
  } catch { /* leave backend fields as-is */ }
  // Desktop-link fields only make sense on the phone; this-device-as-
  // server + debug stay Android-only (hidden on desktop).
  const showLocal = isAndroidApp;
  const showRemote = isAndroidApp || isServerMode;
  document.querySelectorAll(".desk-local").forEach((elm) => {
    (elm as HTMLElement).style.display = showLocal ? "" : "none";
  });
  document.querySelectorAll(".desk-remote").forEach((elm) => {
    (elm as HTMLElement).style.display = showRemote ? "" : "none";
  });
  document.querySelectorAll(".desk-debug").forEach((elm) => {
    (elm as HTMLElement).style.display = isAndroidApp ? "" : "none";
  });
  // Direct chat is a phone-only mode — desktop already has the full agent.
  document.querySelectorAll(".desk-direct").forEach((elm) => {
    (elm as HTMLElement).style.display = isAndroidApp ? "" : "none";
  });
  if (showLocal && cfgSnap) {
    ($("cfg-local-port") as HTMLInputElement).value = String(cfgSnap.remote_port || 1423);
    ($("cfg-local-token") as HTMLInputElement).value = cfgSnap.remote_token || "";
  }
  ($("cfg-remote-url") as HTMLInputElement).value = localStorage.getItem("pi-server-url") ?? "";
  ($("cfg-remote-token") as HTMLInputElement).value = localStorage.getItem("pi-server-token") ?? "";
  const d = loadDirectSettings();
  ($("cfg-direct-preset") as HTMLSelectElement).value = d.preset;
  ($("cfg-direct-url") as HTMLInputElement).value = d.baseUrl;
  ($("cfg-direct-key") as HTMLInputElement).value = d.apiKey;
  try {
    const errs: any[] = JSON.parse(localStorage.getItem("errlog") ?? "[]");
    const lines = errs.slice(-8).map((e: any) => `${e.at ?? ""} ${e.msg ?? e}`);
    const dd = loadDirectSettings();
    lines.push(`direct: preset=${dd.preset} base=${dd.baseUrl || "(empty)"} model=${dd.model || "(empty)"} key=${dd.apiKey ? `set(len=${dd.apiKey.length})` : "MISSING"}`);
    lines.push(`remote: url=${localStorage.getItem("pi-server-url") || "(empty)"} token=${localStorage.getItem("pi-server-token") ? "set" : "MISSING"}`);
    ($("cfg-debuglog") as HTMLElement).textContent = lines.join("\n") || "(no errors logged)";
  } catch {
    ($("cfg-debuglog") as HTMLElement).textContent = "(unreadable)";
  }
  $("cfgerr").textContent = "";
  // Detached-backend controls (remote server mode only — the
  // desktop backend dies with the app, so there is nothing to stop).
  // Direct mode is phone-only too: same desktop rows hidden as server mode.
  $("settingsmodal").classList.toggle("server", isServerMode || directMode);
  $("settingsmodal").classList.remove("hidden");
}

// ---- boot ----

// Toggle-chord swallow: Super+J / Super+Shift+J can leak a keypress
// into whatever input holds focus (both toggle directions race focus
// changes). Swallow the chord anywhere — it means nothing in a text
// field, and the backend owns the toggle. Parsed from config
// (rebindable); modifier-free "j" is NEVER swallowed here, it's
// indistinguishable from real typing in this window.
const hotChords: { key: string; mods: string[] }[] = [];
function parseHotChords(qb: unknown, main: unknown): void {
  hotChords.length = 0;
  for (const spec of [qb, main]) {
    const parts = String(spec ?? "").split("+").map((s) => s.trim()).filter(Boolean);
    const key = parts.pop();
    if (!key) continue;
    hotChords.push({ key: key.toLowerCase(), mods: parts.map((p) => p.toLowerCase()) });
  }
}
function chordHeld(c: { key: string; mods: string[] }, e: KeyboardEvent): boolean {
  if (e.key.toLowerCase() !== c.key) return false;
  if (!c.mods.length) return true;
  // Exact modifier match: every listed mod held, no unlisted mod held.
  // The old .some() check fired Super+Shift+J on a bare Shift+J,
  // eating every capital J typed in the app.
  const norm = (m: string): string =>
    (m === "super" || m === "meta" || m === "cmd" || m === "command" || m === "win") ? "meta"
    : (m === "ctrl" || m === "control") ? "ctrl"
    : m === "shift" ? "shift"
    : (m === "alt" || m === "opt" || m === "option") ? "alt" : "";
  const want = new Set(c.mods.map(norm).filter(Boolean));
  if (!want.size) return true;
  const held = new Set<string>();
  if (e.metaKey) held.add("meta");
  if (e.ctrlKey) held.add("ctrl");
  if (e.altKey) held.add("alt");
  // Shift counts only when chord-listed, or when needed to type the key
  // itself (symbols like ? or +). A capital letter never needs shift
  // for matching — extra shift means typing, not the chord.
  if (e.shiftKey) {
    const symbolKey = e.key.length === 1 && /[^a-zA-Z0-9]/.test(e.key);
    if (!want.has("shift") && !symbolKey) return false;
    held.add("shift");
  }
  for (const m of want) if (!held.has(m)) return false;
  for (const m of held) if (!want.has(m)) return false;
  return true;
}
parseHotChords("Super+J", "Super+Shift+J"); // shipped defaults; config refines below

  // Hover toolbars: copy message text, or revert/fork at a user
  // message. Queued-message edit/steer live on the queue bar (pi's data),
  // not on bubbles. Revert rewinds this chat in place (the pre-revert
  // file is deleted so only the latest version survives); fork keeps both
  // as separate chats.
  // Capture phase: kill the toggle chord before any input sees it.
  document.addEventListener("keydown", (e) => {
    if (hotChords.some((c) => chordHeld(c, e as KeyboardEvent))) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  document.addEventListener("click", async (e) => {
    const rv = (e.target as HTMLElement).closest?.(".act-revert") as HTMLButtonElement | null;
    if (rv) {
      e.stopPropagation();
      const entry = rv.dataset.entry ?? await resolveForkEntry(rv);
      if (entry) await doRevert(entry);
      else toastErr("message not ready yet — try again in a moment");
      return;
    }
    const fk = (e.target as HTMLElement).closest?.(".act-fork") as HTMLButtonElement | null;
    if (fk) {
      e.stopPropagation();
      const entry = fk.dataset.entry ?? await resolveForkEntry(fk);
      if (entry) await doFork(entry);
      else toastErr("message not ready yet — try again in a moment");
      return;
    }
    const tc = (e.target as HTMLElement).closest?.(".act-tcopy") as HTMLButtonElement | null;
    if (tc) {
      e.stopPropagation();
      copyTurn(tc);
      return;
    }
    const sstop = (e.target as HTMLElement).closest?.(".sstop") as HTMLButtonElement | null;
    if (sstop?.dataset.id) {
      e.stopPropagation();
      sendJobCmd(`/job-kill ${sstop.dataset.id}`);
      return;
    }
    const sdel = (e.target as HTMLElement).closest?.(".sdel") as HTMLButtonElement | null;
    if (sdel?.dataset.id) {
      e.stopPropagation();
      deleteJob(sdel.dataset.id);
      return;
    }
    const b = (e.target as HTMLElement).closest?.(".act-copy") as HTMLButtonElement | null;
    if (!b) return;
    doCopy(b);
  });

// ---- direct chat mode (no backend, no pi) ----
// Phone-first mode: provider HTTPS straight from the app, chats in
// localStorage. No subagents, no code tools — so the right panel and
// its toggle hide (body.direct), and thinking still renders (collapsed).
let directMode = false;
let directViewId: string | null = null;
let directStreaming = false;
let directAbort: AbortController | null = null;

function enterDirectMode(): void {
  directMode = true;
  document.body.classList.add("direct");
  updateCtxUI();
  paintModeToggle();
  const st = loadDirectSettings();
  ($("modellabel") as HTMLElement).textContent = st.model || "model";
  ($("dirlabel") as HTMLElement).textContent = "direct";
  renderDirectList();
  openDirectChat(null);
}

function exitDirectMode(): void {
  directMode = false;
  directViewId = null;
  document.body.classList.remove("direct");
  updateCtxUI();
}

function renderDirectList(): void {
  hideSessMenu();
  const f = ($("sessfilter") as HTMLInputElement).value.toLowerCase();
  const list = $("sesslist");
  const keepScroll = list.scrollTop;
  list.innerHTML = "";
  for (const c of listDirectChats()) {
    const last = [...c.messages].reverse().find((m) => m.content)?.content ?? "";
    const label = `${c.title} ${last}`.toLowerCase();
    if (f && !label.includes(f)) continue;
    const d = el("div", "sess" + (c.id === directViewId ? " active" : ""),
      `<div class="stitle">${esc(c.title)}</div><div class="ssub">${esc(last.slice(0, 80))}</div>`);
    d.addEventListener("click", () => openDirectChat(c.id));
    const more = el("button", "sdel smore", "…");
    more.title = "Chat options";
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      openDirectMenu(c.id, r.left, r.bottom + 4);
    });
    d.appendChild(more);
    d.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openDirectMenu(c.id, e.clientX, e.clientY);
    });
    list.appendChild(d);
  }
  list.scrollTop = Math.min(keepScroll, Math.max(0, list.scrollHeight - list.clientHeight));
}

function directBubble(m: { role: string; content: string; thinking?: string }): HTMLElement {
  if (m.role === "user") {
    const box = el("div", "msg user");
    box.appendChild(el("div", "ubody", renderMd(m.content)));
    return box;
  }
  const box = el("div", "msg assistant");
  if (m.thinking) {
    const det = document.createElement("details");
    det.className = "think";
    const sum = document.createElement("summary");
    sum.textContent = "Thinking";
    det.appendChild(sum);
    det.appendChild(el("div", "think-body", esc(m.thinking)));
    box.appendChild(det);
  }
  box.appendChild(el("div", "atext", renderMd(m.content || "")));
  return box;
}

function openDirectChat(id: string | null): void {
  if (directStreaming) abortDirect();
  const box = $("msgs");
  box.innerHTML = "";
  if (!id) {
    directViewId = null;
    box.appendChild(el("div", "greet", `<h2>Ready when you are.</h2>`));
    ($("sesstitle") as HTMLElement).textContent = "New chat";
    renderDirectList();
    syncSendBtn();
    return;
  }
  const chat = getDirectChat(id);
  if (!chat) {
    openDirectChat(null);
    return;
  }
  directViewId = id;
  ($("sesstitle") as HTMLElement).textContent = chat.title;
  for (const m of chat.messages) box.appendChild(directBubble(m));
  renderDirectList();
  dropToBottom();
  syncSendBtn();
}

function openDirectMenu(id: string, x: number, y: number): void {
  closeDrops();
  hideSessMenu();
  const chat = getDirectChat(id);
  if (!chat) return;
  const m = document.createElement("div");
  m.id = "sessmenu";
  m.className = "dd-list";
  m.addEventListener("click", (e) => e.stopPropagation());
  sessMenuEl = m;
  document.addEventListener("keydown", sessMenuEsc, true);
  const ren = el("div", "dd-opt", "Rename");
  ren.addEventListener("click", () => {
    m.innerHTML = "";
    m.appendChild(el("div", "sessmenu-head", "Rename chat"));
    const inp = document.createElement("input");
    inp.className = "sessmenu-input";
    inp.value = chat.title;
    inp.spellcheck = false;
    m.appendChild(inp);
    const row = el("div", "sessmenu-row");
    const cancel = el("button", "sessmenu-btn", "Cancel");
    cancel.addEventListener("click", () => openDirectMenu(id, x, y));
    const save = el("button", "sessmenu-btn primary", "Save");
    save.addEventListener("click", () => {
      renameDirectChat(id, inp.value.trim());
      const c = getDirectChat(id);
      if (c && directViewId === id) ($("sesstitle") as HTMLElement).textContent = c.title;
      renderDirectList();
      hideSessMenu();
    });
    row.appendChild(cancel);
    row.appendChild(save);
    m.appendChild(row);
    inp.focus();
    inp.select();
  });
  m.appendChild(ren);
  const del = el("div", "dd-opt danger", "Delete");
  del.addEventListener("click", () => {
    if (del.dataset.armed) {
      deleteDirectChat(id);
      hideSessMenu();
      if (directViewId === id) openDirectChat(null);
      else renderDirectList();
    } else {
      del.dataset.armed = "1";
      del.textContent = "Confirm delete";
    }
  });
  m.appendChild(del);
  document.body.appendChild(m);
  positionSessMenu(m, x, y);
}

function abortDirect(): void {
  try {
    directAbort?.abort();
  } catch { /* ignore */ }
}

let directModelNames: string[] = [];

// Chat model picker in direct mode: live GET /models every open.
async function openDirectModels(): Promise<void> {
  closeDrops();
  directModelNames = [];
  ($("modellist") as HTMLElement).classList.remove("hidden");
  popMenu($("modellist"), $("modelbtn"));
  ($("modelbtn") as HTMLButtonElement).classList.add("open");
  renderDirectModelOpts(true);
  try {
    directModelNames = await listDirectModels(loadDirectSettings());
  } catch (e: any) {
    directModelNames = [];
    toastErr(e.message ?? e);
  }
  renderDirectModelOpts();
}

function renderDirectModelOpts(loading = false): void {
  const ml = $("modelopts");
  ml.innerHTML = "";
  const q = (($("modeltype") as HTMLInputElement).value || "").toLowerCase();
  if (loading) {
    ml.appendChild(el("div", "dd-opt", "loading…"));
    return;
  }
  const shown = directModelNames.filter((n) => !q || n.toLowerCase().includes(q));
  if (!shown.length) {
    ml.appendChild(el("div", "dd-opt", "no models — check base URL + key"));
    return;
  }
  const cur = loadDirectSettings();
  for (const name of shown) {
    const o = el("div", "dd-opt" + (name === cur.model ? " sel" : ""), esc(name));
    o.addEventListener("click", () => {
      closeDrops();
      const s = loadDirectSettings();
      s.model = name;
      saveDirectSettings(s);
      ($("modellabel") as HTMLElement).textContent = name;
    });
    ml.appendChild(o);
  }
}

async function directSend(text: string): Promise<void> {
  if (!text && !pendingAttachments.length) return;
  if (pendingAttachments.length) {
    toastErr("attachments need the desktop agent — direct chat is text-only");
    return;
  }
  const st = loadDirectSettings();
  if (!st.baseUrl || !st.apiKey || !st.model) {
    toastErr("direct chat needs an API key — add it in Settings");
    return;
  }
  if (text.trim() === "/new") {
    setComposerText("");
    syncSendBtn();
    openDirectChat(null);
    return;
  }
  let chat = directViewId ? getDirectChat(directViewId) : null;
  if (!chat) {
    chat = newDirectChat(st.model);
    directViewId = chat.id;
    ($("sesstitle") as HTMLElement).textContent = chat.title;
  }
  const box = $("msgs");
  box.querySelector(".greet")?.remove();
  box.appendChild(directBubble({ role: "user", content: text }));
  const abox = el("div", "msg assistant");
  const thinkDet = document.createElement("details");
  thinkDet.className = "think";
  thinkDet.style.display = "none";
  const thinkSum = document.createElement("summary");
  thinkSum.textContent = "Thinking";
  const thinkBody = el("div", "think-body", "");
  thinkDet.appendChild(thinkSum);
  thinkDet.appendChild(thinkBody);
  abox.appendChild(thinkDet);
  const abody = el("div", "atext", "");
  abox.appendChild(abody);
  box.appendChild(abox);
  stick = true;
  dropToBottom();
  setComposerText("");
  syncSendBtn();
  chat.messages.push({ role: "user", content: text, at: Date.now() });
  if (chat.messages.length === 1) chat.title = text.slice(0, 60);
  saveDirectChat(chat);
  renderDirectList();
  const history = chat.messages.map((mm) => ({ role: mm.role, content: mm.content }));
  directStreaming = true;
  syncSendBtn();
  const ac = new AbortController();
  directAbort = ac;
  let latestContent = "";
  let latestThink = "";
  let thinkingActive = false;
  let paintT: number | null = null;
  let closed = false;
  const paint = () => {
    paintT = null;
    if (thinkingActive) {
      thinkDet.style.display = "";
      thinkBody.textContent = latestThink || "…";
    }
    abody.innerHTML = renderMd(latestContent);
    if (stick) dropToBottom();
  };
  const schedulePaint = () => {
    if (paintT !== null || closed) return;
    paintT = window.setTimeout(paint, 250);
  };
  try {
    const msg = await streamDirectChat(st, history, {
      onThinking: (th) => { thinkingActive = true; latestThink = th; schedulePaint(); },
      onContent: (c) => { latestContent = c; schedulePaint(); },
    }, ac.signal, { sessionId: chat.id });
    closed = true;
    if (paintT !== null) { window.clearTimeout(paintT); paintT = null; }
    // Final state comes from the resolved message (e.g. token-count
    // placeholder when reasoning text itself is encrypted server-side).
    if (msg.thinking) { thinkingActive = true; latestThink = msg.thinking; }
    if (msg.content) latestContent = msg.content;
    paint();
    const cur = getDirectChat(chat.id);
    if (cur) {
      cur.messages.push(msg);
      saveDirectChat(cur);
      renderDirectList();
    }
  } catch (e: any) {
    closed = true;
    if (paintT !== null) { window.clearTimeout(paintT); paintT = null; }
    if ((e as any)?.name === "AbortError") {
      abody.innerHTML += `<div class="meta warn">stopped</div>`;
    } else {
      toastErr(e.message ?? e);
      abox.remove();
    }
  } finally {
    directStreaming = false;
    directAbort = null;
    syncSendBtn();
  }
}

// Backend boots in the background: the UI is fully wired first so a dead
// backend never bricks the app — Settings (Stop/Restart) stays reachable
// and the header pill retries the boot.
let booting = false;
function setPill(mode: "up" | "conn" | "down") {
  const p = $("backendpill") as HTMLButtonElement;
  if (!isServerMode) { p.classList.add("hidden"); return; }
  p.classList.remove("hidden");
  p.classList.toggle("down", mode === "down");
  p.textContent = mode === "up" ? "" : mode === "conn" ? "connecting…" : "desktop down — direct chat, tap to retry";
  if (mode === "up") p.classList.add("hidden");
}
// Native system-bar insets (Android): CSS env() reads 0 in windows that
// never got inset dispatch even with real overlay bars. The OS numbers
// are authoritative — apply them over env(), never below live values
// (startup race either direction). Desktop keeps env() (correctly 0).
async function applyNativeInsets(): Promise<void> {
  if (!isAndroidApp) return;
  try {
    const r = await invoke<{ top: number; bottom: number; left: number; right: number }>(
      "plugin:sys-insets|get-insets", {});
    const dpr = window.devicePixelRatio || 1;
    const cs = getComputedStyle(document.documentElement);
    const cur = (n: string) => {
      const v = parseFloat(cs.getPropertyValue(n));
      return Number.isFinite(v) ? v : 0;
    };
    const root = document.documentElement;
    const set = (name: string, px: number) => {
      const css = px / dpr;
      if (css > cur(name)) root.style.setProperty(name, `${css}px`);
    };
    set("--sat", r.top);
    set("--sab", r.bottom);
  } catch { /* env() fallback stands */ }
}

// Phone APK without a desktop URL has no backend at all: direct chat.
// Desktop (and browser dev) always uses the pi backend.
const isAndroidApp =
  typeof window !== "undefined" &&
  "__TAURI__" in window &&
  typeof navigator !== "undefined" &&
  /android/i.test(navigator.userAgent);

async function loadRemote(): Promise<void> {
  exitDirectMode();
  const c = await config.get();
  // Phone remote lands in the desktop's default dir (a fresh .pi-qa
  // space), not whatever the desktop was last doing. Both land in their
  // dir on a NEW chat every launch — never resume (history stays one
  // click away in the sidebar).
  const dir = isAndroidApp ? c.default_dir : (c.last_cwd || c.default_dir);
  await setCwd(dir, false, false);
  paintModeToggle();
}

function paintModeToggle(): void {
  ($("mode-direct") as HTMLButtonElement).classList.toggle("active", directMode);
  ($("mode-remote") as HTMLButtonElement).classList.toggle("active", !directMode);
}

// Sidebar toggle → remote. Switches only onto a reachable desktop;
// otherwise stays direct with the reason toasted. No auto-switching.
async function tryRemote(): Promise<void> {
  if (booting) return;
  const url = (localStorage.getItem("pi-server-url") ?? "").trim();
  if (!url) {
    toastErr("set the desktop URL in Settings first");
    return;
  }
  booting = true;
  setPill("conn");
  try {
    await ensureServerBackend();
  } catch (e: any) {
    booting = false;
    setPill("down");
    toastErr(`desktop unreachable: ${e.message ?? e}`);
    return;
  }
  booting = false;
  setPill("up");
  booting = false;
  setPill("up");
  try {
    await loadRemote();
  } catch (e: any) {
    // First contact failed on a live server: suspect a half-open event
    // channel. Fresh channel, one retry.
    recycleEvents();
    try {
      await loadRemote();
    } catch (e2: any) {
      enterDirectMode();
      setPill("down");
      toastErr(`backend data: ${e2.message ?? e2}`);
    }
  }
}

// Phone always boots direct — instant, no probing a desktop that is
// usually off. Remote is one explicit toggle tap away. Desktop boots
// straight into its local backend (unchanged behavior).
async function bootBackend(): Promise<void> {
  if (booting) return;
  booting = true;
  if (isAndroidApp) {
    booting = false;
    enterDirectMode();
    ($("modetoggle") as HTMLElement).classList.remove("hidden");
    setPill("up");
    return;
  }
  setPill("conn");
  try {
    await ensureServerBackend();
  } catch (e: any) {
    booting = false;
    setPill("down");
    toastErr(`backend: ${e.message ?? e}`);
    return;
  }
  booting = false;
  setPill("up");
  try {
    await loadRemote();
  } catch (e: any) {
    recycleEvents();
    try {
      await loadRemote();
    } catch (e2: any) {
      setPill("down");
      toastErr(`backend data: ${e2.message ?? e2}`);
    }
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  trapErrors();
  setTag("main");
  ($("backendpill") as HTMLButtonElement).addEventListener("click", () => { void tryRemote(); });
  ($("mode-direct") as HTMLButtonElement).addEventListener("click", () => {
    if (directStreaming) abortDirect();
    enterDirectMode();
  });
  ($("mode-remote") as HTMLButtonElement).addEventListener("click", () => { void tryRemote(); });
  // Bars can appear/change (rotation, nav-mode switch): re-read native
  // insets. Cheap, idempotent, max-guarded.
  let insetT: number | null = null;
  window.addEventListener("resize", () => {
    if (insetT !== null) window.clearTimeout(insetT);
    insetT = window.setTimeout(() => { insetT = null; void applyNativeInsets(); }, 400);
  });
  window.addEventListener("orientationchange", () => { void applyNativeInsets(); });
  void applyNativeInsets();
  // Remote close: ask the desktop backend to stop with the app.
  // Desktop IPC backends die with the app — nothing to do there.
  window.addEventListener("pagehide", () => { if (isServerMode) sendShutdownBeacon(); });
  void bootBackend();
  // Background run lifecycle -> sidebar dots (viewed session is driven
  // by run events directly; this covers everything else).
  onRunStatus((st) => {
    if (st.tag && st.tag !== "main") return;
    if (!st.key) return;
    noteRunLive(st.key, st.streaming);
    // Background activity moved a file mtime: reorder the sidebar.
    // (Viewed settles already re-list via finishRun; this covers the rest.)
    scheduleSessionsRefresh();
    // Fresh-id proc keys carry no file path: resolve once so the row
    // dot lights without waiting for the next sidebar snapshot.
    if (st.streaming && !st.key.includes("/") && !fileForProc(st.key)) {
      pi.state(cwd, st.key).then((s: any) => {
        const f = (s as any)?.sessionFile;
        if (typeof f === "string" && f) {
          fileToKey.set(f, st.key);
          runLive.set(f, true);
          paintRunDots();
        }
      }).catch(() => {});
    }
  });
  ($("send") as HTMLButtonElement).addEventListener("click", () => {
    if (directStreaming) abortDirect();
    else if (streaming) stopOnly();
    else send();
  });
  ($("abortbtn") as HTMLButtonElement).addEventListener("click", () => {
    if (directStreaming) abortDirect();
    else stopOnly();
  });
  ($("attachbtn") as HTMLButtonElement).addEventListener("click", async () => {
    // Desktop: native picker returns real paths — reference in place,
    // no copy. Browser: file input + save_upload (see send()).
    if (inTauriMain) {
      try {
        const picked = await invoke<string[]>("pick_files", {});
        if (picked?.length) addFilesByPath(picked);
      } catch (e: any) {
        toastErr(`pick failed: ${e.message ?? e}`);
      }
      return;
    }
    ($("attachfile") as HTMLInputElement).click();
  });
  ($("attachfile") as HTMLInputElement).addEventListener("change", (e) => {
    const fi = e.target as HTMLInputElement;
    if (fi.files?.length) addFiles(fi.files);
    fi.value = "";
  });
  const comp = $("composer");
  comp.addEventListener("dragover", (e) => e.preventDefault());
  comp.addEventListener("drop", (e) => {
    e.preventDefault();
    // Desktop: the native drag-drop event owns file drops (real paths);
    // the web event carries no usable files there.
    if (inTauriMain) return;
    if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
  });
  // Desktop native drops (real paths, no copy). Browser: no-op.
  try {
    void getCurrentWebview()?.onDragDropEvent?.((ev: any) => {
      if (ev?.payload?.type === "drop" && Array.isArray(ev.payload.paths)) addFilesByPath(ev.payload.paths);
    });
  } catch { /* browser mode: no-op */ }
  // CodeMirror composer (option A): real markdown parser highlights as you
  // type; the doc stays plain text. Keys mirror the old textarea exactly.
  mountComposer(
    $("input"),
    [
      {
        key: "ArrowDown",
        run: () => {
          if ($("cmdlist")?.classList.contains("hidden")) return false;
          menuMove($("cmdlist"), 1);
          cmdArrowed = true;
          return true;
        },
      },
      {
        key: "ArrowUp",
        run: () => {
          if ($("cmdlist")?.classList.contains("hidden")) return false;
          menuMove($("cmdlist"), -1);
          cmdArrowed = true;
          return true;
        },
      },
      {
        // Tab always completes the highlighted/first match. Enter sends —
        // unless the user just arrowed to a row, in which case it picks it.
        key: "Tab",
        run: () => {
          if ($("cmdlist")?.classList.contains("hidden")) return false;
          const hl = $("cmdlist").querySelector(".dd-opt.hl[data-v]") as HTMLElement | null;
          const first = $("cmdlist").querySelector('.dd-opt[data-v]') as HTMLElement | null;
          if (hl ?? first) {
            pickCmd(((hl ?? first) as HTMLElement).dataset.v!);
            return true;
          }
          return false;
        },
      },
      {
        key: "Enter",
        run: () => {
          const cmdOpen = !$("cmdlist")?.classList.contains("hidden");
          if (cmdOpen && cmdArrowed) {
            const hl = $("cmdlist").querySelector(".dd-opt.hl[data-v]") as HTMLElement | null;
            if (hl) {
              pickCmd(hl.dataset.v!);
              return true;
            }
          }
          void send();
          return true;
        },
      },
      { key: "Mod-Enter", run: () => { void send(); return true; } },
      { key: "Ctrl-Enter", run: () => { void send(); return true; } },
      { key: "Alt-Enter", run: () => { void send(); return true; } },
      { key: "Shift-Enter", run: () => false },
      {
        key: "Escape",
        run: () => {
          if (!$("cmdlist")?.classList.contains("hidden")) {
            hideCmdList();
            return true;
          }
          stopOnly();
          return true;
        },
      },
    ],
    {
      onChange: () => {
        syncSendBtn();
        renderCmdList();
      },
      onPaste: (files) => addFiles(files),
      onDropFiles: (files) => addFiles(files),
    }
  );
  // Mobile keyboard: the manifest uses adjustNothing, so the keyboard
  // overlays the WebView instead of resizing it. Lift only the composer
  // above the keyboard via the visual viewport — header and transcript
  // stay exactly put. No-op wherever there is no keyboard (kb height 0).
  try {
    const vv = window.visualViewport;
    if (vv) {
      const liftComposer = () => {
        const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        ($("composer") as HTMLElement).style.transform = kb > 0 ? `translateY(${-kb}px)` : "";
      };
      vv.addEventListener("resize", liftComposer);
      vv.addEventListener("scroll", liftComposer);
    }
  } catch { /* old webviews: no-op */ }
  ($("newsess") as HTMLButtonElement).addEventListener("click", async () => {
    // Mobile drawer: a fresh chat is a navigation — dismiss the sidebar.
    if (window.matchMedia("(max-width: 768px)").matches) {
      document.body.classList.add("side-collapsed");
      ($("expandbtn") as HTMLButtonElement).classList.remove("hidden");
    }
    if (directMode) {
      openDirectChat(null);
      composerFocus();
      return;
    }
    cwdGen++; // invalidate any in-flight setCwd (see switchSession)
    resetRunState();
    paintEmpty();
    composerFocus();
    refreshSessions();
    try {
      await openFresh();
    } catch (e: any) {
      toastErr(`new chat failed: ${e.message ?? e}`);
      return;
    }
    refreshAll(false);
  });
  ($("searchbtn") as HTMLButtonElement).addEventListener("click", () => {
    ($("sessfilter") as HTMLInputElement).focus();
  });
  ($("collapsebtn") as HTMLButtonElement).addEventListener("click", () => {
    document.body.classList.add("side-collapsed");
    ($("expandbtn") as HTMLButtonElement).classList.remove("hidden");
  });
  ($("expandbtn") as HTMLButtonElement).addEventListener("click", () => {
    document.body.classList.remove("side-collapsed");
    ($("expandbtn") as HTMLButtonElement).classList.add("hidden");
  });
  // Header new-chat (mobile): same action as the sidebar button.
  ($("newchatbtn") as HTMLButtonElement).addEventListener("click", () => {
    ($("newsess") as HTMLButtonElement).click();
  });
  // Mobile: sidebar starts closed (overlay drawer), header holds new-chat.
  if (window.matchMedia("(max-width: 768px)").matches) {
    document.body.classList.add("side-collapsed");
    ($("expandbtn") as HTMLButtonElement).classList.remove("hidden");
  }
  // Mobile drawer: tapping outside the open sidebar dismisses it.
  // Narrow-only so desktop clicks are untouched; the expand button
  // itself is exempt (it opens, this would instantly re-close).
  document.addEventListener("click", (e) => {
    if (!window.matchMedia("(max-width: 768px)").matches) return;
    if (document.body.classList.contains("side-collapsed")) return;
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t.closest("#side") || t.closest("#expandbtn")) return;
    document.body.classList.add("side-collapsed");
    ($("expandbtn") as HTMLButtonElement).classList.remove("hidden");
  });
  const scrollerEl = $("scrollwrap");
  const scroller = () => {
    const away = scrollerEl.scrollHeight - scrollerEl.scrollTop - scrollerEl.clientHeight;
    stick = away < 80;
    ($("scrollbtn") as HTMLButtonElement).classList.toggle("hidden", away < 200);
  };
  scrollerEl.addEventListener("scroll", scroller);
  // Refocus the composer when the window regains focus (Tauri tab
  // switch, Alt-Tab): without this the user must click the box to type.
  // Guarded: never yank focus out of another field, the settings modal,
  // or the lightbox — only fill the vacuum when nothing is focused.
  const focusComposer = () => {
    try {
      if (!$("settingsmodal").classList.contains("hidden")) return;
      if (document.querySelector(".lightbox")) return;
      const a = document.activeElement as HTMLElement | null;
      if (a && a !== document.body) return;
      composerFocus();
    } catch { /* ignore */ }
  };
  try {
    const win = getCurrentWindow();
    void win.onFocusChanged(({ payload: focused }: any) => {
      if (focused) focusComposer();
    });
  } catch { /* browser fallback below covers it */ }
  window.addEventListener("focus", focusComposer);
  ($("panebtn") as HTMLButtonElement).addEventListener("click", () => {
    setSidePane(sideIsOpen() ? null : sideTabLast);
  });
  ($("sideclose") as HTMLButtonElement).addEventListener("click", () => {
    setSidePane(null);
  });
  ($("tabchanges") as HTMLButtonElement).addEventListener("click", () => {
    setSidePane("changes");
  });
  ($("tabagents") as HTMLButtonElement).addEventListener("click", () => {
    setSidePane("agents");
  });
  ($("tabprocs") as HTMLButtonElement).addEventListener("click", () => {
    setSidePane("procs");
  });
  // Covers any stuck state (missed settled event, lost subscription,
  // wedged flag): if the agent runs but we show idle, re-arm dots and
  // lock the composer. Read-only — never settles, never rebuilds.
  // (One exception: a corroborated backend reboot settles the viewed
  // run — no proc answers AND the boot changed, so it is dead, not busy.)
  setInterval(async () => {
    // Backend reboot ends every supervised pi run: without this tripwire
    // both the composer and the Agents panel stick "live" forever. Jobs
    // themselves survive (detached pi-jobs), so only unprobed rows are
    // marked — probed ones are reconciled by pid below. One snapshot, no
    // per-proc traffic; persisted so restarts across app launches trip
    // it too.
    let bootChanged = false;
    try {
      const snap: any = await runStates.snapshot();
      const boot = Array.isArray(snap) ? null : snap?.bootId ?? null;
      if (typeof boot === "string") {
        let prev: string | null = null;
        try {
          prev = localStorage.getItem("pi-boot-id");
        } catch { /* private mode */ }
        if (prev && prev !== boot) bootChanged = true;
        if (prev !== boot) {
          try {
            localStorage.setItem("pi-boot-id", boot);
          } catch { /* ignore */ }
          lastBootId = boot;
          runLive.clear();
        }
      }
    } catch { /* snapshot unavailable: skip */ }
    if (bootChanged) void refreshJobs(true);
    try {
      if (!cwd || !viewKey) return;
      if (document.hidden) return;
      let s: any = null;
      let stateFailed = false;
      try {
        s = await pi.state(cwd, viewKey || undefined);
      } catch {
        stateFailed = true;
      }
      if (stateFailed) {
        if (bootChanged && streaming) finishRun();
        return;
      }
      const live = !!s?.isStreaming || runLive.get(viewKey) === true;
      if (viewKey) {
        noteRunLive(viewKey, live);
        if (viewPath) {
          fileToKey.set(viewPath, viewKey);
          runLive.set(viewPath, live);
        }
        paintRunDots();
      }
      if (live && !streaming) {
        streaming = true;
        syncSendBtn();
        showThinking();
        // Missed the turn start entirely: its settled rows (if any)
        // are showing mid-run. Strip; they return at the next settle.
        document.querySelectorAll("#msgs .turn-tools").forEach((n) => n.remove());
      }
      // Reconcile background marks: a run cannot survive its process.
      // Invoke failure (no proc) clears the dot; success says nothing
      // (never second-guess liveness from a sample — events own that).
      // Probe the REAL proc key: file rows of fresh-keyed sessions map
      // via fileToKey, and probing the file path itself would always
      // miss (no such proc) and wrongly wipe live dots. Unknown mappings
      // are left alone — the next snapshot rebuild owns that truth.
      for (const [k, v] of runLive) {
        if (!v || k === viewKey) continue;
        const procKey = k.includes("/") ? fileToKey.get(k) : k;
        if (procKey == null) continue;
        try {
          await pi.state(cwd, procKey);
        } catch {
          if (runLive.get(k) === true) {
            runLive.delete(k);
            // A dead fresh-id proc takes its file row's dot with it.
            if (!k.includes("/")) {
              const f = fileForProc(k);
              if (f) runLive.delete(f);
            }
            paintRunDots();
          }
        }
      }
    } catch { /* backend busy: next beat retries */ }
  }, 20_000);
  // Chat sidebar resize: same drag pattern as the right panel, mirrored.
  // Width persists across reloads.
  const side = $("side");
  const savedSideW = Number(localStorage.getItem("side-w") || 0);
  if (savedSideW >= 220 && savedSideW <= 560) side.style.flex = `0 0 ${savedSideW}px`;
  ($("sidelresize") as HTMLElement).addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => {
      side.style.flex = `0 0 ${Math.min(560, Math.max(220, startW + (ev.clientX - startX)))}px`;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      localStorage.setItem("side-w", String(Math.round(side.getBoundingClientRect().width)));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  // Elapsed ticking for running subagents: badge + open panel + inline
  // cards. Static elapsed on a live card reads broken within seconds.
  setInterval(() => {
    void refreshJobs();
    if (!jobRows.length) return;
    let anyRunning = false;
    for (const s of jobRows) {
      const id = s.id;
      if (s.state !== "running") continue;
      anyRunning = true;
      for (const card of Array.from(document.querySelectorAll(`.spawncard[data-spawn-id="${CSS.escape(id)}"]`))) {
        const t = card.querySelector(":scope > .spsum .spelapsed");
        if (t) t.textContent = jobElapsed(s);
      }
    }
    if (!anyRunning) return;
    updateAgentsBtn();
    if (agentsVisible()) renderAgents();
    if (procsVisible()) renderProcs();
  }, 5000);
  const rp = $("sidepane");
  const savedW = Number(localStorage.getItem("sidepane-w") || localStorage.getItem("diffpane-w") || 0);
  if (savedW >= 280 && savedW <= 900) rp.style.flexBasis = savedW + "px";
  ($("sideresize") as HTMLElement).addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rp.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => {
      rp.style.flexBasis = Math.min(900, Math.max(280, startW + (startX - ev.clientX))) + "px";
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      localStorage.setItem("sidepane-w", String(Math.round(rp.getBoundingClientRect().width)));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  // Expanding an edit/write row tracks it in the Changes pane (lands
  // there on manual open) — but never force-opens it. Reads, bash and
  // friends expand inline only. (`toggle` doesn't bubble, so listen in
  // capture phase.)
  document.addEventListener("toggle", (e) => {
    const d = e.target as HTMLElement;
    if (d?.tagName === "DETAILS" && d.classList.contains("toolrow") && (d as HTMLDetailsElement).open) {
      // Spawn detail transcripts borrow the chat renderer: their rows
      // expand inline only and never feed this session's Changes pane.
      if (d.closest("#agenttranscript")) return;
      const ref = (d as any)._diff as DiffRef | undefined;
      const tn = (ref?.tool || "").toLowerCase();
      if (!ref || (tn !== "edit" && tn !== "write")) return;
      noteDiff(ref);
      selKey = diffKey(ref.tool, ref.path);
      viewRef = diffFiles.get(selKey) ?? ref;
      // Expanding a row is explicit focus on that file: pin it there.
      selPinned = true;
      if (changesVisible()) renderDiffPane();
    }
  }, true);
  ($("scrollbtn") as HTMLButtonElement).addEventListener("click", () => {
    stick = true;
    scrollerEl.scrollTop = scrollerEl.scrollHeight;
    ($("scrollbtn") as HTMLButtonElement).classList.add("hidden");
  });
  ($("sessfilter") as HTMLInputElement).addEventListener("input", () => {
    if (directMode) renderDirectList();
    else refreshSessions();
  });
  ($("dirbtn") as HTMLButtonElement).addEventListener("click", (e) => {
    e.stopPropagation();
    if (directMode) { toastErr("no working directory in direct chat"); return; }
    const opening = $("dirlist").classList.contains("hidden");
    closeDrops();
    if (opening) {
      $("dirlist").classList.remove("hidden");
      popMenu($("dirlist"), $("dirbtn"));
      ($("dirbtn") as HTMLButtonElement).classList.add("open");
      renderDirRecents();
      focusSearch($("dirtype") as HTMLInputElement);
    }
  });
  ($("dirlist") as HTMLElement).addEventListener("click", (e) => e.stopPropagation());
  ($("dirtype") as HTMLInputElement).addEventListener("click", (e) => e.stopPropagation());
  ($("dirtype") as HTMLInputElement).addEventListener("input", renderDirRecents);
  ($("dirtype") as HTMLInputElement).addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      menuMove($("dirrecents"), e.key === "ArrowDown" ? 1 : -1);
      e.preventDefault();
    } else if (e.key === "Enter") {
      const hl = $("dirrecents").querySelector(".dd-opt.hl") as HTMLElement | null;
      if (hl) {
        hl.querySelector(".dd-dirname")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return;
      }
      const v = (e.target as HTMLInputElement).value.trim();
      if (v) {
        closeDrops();
        setCwd(v);
      }
    } else if (e.key === "Escape") {
      closeDrops();
    }
  });
  ($("dirbrowse") as HTMLButtonElement).addEventListener("click", async () => {
    closeDrops();
    const picked: string | null = await invoke("pick_dir");
    if (picked) setCwd(picked);
  });
  ($("modelbtn") as HTMLButtonElement).addEventListener("click", (e) => {
    e.stopPropagation();
    if (directMode) { void openDirectModels(); return; }
    const opening = $("modellist").classList.contains("hidden");
    closeDrops();
    if (opening) {
      $("modellist").classList.remove("hidden");
      popMenu($("modellist"), $("modelbtn"));
      ($("modelbtn") as HTMLButtonElement).classList.add("open");
      renderModelOpts();
      focusSearch($("modeltype") as HTMLInputElement);
    }
  });
  ($("modellist") as HTMLElement).addEventListener("click", (e) => e.stopPropagation());
  ($("modeltype") as HTMLInputElement).addEventListener("click", (e) => e.stopPropagation());
  ($("modeltype") as HTMLInputElement).addEventListener("input", () => {
    if (directMode) renderDirectModelOpts();
    else renderModelOpts();
  });
  ($("modeltype") as HTMLInputElement).addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      menuMove($("modelopts"), e.key === "ArrowDown" ? 1 : -1);
      e.preventDefault();
    } else if (e.key === "Enter") {
      menuPick($("modelopts"));
    } else if (e.key === "Escape") {
      closeDrops();
    }
  });
  ($("thinkbtn") as HTMLButtonElement).addEventListener("click", (e) => {
    e.stopPropagation();
    if (directMode) { toastErr("no thinking levels in direct chat — reasoning shows inline"); return; }
    const opening = $("thinklist").classList.contains("hidden");
    closeDrops();
    if (opening) {
      $("thinklist").classList.remove("hidden");
      popMenu($("thinklist"), $("thinkbtn"));
      ($("thinkbtn") as HTMLButtonElement).classList.add("open");
      renderThinkOpts();
      focusSearch($("thinktype") as HTMLInputElement);
    }
  });
  ($("thinklist") as HTMLElement).addEventListener("click", (e) => e.stopPropagation());
  ($("thinktype") as HTMLInputElement).addEventListener("click", (e) => e.stopPropagation());
  ($("thinktype") as HTMLInputElement).addEventListener("input", renderThinkOpts);
  ($("thinktype") as HTMLInputElement).addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      menuMove($("thinkopts"), e.key === "ArrowDown" ? 1 : -1);
      e.preventDefault();
    } else if (e.key === "Enter") {
      menuPick($("thinkopts"));
    } else if (e.key === "Escape") {
      closeDrops();
    }
  });
  document.addEventListener("click", () => closeDrops());
  // Invisible type-ahead for open menus (native-select behavior): focus a
  // menu button, type to jump, Enter picks, Esc closes. No text field.
  let typeBuf = "";
  let typeTimer: number | null = null;
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    for (const id of ["modellist", "thinklist"]) {
      const list = $(id);
      if (list.classList.contains("hidden")) continue;
      if (e.key === "Escape") {
        closeDrops();
        typeBuf = "";
        e.preventDefault();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        menuMove(list, e.key === "ArrowDown" ? 1 : -1);
        e.preventDefault();
        return;
      }
      if (e.key === "Enter") {
        menuPick(list);
        e.preventDefault();
        return;
      }
      if (e.key === "Backspace") {
        typeBuf = typeBuf.slice(0, -1);
      } else if (e.key.length === 1) {
        typeBuf += e.key.toLowerCase();
      } else {
        continue;
      }
      if (typeTimer) window.clearTimeout(typeTimer);
      typeTimer = window.setTimeout(() => (typeBuf = ""), 800);
      const opts = Array.from(list.querySelectorAll(".dd-opt")) as HTMLElement[];
      opts.forEach((o) => o.classList.remove("hl"));
      const hit = opts.find((o) => (o.textContent ?? "").trim().toLowerCase().startsWith(typeBuf));
      hit?.classList.add("hl");
      hit?.scrollIntoView({ block: "nearest" });
      return;
    }
  });
  ($("settingsbtn") as HTMLButtonElement).addEventListener("click", openSettings);
  ($("cfgclose") as HTMLButtonElement).addEventListener("click", () =>
    $("settingsmodal").classList.add("hidden")
  );
  ($("cfg-local-gen") as HTMLButtonElement).addEventListener("click", () => {
    const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const rnd = new Uint32Array(32);
    crypto.getRandomValues(rnd);
    ($("cfg-local-token") as HTMLInputElement).value = Array.from(rnd, (n) => abc[n % 62]).join("");
  });
  ($("cfgsave") as HTMLButtonElement).addEventListener("click", async () => {
    const newUrl = ($("cfg-remote-url") as HTMLInputElement).value.trim();
    const urlChanged = (localStorage.getItem("pi-server-url") ?? "") !== newUrl;
    if (newUrl) localStorage.setItem("pi-server-url", newUrl);
    else localStorage.removeItem("pi-server-url");
    const newTok = ($("cfg-remote-token") as HTMLInputElement).value;
    if (newTok) localStorage.setItem("pi-server-token", newTok);
    else localStorage.removeItem("pi-server-token");
    // Model lives in the chat dropdown, not here — keep the stored one.
    const prevDirect = loadDirectSettings();
    saveDirectSettings({
      preset: ((v: string) => (v === "anthropic" || v === "responses" ? v : "openai"))(($("cfg-direct-preset") as HTMLSelectElement).value),
      baseUrl: ($("cfg-direct-url") as HTMLInputElement).value.trim().replace(/\/+$/, ""),
      // Pasted keys often drag trailing newlines/spaces (file copy) —
      // the gateway rejects those as invalid credentials.
      apiKey: ($("cfg-direct-key") as HTMLInputElement).value.trim(),
      model: prevDirect.model,
    });
    try {
      const patch: Record<string, unknown> = {
        quickbar_hotkey: ($("cfg-quick") as HTMLInputElement).value.trim(),
        main_hotkey: ($("cfg-main") as HTMLInputElement).value.trim(),
        default_dir: ($("cfg-dir") as HTMLInputElement).value.trim(),
        run_in_bg: ($("cfg-bg") as HTMLInputElement).checked,
      };
      const lp = parseInt(($("cfg-local-port") as HTMLInputElement).value.trim(), 10);
      if (Number.isFinite(lp)) patch.remote_port = lp;
      patch.remote_token = ($("cfg-local-token") as HTMLInputElement).value;
      await config.set(patch);
    } catch (e: any) {
      toastErr(`backend settings not saved (backend down): ${e.message ?? e}`);
    }
    $("settingsmodal").classList.add("hidden");
    parseHotChords(
      ($("cfg-quick") as HTMLInputElement).value.trim(),
      ($("cfg-main") as HTMLInputElement).value.trim());
    // Connection change reboots the app into the right mode.
    if (urlChanged) location.reload();
    if (directMode) {
      const dd = loadDirectSettings();
      ($("modellabel") as HTMLElement).textContent = dd.model || "model";
    }
  });

  // Quickbar "open in sessions" handoff.
  listen("open-request", async (e: any) => {
    const p = e.payload ?? {};
    if (p.cwd && p.cwd !== cwd) await setCwd(p.cwd);
    if (p.sessionPath) await switchSession(p.sessionPath);
  }).catch(() => {});

});
