#!/usr/bin/env bash
# Update only the paired outbound agent; preserve config, token, command state and recorder/studio services.
set -euo pipefail
APP="${1:-https://inverk-clips.lovable.app}"
[ "$(id -u)" = 0 ] || { echo 'Run with sudo'; exit 1; }
[ -s /etc/inverk-agent/token ] || { echo 'Not paired: use the Control pairing installer first'; exit 1; }
curl -fsSL "$APP/vps/inverk_agent.py" -o /opt/inverk-agent/inverk_agent.py.new
python3 -m py_compile /opt/inverk-agent/inverk_agent.py.new
mv /opt/inverk-agent/inverk_agent.py.new /opt/inverk-agent/inverk_agent.py
systemctl restart inverk-agent.service
echo 'Agent updated. Check Control for a fresh 1.2 heartbeat; existing recorder and studio were not restarted.'