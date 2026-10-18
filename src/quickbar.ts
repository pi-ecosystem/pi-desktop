// Quick-bar popup: Claude-style overlay. Enter sends to pi in last cwd,
// streams inline, copy + open-in-sessions. Esc hides.

import { invoke } from "./tauri-shim";
import { listen } from "./tauri-shim";
import { LogicalSize, getCurrentWindow } from "./tauri-window-shim";
import { config, ensure, onRecord, pi, setKey, setTag, stopChild } from "./pi";
import { renderMd, setMediaBase, clearMediaCache, wireCopy } from "./md";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

let cwd = "";
let busy = false;
// Exactly one event subscription per cwd. Re-subscribing per ask
// duplicated every streamed token once per ask (real bug, now fixed).
let qbUnsub: (() => void) | null = null;
let qbSubCwd = "";
function ensureSub() {
  if (qbSubCwd === cwd && qbUnsub) return;
  try { qbUnsub?.(); } catch { /* ignore */ }
  qbUnsub = onRecord(cwd, route);
  qbSubCwd = cwd;
}
let buf = "";
let lastText = "";
let qbLastRender = 0; // throttle: full re-parse at most every ~250ms
// Start offset of the currently streaming turn inside buf. message_end
// carries one turn's authoritative text; without this, replacing buf
// would wipe earlier turns (and the copy button with them).
let turnBase = 0;

function setStatus(s: string) {
  $("qbstatus").textContent = s;
}

async function boot() {
  setTag("quickbar");
  const c = await config.get().catch(() => null);
  cwd = c?.last_cwd || c?.default_dir || "";
  setMediaBase(cwd);
  // Size follows content, always: observe instead of trusting call sites.
  // ResizeObserver fires per streamed token: debounce or the window
  // resizes dozens of times per answer.
  let fitT: number | null = null;
  try {
    new ResizeObserver(() => {
      if (fitT) window.clearTimeout(fitT);
      fitT = window.setTimeout(autofit, 150);
    }).observe($("qbwrap"));
  } catch { /* ignore */ }
  // Fresh session per open: showing the popup after a hide starts a new
  // session and clears the UI. Asks while open share one session.
  try {
    await listen("quickbar-shown", () => {
      // Unconditional: toggle means new session. A stale `busy` flag must
      // never veto this (a run that never settled would stick it forever).
      freshSession();
    });
  } catch { /* ignore */ }
  ensureSub();
  const inp = $("qbinput") as HTMLInputElement;
  // Focus input whenever popup gains focus.
  try {
    const win = getCurrentWindow();
    await win.onFocusChanged(({ payload: focused }: any) => {
      if (focused) {
        inp.focus();
        inp.select();
      }
    });
  } catch { /* ignore */ }
  inp.focus();
  autofit();
  // First open behaves like a toggle: start clean, don't continue history.
  freshSession().catch(() => {});

  inp.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      ask();
    } else if (e.key === "Escape") {
      e.preventDefault();
      hide();
    }
  });
  ($("qbcopier") as HTMLButtonElement).addEventListener("click", async () => {
    const b = $("qbcopier") as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(lastText);
      b.textContent = "copied";
    } catch {
      b.textContent = "failed"; // WebKitGTK/Tauri may refuse clipboard
    }
    setTimeout(() => {
      if (b.isConnected) b.textContent = "copy";
    }, 1200);
  });
  ($("qbopen") as HTMLButtonElement).addEventListener("click", async () => {
    try {
      const st: any = await pi.state(cwd).catch(() => null);
      await invoke("open_in_main", { cwd, sessionPath: st?.sessionFile ?? null });
    } catch { /* ignore */ }
    hide();
  });
}

async function ask() {
  const inp = $("qbinput") as HTMLInputElement;
  const text = inp.value.trim();
  if (!text || busy) return;
  // Never send on the pre-switch session: wait out an in-flight reset.
  if (freshPending) {
    try {
      await Promise.race([
        freshPending,
        new Promise((_, rej) => setTimeout(() => rej(new Error("reset timeout")), 8000)),
      ]);
    } catch {
      return;
    }
  }
  busy = true;
  const myGen = qbGen;
  buf = "";
  turnBase = 0;
  qbLastRender = 0;
  lastText = "";
  autofit();
  $("qbanswer").classList.remove("hidden");
  $("qbanswer").innerHTML = "";
  $("qbcopier").classList.add("hidden");
  $("qbopen").classList.add("hidden");
  ($("qbstatus") as HTMLElement).innerHTML = '<span class="thinking"><i></i><i></i><i></i></span>';
  const c = await config.get().catch(() => null);
  if (c?.last_cwd) cwd = c.last_cwd;
  try {
    await ensure(cwd, qbKey || undefined, null);
    if (qbKey) setKey(qbKey);
  } catch (e: any) {
    setStatus(`pi failed: ${e.message ?? e}`);
    busy = false;
    return;
  }
  ensureSub();
  try {
    await pi.prompt(cwd, text);
    // Watchdog, not a deadline: settle only when the agent reports idle
    // (or after a 30min cap). A fixed timer would declare long runs done
    // while still working, freezing a partial answer mid-stream.
    let n = 0;
    const t = setInterval(async () => {
      // Stale generation (toggle happened mid-run): die quietly, never
      // settle the new view. pi.state would report the FRESH session.
      if (!busy || myGen !== qbGen) {
        clearInterval(t);
        return;
      }
      if (++n > 120) {
        clearInterval(t);
        if (busy && myGen === qbGen) done();
        return;
      }
      try {
        const s: any = await pi.state(cwd);
        if (s && s.isStreaming === false) {
          clearInterval(t);
          if (busy && myGen === qbGen) done();
        }
      } catch { /* pi busy/starting: keep watching */ }
    }, 15_000);
  } catch (e: any) {
    setStatus(`send failed: ${e.message ?? e}`);
    busy = false;
  }
}

function route(rec: any) {
  if (!rec || !busy) return;
  if (rec.type === "message_update") {
    const ev = rec.assistantMessageEvent ?? {};
    if (ev.type === "text_delta" && typeof ev.delta === "string") {
      // Clear on EVERY delta, not just the first: a later turn's
      // toolcall_start re-arms the dots and they would linger next to
      // complete text otherwise.
      setStatus("");
      buf += ev.delta;
      // Paint at ~4Hz (see main.ts stream throttle): completion paths
      // always render the full text, so nothing is lost to the throttle.
      const nowR = Date.now();
      if (nowR - qbLastRender < 250 && ev.delta.length < 200) {
        autofit();
        return;
      }
      qbLastRender = nowR;
      const a = $("qbanswer");
      a.innerHTML = renderMd(buf);
      wireCopy(a);
      autofit();
    } else if (ev.type === "toolcall_start") {
      ($("qbstatus") as HTMLElement).innerHTML = '<span class="thinking"><i></i><i></i><i></i></span>';
    }
    return;
  }
  // Turn boundary: deltas after this belong to the new turn.
  if (rec.type === "message_start") {
    turnBase = buf.length;
    return;
  }
  // Authoritative text for the CURRENT turn replaces only its streamed
  // reconstruction (buf before turnBase is settled prior turns). A bare
  // replace here wiped earlier turns from view and from copy.
  if (rec.type === "message_end" && rec.message?.role === "assistant") {
    const blocks = rec.message.content ?? [];
    const full = blocks
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    if (full) {
      buf = buf.slice(0, turnBase) + full;
      turnBase = buf.length;
      const a = $("qbanswer");
      a.innerHTML = renderMd(buf);
      wireCopy(a);
      autofit();
    }
    return;
  }
  if (rec.type === "agent_settled") done();
}

function done() {
  busy = false;
  clearMediaCache();
  lastText = buf;
  // Final paint: throttled deltas above may have left the tail unpainted.
  if (buf) {
    const a = $("qbanswer");
    a.innerHTML = renderMd(buf);
    wireCopy(a);
  }
  setStatus(buf ? "" : "(empty)");
  if (buf) {
    $("qbcopier").classList.remove("hidden");
    $("qbopen").classList.remove("hidden");
  }
  autofit();
  config.set({ last_cwd: cwd }).catch(() => {});
}

// Shrink/grow the popup to its content so no black void ever shows.
async function autofit() {
  try {
    const want = Math.min(Math.max($("qbwrap").scrollHeight + 4, 72), 620);
    await getCurrentWindow().setSize(new LogicalSize(680, want));

  } catch (e) {
    // Visible in `tauri dev` terminal: silent failure = permanent big box.
    console.error("[quickbar] setSize failed:", e);
  }
}

// Resolved when no reset is in flight. Sends wait on it so a fast Enter
// can never land on the pre-switch (old) session.
let freshPending: Promise<void> | null = null;

// Own backend child per toggle (unique key). A reopen retires the
// previous toggle's child (see freshSession): the popup shows exactly
// one session at a time, so a hidden run has no UI to report to.
let qbKey = "";
// Generation guard: toggles bump this, and ask()'s watchdog only settles
// its own generation. Without it, a pre-toggle watchdog outlives the
// reset, polls the fresh (idle) session and fires done() — clobbering
// the new view with a stale "(empty)". (Live deltas need no guard:
// pi.ts drops pre-toggle events by key.)
let qbGen = 0;

// Reset UI + start a new pi session for this cwd.
async function freshSession() {
  if (freshPending) return freshPending;
  freshPending = (async () => {
  // New generation first: any pre-toggle watchdog/delta settling dies
  // here instead of clobbering the view below.
  qbGen++;
  const c = await config.get().catch(() => null);
  if (c?.last_cwd) cwd = c.last_cwd;
  if (qbKey) await stopChild(cwd, qbKey).catch(() => {});
  busy = false;
  buf = "";
  turnBase = 0;
  lastText = "";
  qbKey = `qb-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  setKey(qbKey);
  ensureSub();
  ($("qbinput") as HTMLInputElement).value = "";
  const a = $("qbanswer");
  a.innerHTML = "";
  a.classList.add("hidden");
  setStatus("");
  ($("qbcopier") as HTMLButtonElement).classList.add("hidden");
  ($("qbopen") as HTMLButtonElement).classList.add("hidden");
  try {
    await ensure(cwd, qbKey, null);
    const before: string | null = await pi.state(cwd).then((s: any) => s?.sessionFile ?? null).catch(() => null);
    await pi.newSession(cwd);
    // new_session ACKs immediately but switches asynchronously: poll until
    // get_state actually reports the new file (else the next prompt lands
    // on the old session and "moves" mid-run).
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const cur: string | null = await pi.state(cwd).then((s: any) => s?.sessionFile ?? null).catch(() => null);
      if (cur && cur !== before) break;
    }
  } catch (e: any) {
      // Visible, not swallowed: if this fails the old session continues and
      // the toggle-fresh behavior silently breaks. Shown in the answer area
      // (the status row is too easy to miss).
      const a = $("qbanswer");
      a.classList.remove("hidden");
      a.innerHTML = renderMd(`session reset failed: ${e?.message ?? e}`);
    }
    autofit();
  })();
  try {
    await freshPending;
  } finally {
    freshPending = null;
  }
}

async function hide() {
  try {
    await invoke("hide_window", { label: "quickbar" });
  } catch { /* ignore */ }
}

window.addEventListener("DOMContentLoaded", boot);
