#!/bin/bash
# Double-click to run Show Notes on macOS.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Download the LTS version from https://nodejs.org and run this again."
  read -n 1 -s -r -p "Press any key to close..."; exit 1
fi
[ -d node_modules ] || npm install --no-audit --no-fund
(sleep 1.5; open "http://localhost:${PORT:-3000}") &
node server.js
