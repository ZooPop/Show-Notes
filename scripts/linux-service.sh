#!/usr/bin/env bash
# Run Show Notes automatically when you log in (Linux with systemd, e.g. Omarchy / Arch).
#   scripts/linux-service.sh install     start now and at every login
#   scripts/linux-service.sh uninstall   stop and remove
#   scripts/linux-service.sh status      is it running?  (logs: journalctl --user -u show-notes -f)
#   scripts/linux-service.sh print       show the service file without installing it
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/show-notes.service"
PORT="${PORT:-3000}"

node_path() {
  if command -v mise >/dev/null 2>&1 && mise which node >/dev/null 2>&1; then mise which node; else command -v node; fi
}

unit() {
  local node; node="$(node_path)"
  [ -n "$node" ] || { echo "Node.js not found. Install it first (Omarchy / Arch: sudo pacman -S nodejs npm)." >&2; exit 1; }
  cat <<UNIT
[Unit]
Description=Show Notes (cue tracking)
After=network-online.target pipewire.service
Wants=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$node $DIR/server.js
Environment=PORT=$PORT
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
}

case "${1:-}" in
  print) unit ;;
  install)
    [ -f "$DIR/node_modules/.package-lock.json" ] || (cd "$DIR" && npm install --no-audit --no-fund)
    mkdir -p "$UNIT_DIR"
    unit > "$UNIT"
    systemctl --user daemon-reload
    systemctl --user enable --now show-notes.service
    echo "Show Notes is running and will start at every login: http://localhost:$PORT"
    echo "To start it at boot even before anyone logs in:  loginctl enable-linger $USER"
    ;;
  uninstall)
    systemctl --user disable --now show-notes.service 2>/dev/null || true
    rm -f "$UNIT"
    systemctl --user daemon-reload
    echo "Removed. Show Notes no longer starts at login."
    ;;
  status) systemctl --user status show-notes.service --no-pager ;;
  *) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
