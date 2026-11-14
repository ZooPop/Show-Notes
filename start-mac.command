#!/bin/bash
# Double-click to run Show Notes on macOS.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Download the LTS version from https://nodejs.org and run this again."
  read -n 1 -s -r -p "Press any key to close..."; exit 1
fi
# Install or update dependencies when package.json has changed (e.g. after updating Show Notes).
if [ ! -f node_modules/.package-lock.json ] || [ package.json -nt node_modules/.package-lock.json ]; then
  npm install --no-audit --no-fund
fi
(sleep 1.5; open "http://localhost:${PORT:-3000}") &
node server.js
