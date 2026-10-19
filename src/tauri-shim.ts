// Drop-in replacement for @tauri-apps/api core/event imports.
// Inside Tauri: real IPC. In a plain browser (npm run dev:web): fetch + SSE
// against the Rust backend in --server mode (same commands, same event shapes).
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

const inTauri = typeof window !== "undefined" && "__TAURI__" in window;

export async function invoke<T>(cmd: string, args?: any): Promise<T> {
  if (inTauri) return tauriInvoke(cmd, args);
  const r = await fetch("/api/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd, params: args ?? {} }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error ?? `invoke ${cmd} failed`);
  return j.data as T;
}

export async function listen(event: string, cb: (e: any) => void): Promise<() => void> {
  if (inTauri) return (await tauriListen(event, cb)) as () => void;
  if (event === "pi-record") {
    const es = new EventSource("/api/events");
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
