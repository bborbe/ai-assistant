#!/usr/bin/env bash
# Start the whole local stack and stop it cleanly on Ctrl-C.
#
#   scripts/dev.sh              shim + speech-to-speech + transcriber + bot
#   SKIP_VOICE=1 scripts/dev.sh shim + bot only (text surface; starts in seconds)
#   SKIP_TRANSCRIBER=1 …        no voice transcription
#
# speech-to-speech is the slow part — it loads STT and TTS models, ~60s cold.
# Skip it unless you actually want to talk.

set -uo pipefail
cd "$(dirname "$0")/.."

[ -f local.env ] || { echo "local.env missing — run: cp local.env.example local.env" >&2; exit 1; }
set -a; . ./local.env; set +a

# In-repo, so a fresh clone works with no external dependency.
S2S_LAUNCHER="${S2S_LAUNCHER:-$PWD/scripts/s2s-minimax}"
SHIM_PORT="${SHIM_PORT:-8080}"
S2S_PORT="${S2S_PORT:-8765}"
LOGDIR="${LOGDIR:-/tmp/discord-assistant}"
mkdir -p "$LOGDIR"

pids=()
cleanup() {
  echo
  echo "stopping…"
  # Kill children first so the bot can leave voice channels before the socket dies.
  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null; done
  sleep 1
  for pid in "${pids[@]}"; do kill -KILL "$pid" 2>/dev/null; done
}
trap cleanup EXIT INT TERM

# Wait for a listener rather than sleeping a fixed time — model load is variable.
wait_for_port() {
  local port=$1 name=$2 tries=${3:-60}
  for _ in $(seq "$tries"); do
    lsof -i ":$port" -sTCP:LISTEN >/dev/null 2>&1 && { echo "  $name ready on :$port"; return 0; }
    sleep 2
  done
  echo "  $name did NOT come up on :$port — see $LOGDIR" >&2
  return 1
}

already() { lsof -i ":$1" -sTCP:LISTEN >/dev/null 2>&1; }

if already "$SHIM_PORT"; then
  echo "  shim already running on :$SHIM_PORT, reusing"
else
  echo "starting shim…"
  python3 -u shim/claude_openai_shim.py > "$LOGDIR/shim.log" 2>&1 &
  pids+=($!)
  wait_for_port "$SHIM_PORT" shim 15 || exit 1
fi

if [ "${SKIP_VOICE:-}" = "1" ]; then
  echo "  skipping speech-to-speech (SKIP_VOICE=1) — text surface only"
elif already "$S2S_PORT"; then
  echo "  speech-to-speech already running on :$S2S_PORT, reusing"
elif [ -x "$S2S_LAUNCHER" ]; then
  echo "starting speech-to-speech (loads models, ~60s)…"
  S2S_MODE=realtime "$S2S_LAUNCHER" > "$LOGDIR/s2s.log" 2>&1 &
  pids+=($!)
  wait_for_port "$S2S_PORT" speech-to-speech 90 || echo "  continuing without voice"
else
  echo "  no s2s launcher at $S2S_LAUNCHER — continuing without voice" >&2
fi

# Transcription: separate process on purpose, so slow or failing STT never
# stalls a live conversation. Deps resolve inline via uv (PEP 723).
if [ "${SKIP_TRANSCRIBER:-}" = "1" ]; then
  echo "  skipping transcriber (SKIP_TRANSCRIBER=1)"
elif pgrep -f "transcriber.py" >/dev/null 2>&1; then
  echo "  transcriber already running, reusing"
else
  echo "starting transcriber…"
  uv run tools/transcriber.py > "$LOGDIR/transcriber.log" 2>&1 &
  pids+=($!)
fi

echo "starting bot…"
make run
