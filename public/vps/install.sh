#!/usr/bin/env bash
# Inverk VPS agent installer for Debian. Usage: curl -fsSL <app>/vps/install.sh | sudo bash -s -- <PAIR_CODE> <APP_URL>
# Leaves existing services and /var/lib/inverk-studio data untouched; installs only the outbound agent.
set -euo pipefail
CODE="${1:?pair code required}"; APP="${2:-https://inverk-clips.lovable.app}"
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
command -v python3 >/dev/null || { apt-get update && apt-get install -y python3; }
install -d -m 0755 /opt/inverk-agent; install -d -m 0700 /etc/inverk-agent /var/lib/inverk-agent
curl -fsSL "$APP/vps/inverk_agent.py" -o /opt/inverk-agent/inverk_agent.py.new
python3 -m py_compile /opt/inverk-agent/inverk_agent.py.new && mv /opt/inverk-agent/inverk_agent.py.new /opt/inverk-agent/inverk_agent.py
[ -f /etc/inverk-agent/config.json ] || printf '{"server": "%s"}\n' "$APP" > /etc/inverk-agent/config.json
chmod 0600 /etc/inverk-agent/config.json
[ -f /var/lib/inverk-studio/reddit-studio.sqlite3 ] || echo "warning: /var/lib/inverk-studio/reddit-studio.sqlite3 not found (archive will show as missing)"
[ -f /var/lib/inverk-studio/buffer.key ] || echo "warning: /var/lib/inverk-studio/buffer.key not found (Buffer will show as unavailable)"
python3 /opt/inverk-agent/inverk_agent.py pair "$CODE"
cat > /etc/systemd/system/inverk-agent.service <<UNIT
[Unit]
Description=Inverk Clips VPS agent (outbound)
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/bin/python3 /opt/inverk-agent/inverk_agent.py
Restart=always
RestartSec=10
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/inverk-studio /var/lib/inverk-agent /etc/inverk-agent
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now inverk-agent.service
sleep 3; systemctl --no-pager --lines=5 status inverk-agent.service || true
echo "done: check the badge in Inverk Clips"
