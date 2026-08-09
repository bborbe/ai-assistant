#!/usr/bin/env bash
# Launch one discord-assistant component under launchd.
#
# THE EXIT CODE IS THE CONTRACT. The plists use KeepAlive/SuccessfulExit=false,
# so launchd restarts a job only when it exits non-zero:
#
#   non-zero  the process crashed        -> launchd restarts it
#   0         unrecoverable config error -> launchd leaves it stopped
#
# That is why every configuration failure below exits 0 rather than 1. It looks
# wrong in isolation and is the whole point: a revoked token restarted forever
# hammers the Discord API with a credential that will never work. Supersedes
# scripts/supervise.sh, whose exit-2 rule this reproduces natively.
#
# Secrets are resolved HERE, at launch, never stored in the plist —
# EnvironmentVariables is a literal dict and would put them on disk in cleartext.
#
#   scripts/launchd-run.sh <shim|s2s|transcriber|bot>

set -uo pipefail

# WHY THIS SCRIPT IS DEPLOYED OUTSIDE THE REPO.
#
# launchd cannot execute anything stored under ~/Documents — TCC denies it and
# the job dies with exit 126, "Operation not permitted", before a single line
# runs. It is not a chmod problem and not specific to LaunchDaemons; a
# LaunchAgent hits it too. Measured 2026-08-09 with a probe: the same script in
# /tmp ran fine and read this repo without complaint; moved into the repo, it
# would not start.
#
# So `make launchd-install` copies this file to ~/.local/bin (not protected,
# and where uv and semantic-search-http already live for the same reason) and
# points the plists there. Reading the repo afterwards is fine — only *being
# executed* from a protected folder is blocked.
#
# The repo therefore cannot be inferred from $0 in the installed copy; the
# plist passes it. Running this file in place still works, for development.
cd "${DISCORD_ASSISTANT_REPO:-$(dirname "$0")/..}" || {
  echo "launchd-run: cannot enter repo ${DISCORD_ASSISTANT_REPO:-$(dirname "$0")/..}" >&2
  exit 0
}

component="${1:-}"

# Exit 0 on purpose — see the header. Restarting cannot fix any of these.
die_config() {
  echo "launchd-run[${component:-?}]: $*" >&2
  echo "launchd-run[${component:-?}]: unrecoverable config error, not restarting" >&2
  exit 0
}

# Exit NON-zero, so KeepAlive restarts us. For anything that might work on a
# retry.
die_transient() {
  echo "launchd-run[${component:-?}]: $*" >&2
  echo "launchd-run[${component:-?}]: transient failure, letting launchd retry" >&2
  exit 75 # EX_TEMPFAIL; being non-zero is what actually matters
}

# Resolve a TeamVault secret into RESOLVED_SECRET, distinguishing "this key will
# never work" from "TeamVault happened to be unreachable".
#
# Found the hard way on 2026-08-09: a TeamVault request timed out, the launcher
# called it a config error, and the bot stopped and stayed stopped — recreating
# the exact silent outage this deployment exists to prevent. Only a definitive
# rejection stops the job now; everything else retries. A job that retries too
# often is visible in the log, a job that stopped when it should not have is
# invisible until someone notices the assistant is gone.
#
# NOTE: sets a global rather than printing. Called via $( ), die_config's exit
# would end the subshell and the caller would sail on with an empty token.
RESOLVED_SECRET=""
resolve_secret() {
  key="$1"
  name="$2"
  out=$(teamvault-cli password "$key" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
    RESOLVED_SECRET="$out"
    return 0
  fi
  case "$out" in
  # Absent, or we may not read it. No retry fixes either. 408/429 deliberately
  # excluded — those are retryable and must not match.
  *"status: 401"* | *"status: 403"* | *"status: 404"*)
    die_config "$name=$key rejected by TeamVault: $out"
    ;;
  esac
  if [ "$rc" -eq 0 ]; then
    die_config "$name=$key resolved to an empty value"
  fi
  die_transient "TeamVault unreachable resolving $name=$key: $out"
}

case "$component" in
shim | s2s | transcriber | bot) ;;
*) die_config "usage: launchd-run.sh <shim|s2s|transcriber|bot>" ;;
esac

[ -f local.env ] || die_config "local.env missing — cp local.env.example local.env"
set -a
# shellcheck disable=SC1091
. ./local.env
set +a

# Per-component secret isolation. local.env deliberately holds no secrets, only
# the TeamVault key *ids*, so the only secrets in this process are the ones
# resolved below — and each component resolves only its own. CHAT_BRIDGE_TOKEN
# is the exception: it is a real shared secret in local.env, needed by the bot
# and the shim (they authenticate to each other with it) and by neither of the
# other two, so drop it there rather than letting it ride along.
case "$component" in
s2s | transcriber) unset CHAT_BRIDGE_TOKEN ;;
esac

case "$component" in
shim)
  # Without this the assistant is never told where a call's transcript lives,
  # the pointer is silently omitted, and "what did we just discuss?" fails with
  # no error. Wired here rather than left to whoever remembers to export it.
  export SHIM_TRANSCRIPT_DIR="${TRANSCRIPT_DIR:-}"
  if [ -n "${FRONT_API_KEY_ID:-}" ] && [ -z "${SHIM_FRONT_API_KEY:-}" ]; then
    command -v teamvault-cli >/dev/null 2>&1 || die_config "teamvault-cli not on PATH"
    resolve_secret "$FRONT_API_KEY_ID" FRONT_API_KEY_ID
    SHIM_FRONT_API_KEY="$RESOLVED_SECRET"
    export SHIM_FRONT_API_KEY
  fi
  exec python3 -u shim/claude_openai_shim.py
  ;;

s2s)
  launcher="${S2S_LAUNCHER:-$PWD/scripts/s2s-minimax}"
  [ -x "$launcher" ] || die_config "s2s launcher not executable: $launcher"
  export S2S_MODE=realtime
  exec "$launcher"
  ;;

transcriber)
  command -v uv >/dev/null 2>&1 || die_config "uv not on PATH"
  exec uv run tools/transcriber.py
  ;;

bot)
  command -v teamvault-cli >/dev/null 2>&1 || die_config "teamvault-cli not on PATH"
  [ -n "${DISCORD_TOKEN_KEY:-}" ] || die_config "DISCORD_TOKEN_KEY unset in local.env"
  # Resolved here, at launch, and never via a Make $(shell ) — Make would expand
  # that itself and bake the literal token into the sh -c argv, readable by any
  # process via ps. Same reason the `run` target uses $$( ).
  resolve_secret "$DISCORD_TOKEN_KEY" DISCORD_TOKEN_KEY
  DISCORD_TOKEN="$RESOLVED_SECRET"
  export DISCORD_TOKEN
  # No supervise.sh wrapper: launchd is the supervisor now, and nesting one
  # inside the other would hide the exit code the KeepAlive rule depends on.
  exec node src/index.js
  ;;
esac
