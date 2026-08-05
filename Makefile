include Makefile.variables
include Makefile.precommit
include Makefile.docker
# Local, gitignored config. There is no committed env file on purpose: Make
# variables override the environment, so a committed empty `export DISCORD_TOKEN=`
# would silently clobber the shell. Start from local.env.example.
#
# NOTE: recipes that need values containing `$` or spaces source this file in
# the SHELL instead of relying on this include — Make would read `$HOME` as an
# (empty) Make variable and keep the quotes literally, yielding paths like
# `"OME/Documents/...`.
-include local.env

SERVICE = bborbe/discord-assistant

.PHONY: all
all: precommit

.PHONY: install
# Install dependencies from the lockfile
install:
	@npm ci

.PHONY: run
# Run the bot. The token is resolved from TeamVault at run time, so it never
# lands on disk. Note $$( ) not $(shell ) — Make expands $(shell ) itself, which
# would bake the literal token into the sh -c argv and expose it to `ps`.
run: require-config
	@command -v teamvault-cli >/dev/null 2>&1 || { echo "teamvault-cli not on PATH" >&2; exit 1; }
	@set -a; . ./local.env; set +a; \
	DISCORD_TOKEN=$$(teamvault-cli password $$DISCORD_TOKEN_KEY); \
	[ -n "$$DISCORD_TOKEN" ] || { echo "empty token from TeamVault key $$DISCORD_TOKEN_KEY" >&2; exit 1; }; \
	export DISCORD_TOKEN; bash scripts/supervise.sh node src/index.js

.PHONY: dev
# Start the whole local stack: shim, speech-to-speech, bot. Ctrl-C stops all.
# SKIP_VOICE=1 make dev  -> text surface only, starts in seconds.
dev: require-config
	@bash scripts/dev.sh

.PHONY: require-config
# Fail with a useful message rather than an empty-token error.
require-config:
	@test -f local.env || { echo "local.env missing — run: cp local.env.example local.env" >&2; exit 1; }

.PHONY: transcriber
# Watch for voice segments and append speaker-labelled transcripts.
# Dependencies are declared inline in the script (PEP 723), so uv resolves them
# — no speech-to-speech checkout required. Separate from the bot on purpose:
# STT must never stall a live conversation.
transcriber:
	@set -a; . ./local.env; set +a; \
	uv run tools/transcriber.py

.PHONY: shim
# Run the Claude Code OpenAI-compatible shim
shim:
	@set -a; [ -f local.env ] && . ./local.env; set +a; \
	SHIM_TRANSCRIPT_DIR="$$TRANSCRIPT_DIR"; export SHIM_TRANSCRIPT_DIR; \
	if [ -n "$$FRONT_API_KEY_ID" ]; then \
	  SHIM_FRONT_API_KEY=$$(teamvault-cli password $$FRONT_API_KEY_ID); \
	  export SHIM_FRONT_API_KEY; \
	fi; \
	python3 -u shim/claude_openai_shim.py

.PHONY: clean-local
# Clean build artifacts (local)
clean-local:
	rm -rf node_modules coverage out
