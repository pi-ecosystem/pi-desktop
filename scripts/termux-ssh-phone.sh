#!/bin/sh
# pi-desktop: phone side of the remote dev shell over adb.
# The host helper (scripts/termux-ssh-enable.sh) pushes this file plus your
# pubkey to /sdcard; in Termux you run one short command:
#   sh /sdcard/pi-ssh-setup.sh
# Idempotent — safe to re-run. Key-only auth, localhost-bound (adb only),
# so the port is reachable solely through `adb forward`.
set -e
PUB="${1:-/sdcard/pi-termux.pub}"
PORT="${PORT:-8022}"
command -v sshd >/dev/null 2>&1 || pkg install -y openssh
mkdir -p ~/.ssh
chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
if [ -f "$PUB" ]; then
  cat "$PUB" >> ~/.ssh/authorized_keys
  sort -u ~/.ssh/authorized_keys -o ~/.ssh/authorized_keys
else
  echo "warn: $PUB not found — keeping existing authorized_keys" >&2
fi
pkill -x sshd 2>/dev/null || true
# shellcheck disable=SC2086
sshd -o "ListenAddress 127.0.0.1" -o "Port $PORT" -o PasswordAuthentication=no
echo "sshd up on 127.0.0.1:$PORT (key-only). Back on the host, ssh in — see scripts/termux-ssh-enable.sh."
