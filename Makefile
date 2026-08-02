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
S2S_DIR ?= $(HOME)/Documents/workspaces/speech-to-speech

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
	export DISCORD_TOKEN; node src/index.js

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
# Runs in the speech-to-speech venv (Parakeet MLX lives there), and is separate
# from the bot on purpose: STT must never stall a live conversation.
transcriber:
	@set -a; . ./local.env; set +a; \
	cd $(S2S_DIR) && uv run --python 3.13 python $(CURDIR)/tools/transcriber.py

.PHONY: shim
# Run the Claude Code OpenAI-compatible shim
shim:
	python3 -u shim/claude_openai_shim.py

.PHONY: clean-local
# Clean build artifacts (local)
clean-local:
	rm -rf node_modules coverage out
