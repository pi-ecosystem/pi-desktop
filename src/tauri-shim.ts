// Drop-in replacement for @tauri-apps/api core/event imports.
// Inside Tauri: real IPC. In a plain browser (npm run dev:web): fetch + SSE
// against the Rust backend in --server mode (same commands, same event shapes).
// Remote mode (phone → desktop): same HTTP path against an explicit URL
// from ?server= or the pi-server-url setting — no auto-boot, the user
// handles reachability (Tailscale/LAN).
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

const inTauri = typeof window !== "undefined" && "__TAURI__" in window;

const params =
  typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
const serverBase: string | null =
  params?.get("server") ??
  (typeof localStorage !== "undefined" ? localStorage.getItem("pi-server-url") : null);

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  try {
    const t = localStorage.getItem("pi-server-token");
    if (t) h["authorization"] = `Bearer ${t}`;
  } catch { /* private mode: no token */ }
  return h;
}

function eventsUrl(): string {
  try {
    const t = localStorage.getItem("pi-server-token");
    if (t) return `${apiBase}/api/events?token=${encodeURIComponent(t)}`;
  } catch { /* private mode: no token */ }
  return `${apiBase}/api/events`;
}

// "" → same-origin /api/... (browser dev mode via vite proxy).
const apiBase = serverBase ?? "";

// True when talking to a detached backend over HTTP (remote phone →
// desktop, or browser dev with ?server=). Only there does the backend
// outlive the UI — desktop IPC backends die with the app.
export const isServerMode = serverBase !== null;

export async function invoke<T>(cmd: string, args?: any): Promise<T> {
  if (inTauri && serverBase === null) return tauriInvoke(cmd, args);
  const r = await fetch(`${apiBase}/api/invoke`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ cmd, params: args ?? {} }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error ?? `invoke ${cmd} failed`);
  return j.data as T;
}

export async function listen(event: string, cb: (e: any) => void): Promise<() => void> {
  if (inTauri && serverBase === null) return (await tauriListen(event, cb)) as () => void;
  if (event === "pi-record") {
    const es = new EventSource(eventsUrl());
    es.onmessage = (m) => {
      try {
        cb({ payload: JSON.parse((m as MessageEvent).data) });
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }
  // Window/tray lifecycle events don't exist in browser mode.
  return () => {};
}

// Best-effort backend stop on page unload: fetch with keepalive survives
// the dying page; failures are silent by design. Loopback only — a real
// remote desktop must survive the phone closing (its agent runs keep
// working); killing it because the phone app closed would be vandalism.
export function sendShutdownBeacon(): void {
  if (serverBase === null) return;
  try {
    const host = new URL(serverBase).hostname;
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return;
  } catch {
    return;
  }
  try {
    fetch(`${apiBase}/api/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "shutdown_server", params: {} }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* dying page: ignore */ }
}

// Remote mode: wait for the desktop backend to answer before the UI talks
// to it. No auto-boot — reachability is the user's business (Tailscale/LAN).
// No-op on desktop IPC. Polls ~30s, then throws — callers surface it and
// keep the UI usable (tap-to-retry pill).
export async function ensureServerBackend(): Promise<void> {
  if (serverBase === null) return;
  const ping = async (): Promise<boolean> => {
    try {
      const r = await fetch(`${apiBase}/api/invoke`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ cmd: "pi_states", params: {} }),
      });
      const j = await r.json();
      return !!j.ok;
    } catch {
      return false;
    }
  };
  if (await ping()) return;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await ping()) return;
  }
  throw new Error("desktop backend unreachable at " + serverBase);
}
