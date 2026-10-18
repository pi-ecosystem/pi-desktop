# Pi Desktop

Thin Tauri shell over the `pi` coding agent. Pi owns the agent, sessions,
skills, and models — this app is just a hotkey popup + sessions window.

No Electron: Tauri 2 + system WebView. Frontend is vanilla TS + highlight.js.

## Install

Common prerequisites (all platforms): the [`pi` CLI](https://pi.dev)
on PATH and Node.js 22+.

```bash
git clone git@github.com:pi-ecosystem/pi-desktop.git ~/Projects/pi-desktop
cd ~/Projects/pi-desktop
npm install
```

### Browser mode (quickest, all platforms)

No Rust, no WebView libs. Same app, same real backend (`pi --mode rpc`
children, real sessions, real streaming) in Chrome via a small Node
bridge (`server/web-backend.mjs`, dev only — the Tauri build never
touches it):

```bash
npm run dev:web   # frontend :1422, api :1423 — open http://localhost:1422/
```

Window ops (toggle/hide/focus) are no-ops in a tab; everything else —
send/stop, streaming, tool cards, diffs, Changes pane, models — works.

### macOS app

Prerequisites: Xcode Command Line Tools + Rust (native WKWebView, no
system web libs needed):

```bash
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
export PATH="$HOME/.cargo/bin:$PATH"
```

Develop / build:

```bash
npx tauri dev                       # app window, frontend hot-reloads
npm run build && npx tauri build --bundles dmg
```

> Global hotkeys (`Super` = `Cmd`) need `System Settings → Privacy &
> Security → Accessibility` granted to the app (or Terminal, under
> `tauri dev`), otherwise they only fire while the app is focused.
> If `Cmd+J` clashes, change both hotkeys in ⚙ settings.

### Linux app

Prerequisites: Rust + WebKitGTK system libs (native WebView):

```bash
# Arch/CachyOS:
sudo pacman -S --needed webkit2gtk-4.1 base-devel nodejs npm
# Debian/Ubuntu:
sudo apt install libwebkit2gtk-4.1-dev build-essential nodejs npm
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
export PATH="$HOME/.cargo/bin:$PATH"
```

Develop / build / install:

```bash
npx tauri dev                       # use WEBKIT_DISABLE_DMABUF_RENDERER=1 below on NVIDIA+Wayland
npm run build && npx tauri build --bundles deb   # (or --bundles appimage)
cp -f src-tauri/target/release/pi-desktop ~/.local/bin/pi-desktop-bin
printf '#!/bin/sh\nexec env WEBKIT_DISABLE_DMABUF_RENDERER=1 "$HOME/.local/bin/pi-desktop-bin" "$@"\n' > ~/.local/bin/pi-desktop
chmod +x ~/.local/bin/pi-desktop
```

Then add the launcher entry (`~/.local/share/applications/pi-desktop.desktop`
pointing at `~/.local/bin/pi-desktop`) and the KDE shortcuts below.

> NVIDIA + Wayland: `WEBKIT_DISABLE_DMABUF_RENDERER=1` works around an
> upstream WebKitGTK/KWin explicit-sync protocol kill (Tauri issue #10702).
> Drop it once either side fixes it.

### Windows app

Prerequisites: WebView2 (preinstalled on Win 10/11), Rust, Node.js 22+:

```powershell
# Rust: https://rustup.rs/ (rustup-init.exe), then restart the terminal
# Node: https://nodejs.org/ (LTS)
```

Develop / build (PowerShell, in the repo):

```powershell
npm install
npx tauri dev                       # app window, frontend hot-reloads
npm run build; npx tauri build --bundles nsis
```

The installer lands under `src-tauri\target\release\bundle\nsis`.

## Develop

- App: `npx tauri dev` (add cargo to PATH first; Linux NVIDIA+Wayland:
prefix `WEBKIT_DISABLE_DMABUF_RENDERER=1`).
- Browser: `npm run dev:web` (no Rust needed).

Frontend hot-reloads on save in both. Release installs come from
`tauri build`.

## Hotkeys (both configurable in ⚙ settings)

- Quick bar: `Super+J` (popup: ask, stream, copy, open in sessions)
- Sessions: `Super+Shift+J` (full window: sidebar, per-session working dir, model + thinking pickers)

## Wayland / KDE fallback (recommended)

In-app global hotkeys can fail on Wayland when another app is focused.
Add a native KDE shortcut instead — it works everywhere:

1. `System Settings → Shortcuts → Custom Shortcuts → Add Command`
2. Quick bar: command `pi-desktop --toggle-quickbar`, trigger `Meta+J`
3. Sessions: command `pi-desktop --toggle-main`, trigger `Meta+Shift+J`

(Use different triggers if you change the in-app hotkeys — keep them in sync.)

Single-instance is enforced: the flags toggle the running app, never a second copy.

Autostart: `System Settings → Autostart → Add` the installed binary (no flags;
windows stay hidden until a hotkey, unless `--toggle-quickbar` is passed).

## Scope (v1, locked)

1. Both hotkeys, configurable — 2. Claude-style quick bar (stream + copy + open in sessions)
3. Per-session working dir (recent dirs + `~/.pi-qa` default for one-offs)
4. In-app model + thinking-level pickers (via pi RPC)
5. No search UI — pi + your `agent-search` skill decide (unchanged from terminal)
6. Markdown + code-copy rendering

## How it works

- Backend (`src-tauri/src/lib.rs`): one `pi --mode rpc` child per working dir,
  JSONL forwarded as `pi-record` events; session sidebar scans pi's own
  `~/.pi/agent/sessions` files (cwd in header, name in `session_info`).
- No index DB, no reimplementation: new/resume/switch/fork state all live in pi.

## Layout

- `src/main.ts` + `index.html` — sessions window
- `src/quickbar.ts` + `quickbar.html` — popup
- `src/pi.ts` — id-correlated RPC client
- `src/md.ts` — tiny markdown renderer
- `src/tauri-shim.ts` + `src/tauri-window-shim.ts` — fetch/SSE + no-op
  window shims, active only outside Tauri (browser mode)
- `server/web-backend.mjs` — dev-only Node bridge mirroring the Rust
  backend (`npm run dev:web`); Tauri builds never touch it
