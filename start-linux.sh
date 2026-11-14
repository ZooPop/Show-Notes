#!/bin/bash
# Run Show Notes on Linux: ./start-linux.sh
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Install Node.js 18+ from https://nodejs.org"; exit 1; }
if [ ! -f node_modules/.package-lock.json ] || [ package.json -nt node_modules/.package-lock.json ]; then
  npm install --no-audit --no-fund
fi
(sleep 1.5; xdg-open "http://localhost:${PORT:-3000}" >/dev/null 2>&1) &
node server.js
