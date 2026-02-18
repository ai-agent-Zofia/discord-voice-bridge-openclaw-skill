#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[verify] Checking required files"
[ -f package.json ] && [ -f src/bot.mjs ] && [ -f scripts/stt_worker.py ]

echo "[verify] Node version"
node -v

echo "[verify] python3 version"
python3 --version

echo "[verify] npm dependency tree (top-level)"
npm ls --depth=0 >/dev/null

echo "[verify] Python STT import"
if [ -x .venv/bin/python ]; then
  .venv/bin/python -c "import faster_whisper; print('ok faster_whisper')"
else
  python3 -c "import faster_whisper; print('ok faster_whisper')"
fi

echo "[verify] OK"
