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
# Exit 0 is reachable ONLY via die_config. The components are not exec'd but run
# under run_server(), which turns any exit of theirs into 75 — because a
# long-running server that returns has failed, whatever status it reports. That
# is not theoretical: `uv run` exits 0 when signalled directly, so a killed
# speech-to-speech read as a successful job and launchd correctly left it down.
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

# Run the component and treat ANY exit from it as abnormal.
#
# These are long-running servers: reaching the end of one is never a success,
# whatever status it reports. That distinction was previously left to the exit
# code, and `uv run` gets it wrong in the one case that matters — measured
# 2026-08-10:
#
#   kill the python CHILD of `uv run`  -> uv exits 143 (signal propagated)
#   kill `uv run` ITSELF               -> uv exits 0   (clean shutdown)
#
# The plist sets KeepAlive/SuccessfulExit=false, so exit 0 means "do not
# restart" — deliberately, since die_config uses it to stop a job whose config
# can never work. A killed `uv` therefore looked like a job that had finished
# its work, and speech-to-speech stayed down until someone noticed voice was
# gone. That is the same silent outage the TeamVault fix above exists to
# prevent, arriving from the opposite direction: there a transient failure was
# treated as fatal, here a fatal one was treated as success.
#
# So the program is no longer exec'd. This wrapper stays alive as the launchd
# job, and translates "the server came back" into exit 75 regardless of what it
# reported. exit 0 is now reachable ONLY through die_config, which is what makes
# the "bad config stops the job" contract mean something.
#
# The trap is what makes not-exec'ing safe: launchd stops a job by signalling
# the process it spawned, which is now this shell, so the signal has to be
# forwarded or the real server would be orphaned on unload.
run_server() {
  "$@" &
  child=$!
  trap 'kill -TERM "$child" 2>/dev/null' TERM INT
  # `wait` returns early when a trapped signal arrives; loop until the child is
  # genuinely gone, or a forwarded SIGTERM would look like an exit.
  wait "$child"
  rc=$?
  while kill -0 "$child" 2>/dev/null; do
    wait "$child"
    rc=$?
  done
  if [ "$rc" -gt 128 ]; then
    die_transient "$component exited on signal $((rc - 128))"
  fi
  die_transient "$component exited with status $rc — a server exiting is never success"
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

# Per-component secret isolation. local.env holds no secrets, only the
# TeamVault key *ids*, so the only secrets in this process are the ones
# resolved below — and each component resolves only its own.
#
# CHAT_BRIDGE_TOKEN used to be the one exception: a real shared secret sitting
# in local.env, which put it in every checkout of a public repo. It now follows
# the same key-id rule as everything else, resolved from CHAT_BRIDGE_TOKEN_KEY.
#
# It is still the one secret TWO components share: the bot and the shim
# authenticate to each other with it. s2s and transcriber need it for nothing,
# so they never resolve it — that is the isolation, and it is now enforced by
# not fetching rather than by unsetting after the fact.
#
# Unset unconditionally first: an operator's shell (or a stale local.env) can
# still export the literal, and inheriting it would silently defeat both the
# key-id rule and the per-component split.
unset CHAT_BRIDGE_TOKEN
case "$component" in
bot | shim)
  if [ -n "${CHAT_BRIDGE_TOKEN_KEY:-}" ]; then
    command -v teamvault-cli >/dev/null 2>&1 || die_config "teamvault-cli not on PATH"
    resolve_secret "$CHAT_BRIDGE_TOKEN_KEY" CHAT_BRIDGE_TOKEN_KEY
    CHAT_BRIDGE_TOKEN="$RESOLVED_SECRET"
    export CHAT_BRIDGE_TOKEN
  fi
  ;;
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
  run_server python3 -u shim/claude_openai_shim.py
  ;;

s2s)
  launcher="${S2S_LAUNCHER:-$PWD/scripts/s2s-minimax}"
  [ -x "$launcher" ] || die_config "s2s launcher not executable: $launcher"
  export S2S_MODE=realtime
  # The launcher is named for its DEFAULT backend and hardcodes
  # `--responses_api_base_url https://api.minimax.io/v1`. It only reaches Claude
  # Code because trailing "$@" args override those flags — so launching it bare
  # silently routes voice to MiniMax. Nothing errors: the bot answers, in a
  # different voice, with no vault access, leaking MiniMax's own tool-call
  # markup into replies. Shipped exactly that way in v0.8.0 and caught by using
  # it, not by any check.
  #
  # Overrides come from local.env, so voice and text cannot drift onto
  # different endpoints. `not-needed` is a literal, not a secret, so passing it
  # in argv leaks nothing — unlike the MiniMax key, which s2s-minimax
  # deliberately exports rather than passes as a flag.
  [ -n "${OPENAI_BASE_URL:-}" ] || die_config "OPENAI_BASE_URL unset in local.env — voice would silently fall back to MiniMax"
  [ -n "${OPENAI_MODEL:-}" ] || die_config "OPENAI_MODEL unset in local.env — voice would silently fall back to MiniMax"
  run_server "$launcher" \
    --responses_api_base_url "$OPENAI_BASE_URL" \
    --responses_api_api_key "${OPENAI_API_KEY:-not-needed}" \
    --model_name "$OPENAI_MODEL"
  ;;

transcriber)
  command -v uv >/dev/null 2>&1 || die_config "uv not on PATH"
  run_server uv run tools/transcriber.py
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
  run_server node src/index.js
  ;;
esac
