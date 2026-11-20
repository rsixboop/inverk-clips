#!/usr/bin/env bash
# Run from a project checkout on Ubuntu 24.04 as root.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
src=$(cd "$(dirname "$0")/.." && pwd)/public/recorder/recorder.py
test -s "$src"
config=/etc/inverk-recorder.env
if [[ ! -s $config ]]; then
  read -rsp 'Recorder token from Sources: ' token </dev/tty
  echo
  [[ $token =~ ^lrw_[a-fA-F0-9]{64}$ ]] || { echo 'Invalid token format.' >&2; exit 1; }
  (umask 077; tmp=$(mktemp /etc/.inverk-recorder.XXXXXX); trap 'rm -f "$tmp"' EXIT
   printf 'INVERK_WORKER_TOKEN=%s\nINVERK_URL=https://prompt-to-pocket-clips.lovable.app\n' "$token" > "$tmp"
   mv "$tmp" "$config")
  unset token
fi
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg python3-venv ca-certificates
install -d /opt/inverk-recorder
python3 -m venv /opt/inverk-recorder/venv
/opt/inverk-recorder/venv/bin/pip install --disable-pip-version-check 'streamlink==8.6.3'
install -m 644 "$src" /opt/inverk-recorder/recorder.py
install -m 644 "$(dirname "$0")/inverk-recorder.service" /etc/systemd/system/inverk-recorder.service
systemctl daemon-reload
systemctl enable inverk-recorder.service
systemctl restart inverk-recorder.service
systemctl --no-pager status inverk-recorder.service
