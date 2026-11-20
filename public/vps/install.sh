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
# The studio may run with DynamicUser=yes: /var/lib/inverk-studio is then a symlink to /var/lib/private/inverk-studio.
# Resolve it so sandboxing (ReadWritePaths) and the agent use the real directory.
STUDIO="$(readlink -f /var/lib/inverk-studio 2>/dev/null || echo /var/lib/inverk-studio)"
[ -f "$STUDIO/reddit-studio.sqlite3" ] || echo "warning: $STUDIO/reddit-studio.sqlite3 not found (archive will show as missing)"
[ -f "$STUDIO/buffer.key" ] || echo "warning: $STUDIO/buffer.key not found (Buffer will show as unavailable)"
printf '{"server": "%s", "db": "%s/reddit-studio.sqlite3", "buffer_key": "%s/buffer.key"}\n' "$APP" "$STUDIO" "$STUDIO" > /etc/inverk-agent/config.json
chmod 0600 /etc/inverk-agent/config.json
INVERK_AGENT_CONF=/etc/inverk-agent INVERK_AGENT_STATE=/var/lib/inverk-agent python3 /opt/inverk-agent/inverk_agent.py pair "$CODE"
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
Environment=INVERK_AGENT_CONF=/etc/inverk-agent INVERK_AGENT_STATE=/var/lib/inverk-agent
ReadWritePaths=$STUDIO /var/lib/inverk-agent /etc/inverk-agent
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now inverk-agent.service
sleep 3; systemctl --no-pager --lines=5 status inverk-agent.service || true
echo "done: check the badge in Inverk Clips"
