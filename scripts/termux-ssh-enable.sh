#!/bin/sh
# pi-desktop: host side of the Termux remote dev shell over adb.
# One-time setup (re-runnable): dedicated key, push phone setup + pubkey to
# /sdcard, forward the port. Then, in Termux, run:
#   sh /sdcard/pi-ssh-setup.sh
# (no typing needed: with Termux in the foreground,
#   adb shell input text 'sh%s/sdcard/pi-ssh-setup.sh' && adb shell input keyevent 66)
# Afterwards this script's ssh line just works — full shell, no screenshots.
set -e
KEY="${KEY:-$HOME/.ssh/pi-termux}"
PORT="${PORT:-8022}"
USER_AT="${TERMUX_USER:-termux}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$KEY" ] || ssh-keygen -t ed25519 -f "$KEY" -N "" -C "pi-termux-dev"
adb push "$ROOT/scripts/termux-ssh-phone.sh" /sdcard/pi-ssh-setup.sh
adb push "$KEY.pub" /sdcard/pi-termux.pub
adb forward "tcp:$PORT" "tcp:$PORT"
echo "--- in Termux, run:  sh /sdcard/pi-ssh-setup.sh"
echo "--- then connect: ssh -p $PORT -i $KEY -o StrictHostKeyChecking=accept-new $USER_AT@127.0.0.1"
if ssh -p "$PORT" -i "$KEY" -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=5 "$USER_AT@127.0.0.1" 'echo SSH-OK; whoami' 2>&1; then
  echo "--- remote shell live"
else
  echo "--- not up yet (phone script probably hasn't run) — retry the ssh line after running it"
fi
