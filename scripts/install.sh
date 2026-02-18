#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[discord-voice-bridge] Installing Node dependencies"
if command -v npm >/dev/null 2>&1; then
  npm install
else
  echo "npm not found. Install Node.js 22+ first."
  exit 1
fi

echo "[discord-voice-bridge] Installing Python venv + STT dependencies"
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

echo "[discord-voice-bridge] Done"
