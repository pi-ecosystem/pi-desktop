// Drop-in replacement for @tauri-apps/api core/event imports.
// Inside Tauri: real IPC. In a plain browser (npm run dev:web): fetch + SSE
// against the Rust backend in --server mode (same commands, same event shapes).
// On Android (APK): the on-device backend can't spawn `pi`, so the app talks
// to the Termux --server backend over localhost instead — forced by UA default
// below, bootable via the termux-boot plugin (ensureServerBackend).
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

const inTauri = typeof window !== "undefined" && "__TAURI__" in window;

const params =
  typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
const isAndroidUA =
  typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
const serverBase: string | null =
  params?.get("server") ??
  (typeof localStorage !== "undefined" ? localStorage.getItem("pi-server-url") : null) ??
  (isAndroidUA ? "http://127.0.0.1:1423" : null);

// "" → same-origin /api/... (browser dev mode via vite proxy).
const apiBase = serverBase ?? "";

// True when talking to a detached backend over HTTP (Android APK against
// the Termux server, or browser dev with ?server=). Only there does the
// backend outlive the UI — desktop IPC backends die with the app.
export const isServerMode = serverBase !== null;

// The termux-boot plugin commands live in the on-device backend even in
// server mode — they must always go over IPC when available.
function isBootCmd(cmd: string): boolean {
  return (
    cmd === "plugin:termux-boot|boot-server" ||
    cmd === "plugin:termux-boot|termux-available" ||
    cmd === "plugin:termux-boot|insets"
  );
}

export async function invoke<T>(cmd: string, args?: any): Promise<T> {
  if (inTauri && (serverBase === null || isBootCmd(cmd))) return tauriInvoke(cmd, args);
  const r = await fetch(`${apiBase}/api/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd, params: args ?? {} }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error ?? `invoke ${cmd} failed`);
  return j.data as T;
}

export async function listen(event: string, cb: (e: any) => void): Promise<() => void> {
  if (inTauri && serverBase === null) return (await tauriListen(event, cb)) as () => void;
  if (event === "pi-record") {
    const es = new EventSource(`${apiBase}/api/events`);
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

// Android only: make sure the Termux backend is up before the UI talks to
// it. No-op everywhere else (desktop IPC, browser dev). Ping; on failure
// fire the RUN_COMMAND intent at Termux, then poll ~30s. Throws when the
// backend never answers — callers surface it and stop init.
export async function ensureServerBackend(): Promise<void> {
  if (serverBase === null) return;
  const port = Number(new URL(serverBase).port) || 1423;
  const ping = async (): Promise<boolean> => {
    try {
      const r = await fetch(`${apiBase}/api/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd: "pi_states", params: {} }),
      });
      const j = await r.json();
      return !!j.ok;
    } catch {
      return false;
    }
  };
  if (await ping()) return;
  if (inTauri) {
    await invoke<{ started: boolean }>("plugin:termux-boot|boot-server", { port });
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await ping()) return;
  }
  throw new Error(
    "Termux backend unreachable — start it manually: pi-desktop-server --server " + port
  );
}
