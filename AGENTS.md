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
  owned pi extensions (`pi install` for pi-spawn/shadow-browser).
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
  (vendored copy + user install = dead child). Both pi-spawn and
  shadow-browser load from the user's own pi packages; only an explicit
  `PI_DESKTOP_SPAWN_EXT` override is honored.

## Env overrides

- `PI_BIN` — pi binary path (default: PATH lookup, `~/.pi/agent/bin/pi`)
- `PI_DESKTOP_SPAWN_EXT` — spawn extension path override
- `PI_DESKTOP_APP_PROMPT` — prompt file override: path to a replacement for
  the bundled `src/system-prompt.md`, or `0`/`off` to skip it. The effective
  text is passed to pi children via `--append-system-prompt` plus
  `PI_DESKTOP_APP_PROMPT_TEXT` env so pi-spawn grandchildren re-append it.
  Prompt changes edit the md file only — never the backends.
- `PORT` — backend server port (default 1423)

## Process hygiene

- Dev servers (vite `:1422`/`:1420`, backend `:1423`) + `pi --mode rpc` children linger after crashes. Reap by exact PID, verify with `ps`.
- Stale pi children carry `PI_DESKTOP_CHILD=1` in environ; backends reap ppid-1 orphans on boot (Linux).

## Android (APK boots Termux backend)

- Build: `npx tauri android build --apk --target aarch64` with
  `ANDROID_HOME=~/Android/Sdk NDK_HOME=~/.android/ndk/android-ndk-r27c
  JAVA_HOME=/usr/lib/jvm/java-17-openjdk` (Gradle fails on newer JDKs).
  Sign with apksigner + `~/.android/debug.keystore` (pass `android`).
- `src-tauri/gen/` is gitignored. After any fresh `tauri android init`,
  re-apply: `<queries>` for `com.termux` + `com.termux.api` in
  `gen/android/app/src/main/AndroidManifest.xml` (else the boot plugin
  always reports Termux missing on Android 11+).
- Debug on-device: `adb logcat`, screenshots via
  `adb exec-out screencap -p` (readable as images here).
- Remote Termux shell (full I/O stream, no screenshots/typing):
  `sh scripts/termux-ssh-enable.sh` generates `~/.ssh/pi-termux`, pushes
  the phone setup + pubkey to /sdcard, and forwards 8022. Then in Termux
  run `sh /sdcard/pi-ssh-setup.sh` (one short command; or inject it with
  Termux in the foreground via
  `adb shell input text 'sh%s/sdcard/pi-ssh-setup.sh'` + Enter keyevent
  66). Connect: `ssh -p 8022 -i ~/.ssh/pi-termux termux@127.0.0.1`.
  Key-only, sshd bound to 127.0.0.1 (adb-forward only). Direct shell
  (`adb shell`) can never reach Termux (separate UID/sandbox) and
  `am`-fired RUN_COMMAND intents are rejected from shell — the app (which
  holds the runtime RUN_COMMAND grant) or this ssh channel are the only
  ways in.
- Stale-server trap: `install-termux.sh` replaces the binary but the app
  only boots the server when the port is DOWN — a live backend keeps
  serving old code. The script now kills the live backend after install;
  next app open auto-boots fresh. Symptom of staleness: `/proc/<pid>/exe`
  reads `(deleted)` and md5(exe) ≠ md5($PREFIX/bin/pi-desktop-server).
- After any fresh `tauri android init`, also re-apply in
  `gen/android/app/build.gradle.kts`: release `usesCleartextTraffic`
  must be `"true"` (app talks to Termux backend over localhost HTTP;
  Tauri's release default `false` blocks even loopback).

## Contributions

- Do not commit or push unless asked. No `Co-Authored-By` lines.
