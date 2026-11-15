#!/usr/bin/env bash
# Run Show Notes on Linux (Omarchy, Arch, Ubuntu, Fedora, ...):  ./start-linux.sh
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-3000}"
OSC_PORT="${OSC_PORT:-53100}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is needed. Install it, then run this again:"
  command -v pacman >/dev/null 2>&1 && echo "  Omarchy / Arch:  sudo pacman -S nodejs npm      (or with mise:  mise use -g node@lts)"
  command -v apt    >/dev/null 2>&1 && echo "  Ubuntu / Debian: sudo apt install nodejs npm"
  command -v dnf    >/dev/null 2>&1 && echo "  Fedora:          sudo dnf install nodejs npm"
  exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "Node.js $(node -v) is too old; Show Notes needs version 18 or newer."
  exit 1
fi

# Install or update dependencies when package.json has changed (e.g. after updating Show Notes).
if [ ! -f node_modules/.package-lock.json ] || [ package.json -nt node_modules/.package-lock.json ]; then
  npm install --no-audit --no-fund || exit 1
fi

# Omarchy (and many Arch setups) turn on the UFW firewall, which blocks other screens.
if command -v ufw >/dev/null 2>&1; then
  echo "Other screens can't connect? Let Show Notes through the firewall (once):"
  echo "  sudo ufw allow ${PORT}/tcp && sudo ufw allow ${OSC_PORT}/udp"
  echo "Program feed (built-in MediaMTX):"
  echo "  sudo ufw allow 8889/tcp && sudo ufw allow 8189/udp && sudo ufw allow 1935/tcp && sudo ufw allow 8888/tcp"
  echo
fi

open_browser() {
  local url="http://localhost:${PORT}"
  xdg-open "$url" >/dev/null 2>&1 && return
  command -v omarchy-launch-browser >/dev/null 2>&1 && omarchy-launch-browser "$url" >/dev/null 2>&1 && return
  for b in chromium brave brave-browser google-chrome-stable google-chrome firefox; do
    command -v "$b" >/dev/null 2>&1 && { "$b" "$url" >/dev/null 2>&1 & return; }
  done
  echo "Open $url in your browser."
}
# Only when there's a desktop to open it on (skipped over SSH / as a service), or NO_BROWSER=1
if [ -z "$NO_BROWSER" ] && { [ -n "$WAYLAND_DISPLAY" ] || [ -n "$DISPLAY" ]; }; then
  (sleep 1.5; open_browser) &
fi

exec env PORT="$PORT" OSC_PORT="$OSC_PORT" node server.js
