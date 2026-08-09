#!/usr/bin/env bash
# Restart a command when it dies, with backoff. The local stand-in for what a
# k8s Deployment does for free — and the reason this exists: on 2026-08-05 the
# laptop slept, the Discord gateway handshake timed out inside `ws`, the bot
# exited, and nothing restarted it. The failure was silent for hours, until a
# `/join` did nothing.
#
# Deliberately dumb. It does not know what it runs and holds no state beyond the
# backoff.
#
# SUPERSEDED FOR UNATTENDED USE by the launchd deployment — see
# docs/deploy-local.md. launchd starts the stack at login, survives a closed
# terminal and a sleep/wake cycle, and distinguishes a crash (restart) from a
# bad credential (stop), none of which this script can do. It is kept only
# because `make run` still uses it to babysit a foreground bot while
# developing; do not reach for it to keep the assistant up.
set -uo pipefail

DELAY_MIN="${SUPERVISE_DELAY_MIN:-2}"
DELAY_MAX="${SUPERVISE_DELAY_MAX:-60}"
delay="$DELAY_MIN"

# Ctrl-C must stop the supervisor, not just the child, or the loop cheerfully
# restarts the thing you were trying to kill.
child=""
stop() {
  trap - INT TERM
  [ -n "$child" ] && kill "$child" 2>/dev/null
  exit 0
}
trap stop INT TERM

while true; do
  "$@" &
  child=$!
  wait "$child"
  code=$?
  child=""

  # 0 = asked to stop. 2 = bad config, which restarting cannot fix and which
  # would otherwise spin forever printing the same complaint.
  case "$code" in
  0)
    echo "supervise: exited cleanly, not restarting" >&2
    exit 0
    ;;
  2)
    echo "supervise: exit 2 (bad config) — restarting will not help, giving up" >&2
    exit 2
    ;;
  esac

  echo "supervise: exited $code, restarting in ${delay}s" >&2
  sleep "$delay"
  # Back off so a persistent failure (Discord down, token revoked) does not
  # become a hot loop hammering the API.
  delay=$((delay * 2))
  [ "$delay" -gt "$DELAY_MAX" ] && delay="$DELAY_MAX"
done
