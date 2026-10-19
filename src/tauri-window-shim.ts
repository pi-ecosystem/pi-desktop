// Browser-safe subset of @tauri-apps/api/window (quickbar auto-resize).
// Inside Tauri: real window handle. In browser mode: silent no-ops.
import { LogicalSize as TauriLogicalSize, getCurrentWindow as tauriWin } from "@tauri-apps/api/window";
import { getCurrentWebview as tauriWebview } from "@tauri-apps/api/webview";

const inTauri = typeof window !== "undefined" && "__TAURI__" in window;

export const LogicalSize: any = inTauri
  ? TauriLogicalSize
  : class {
      constructor(
        public width: number,
        public height: number,
      ) {}
    };

export function getCurrentWebview(): any {
  if (inTauri) return tauriWebview();
  return {
    onDragDropEvent: async (_cb: unknown) => () => {},
  };
}

export function getCurrentWindow(): any {
  if (inTauri) return tauriWin();
  return {
    setSize: async (_s: unknown) => {},
    onFocusChanged: async (_cb: unknown) => () => {},
    listen: async (_e: string, _cb: unknown) => () => {},
  };
}
