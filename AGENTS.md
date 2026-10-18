# AGENTS.md — pi-desktop dev notes

Read this before starting/stopping anything. Two runtimes, same frontend.

## Web mode (quickest, no Rust)

- `npm run dev:web` → frontend `:1422`, api `:1423`, open `http://localhost:1422/`
- Backend is `server/web-backend.mjs` (dev only). Window ops are no-ops in a tab; everything else is real.
- Stop: kill the exact PIDs (`vite`, `web-backend.mjs`). Never `pkill -f` with a pattern matching your own command.

## App mode (Tauri, needs Rust + WebKitGTK)

- `npx tauri dev` (cargo must be on PATH; NVIDIA+Wayland: prefix `WEBKIT_DISABLE_DMABUF_RENDERER=1`)
- Global hotkeys need Accessibility permission, else they fire only when focused.

## Build + install (Linux)

- `npm run build && npx tauri build --bundles deb` (release Rust build takes minutes — background it, poll the log)
- Install binary (no sudo):
  - `cp -f src-tauri/target/release/pi-desktop ~/.local/bin/pi-desktop-bin`
  - `mkdir -p ~/.local/bin/pi-spawn && cp -f ../pi-spawn/index.ts ~/.local/bin/pi-spawn/index.ts` (binary-copy installs carry no resource bundle; the backend resolves `<bindir>/pi-spawn/index.ts`. Path is repo-relative — after `npm publish pi-spawn`, source becomes `node_modules/pi-spawn/index.ts`)
  - wrapper `~/.local/bin/pi-desktop`: `exec env WEBKIT_DISABLE_DMABUF_RENDERER=1 "$HOME/.local/bin/pi-desktop-bin" "$@"`
- Flags (single-instance — they toggle the running app): `--toggle-quickbar`, `--toggle-main`
- KDE fallback shortcuts + autostart: see README "Wayland / KDE fallback".

## Backend rules

- `src-tauri/src/lib.rs` is truth. `server/web-backend.mjs` must mirror it (same commands, same semantics). Change both or neither.
- History reads are windowed (`read_session_messages`: byte budget + offset). Never load full transcripts.
- Extensions: spawn is vendored (`pi-spawn/index.ts` via Tauri resources); shadow-browser loads from the user's own pi packages. Don't add `--extension` flags without reading the resource discussion in `lib.rs`.

## Env overrides

- `PI_BIN` — pi binary path (default: PATH lookup, `~/.pi/agent/bin/pi`)
- `PI_DESKTOP_SPAWN_EXT` — spawn extension path override
- `PORT` — web-backend port (default 1423)

## Process hygiene

- Dev servers (vite `:1422`/`:1420`, backend `:1423`) + `pi --mode rpc` children linger after crashes. Reap by exact PID, verify with `ps`.
- Stale pi children carry `PI_DESKTOP_CHILD=1` in environ; backends reap ppid-1 orphans on boot (Linux).

## Contributions

- Do not commit or push unless asked. No `Co-Authored-By` lines.
