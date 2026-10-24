# AGENTS.md — pi-desktop dev notes

Read this before starting/stopping anything. Two runtimes, same frontend.

## Web mode (quickest, no Rust)

- `npm run dev:web` → frontend `:1422`, api `:1423`, open `http://localhost:1422/`
- Backend is the Rust binary in `--server` mode (dev only). Window ops are no-ops in a tab; everything else is real.
- Stop: kill the exact PIDs (`vite`, `pi-desktop --server`). Never `pkill -f` with a pattern matching your own command.

## App mode (Tauri, needs Rust + WebKitGTK)

- `npx tauri dev` (cargo must be on PATH; NVIDIA+Wayland: prefix `WEBKIT_DISABLE_DMABUF_RENDERER=1`)
- Global hotkeys need Accessibility permission, else they fire only when focused.

## Build + install (all platforms)

- Standard: `node scripts/install.mjs` — release build + app install +
  owned pi extensions (`pi install` for pi-jobs/shadow-browser).
  Flags: `--skip-build`, `--extensions-only`, `--skip-extensions`.
- Manual (Linux): `npm run build && npx tauri build --bundles deb`, then copy
  `src-tauri/target/release/pi-desktop` to `~/.local/bin/pi-desktop-bin` plus
  the wrapper (see README). Release Rust builds take minutes — background
  them, poll the log. No sudo anywhere.
- Flags (single-instance — they toggle the running app): `--toggle-quickbar`, `--toggle-main`
- KDE fallback shortcuts + autostart: see README "Wayland / KDE fallback".

## Backend rules

- Backend core is shared: Tauri IPC commands + `--server` HTTP dispatch onto the same fns (`src-tauri/src/server.rs`). One implementation, no mirror to keep in sync.
- History reads are windowed (`read_session_messages`: byte budget + offset). Never load full transcripts.
- Extensions: never `--extension` anything by default. pi dedupes an
  identical path but FATALS on the same tool from two different paths
  (vendored copy + user install = dead child). Both pi-jobs and
  shadow-browser load from the user's own pi packages; only an explicit
  `PI_DESKTOP_JOBS_EXT` override is honored.

## Env overrides

- `PI_BIN` — pi binary path (default: PATH lookup, `~/.pi/agent/bin/pi`)
- `PI_DESKTOP_JOBS_EXT` — jobs extension path override
- `PI_DESKTOP_APP_PROMPT` — prompt file override: path to a replacement for
  the bundled `src/system-prompt.md`, or `0`/`off` to skip it. The effective
  text is passed to pi children via `--append-system-prompt` plus
  `PI_DESKTOP_APP_PROMPT_TEXT` env so pi-spawn grandchildren re-append it.
  Prompt changes edit the md file only — never the backends.
- `PORT` — backend server port (default 1423)

## Process hygiene

- Dev servers (vite `:1422`/`:1420`, backend `:1423`) + `pi --mode rpc` children linger after crashes. Reap by exact PID, verify with `ps`.
- Stale pi children carry `PI_DESKTOP_CHILD=1` in environ; backends reap ppid-1 orphans on boot (Linux).

## Android (APK: direct chat, or remote link to the desktop backend)

- Build: `npx tauri android build --apk --target aarch64` with
  `ANDROID_HOME=~/Android/Sdk NDK_HOME=~/.android/ndk/android-ndk-r27c
  JAVA_HOME=/usr/lib/jvm/java-17-openjdk` (Gradle fails on newer JDKs).
  Sign with apksigner + `~/.android/debug.keystore` (pass `android`).
- `src-tauri/gen/` is gitignored. No Termux: the APK never shells out —
  direct chat calls the provider API, remote mode talks HTTP to the
  desktop backend (user handles reachability: Tailscale/LAN).
- Debug on-device: `adb logcat`, screenshots via
  `adb exec-out screencap -p` (readable as images here).
- After any fresh `tauri android init`, re-apply in
  `gen/android/app/build.gradle.kts`: release `usesCleartextTraffic`
  must be `"true"` (remote HTTP to a LAN desktop; Tauri's release
  default `false` blocks even loopback).

## Contributions

- Do not commit or push unless asked. No `Co-Authored-By` lines.
