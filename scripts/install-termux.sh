#!/bin/sh
# pi-desktop Termux install: headless --server backend only.
# Run inside Termux from the repo root:  sh scripts/install-termux.sh
# Idempotent — safe to re-run. No root, everything under $PREFIX.
# No pi extensions here: pi-spawn / pi-shadow-browser are unproven on
# Termux (and shadow-browser needs a real browser). Install manually
# later if you want them:  pi install git:github.com/pi-ecosystem/pi-spawn
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "→ pkg deps (rust, git, clang)"
pkg install -y rust git clang

echo "→ cargo build --bin pi-desktop (debug: release LTO is too heavy for a phone)"
cargo build --manifest-path src-tauri/Cargo.toml --bin pi-desktop

BIN="$ROOT/src-tauri/target/debug/pi-desktop"
DEST="$PREFIX/bin/pi-desktop-server"
echo "→ install $DEST"
cp -f "$BIN" "$DEST"
chmod 755 "$DEST"

# A replaced binary doesn't replace the running process — and the app only
# boots the server when the port is down, so a live backend keeps serving
# the OLD code forever (stale ENOENT spawns and all). Stop it here; the
# next app open auto-boots this fresh binary over RUN_COMMAND.
# (-f: comm truncates to 15 chars so -x can never match this 18-char name;
# the pattern is the full install path, nothing else on the phone matches.)
if pgrep -f "$DEST" >/dev/null 2>&1; then
  echo "→ stopping live backend (old binary still in memory)"
  pkill -f "$DEST" || true
fi

if ! command -v pi >/dev/null 2>&1; then
  echo "warn: 'pi' not on PATH — install the pi CLI first (the backend spawns it)."
fi

PORT="${PORT:-1423}"
echo "done."
echo ""
echo "Phone setup (Termux side, all required for the APK auto-boot):"
echo "  1. allow-external-apps: echo 'allow-external-apps=true' >> ~/.termux/termux.properties"
echo "  2. allow external apps: Termux:API app installed (same source as Termux)"
echo "  3. restart Termux completely (swipe it away), then:"
echo "     pi-desktop-server --server ${PORT}"
echo "  4. open the Pi app — it boots the server itself from here on"
