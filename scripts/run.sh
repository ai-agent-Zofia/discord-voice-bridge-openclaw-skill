#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f .env ]; then
  echo "Missing .env. Copy .env.example and fill required values."
  exit 1
fi

if [ -d .venv ]; then
  export STT_PYTHON="$ROOT_DIR/.venv/bin/python"
fi

npm start
