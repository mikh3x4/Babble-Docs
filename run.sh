#!/usr/bin/env bash
# Start Babbel Docs: sets up the venv and deps on first run, then launches the server.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d venv ]; then
  echo "Creating virtualenv..."
  python3 -m venv venv
fi
source venv/bin/activate

pip install -q -r requirements.txt

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env - add your ANTHROPIC_API_KEY to it, then re-run." >&2
  exit 1
fi
if ! grep -q "ANTHROPIC_API_KEY=sk-" .env && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Warning: no ANTHROPIC_API_KEY found in .env or environment - translation will fail." >&2
fi

if command -v fc-list >/dev/null && ! fc-list | grep -qi "cjk"; then
  echo "Note: no CJK fonts found; Chinese PDF export will show boxes." >&2
  echo "      Fix with: sudo apt-get install fonts-noto-cjk" >&2
fi

exec python main.py
