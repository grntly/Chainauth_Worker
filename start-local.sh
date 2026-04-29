#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  npm install
fi

export PORT="${PORT:-8080}"
export WORKER_TOKEN="${WORKER_TOKEN:-test123}"

echo "Starting ChainAuth worker on http://127.0.0.1:${PORT}"
npm run start:local
