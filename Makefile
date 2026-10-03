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
#
# WHICH file is per-IDENTITY, not per-repo: several identities can share one
# checkout, and `local.env` is a single filename. DISCORD_ASSISTANT_ENV names it;
# unset keeps the historical ./local.env. It has to come from the environment or
# the command line — it cannot live in the file it is there to locate.
DISCORD_ASSISTANT_ENV ?= local.env
-include $(DISCORD_ASSISTANT_ENV)

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
	@set -a; . "$(DISCORD_ASSISTANT_ENV)"; set +a; \
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
	@test -f "$(DISCORD_ASSISTANT_ENV)" || { echo "$(DISCORD_ASSISTANT_ENV) missing — run: cp local.env.example $(DISCORD_ASSISTANT_ENV)" >&2; exit 1; }

.PHONY: transcriber
# Watch for voice segments and append speaker-labelled transcripts.
# Dependencies are declared inline in the script (PEP 723), so uv resolves them
# — no speech-to-speech checkout required. Separate from the bot on purpose:
# STT must never stall a live conversation.
transcriber:
	@set -a; . "$(DISCORD_ASSISTANT_ENV)"; set +a; \
	uv run tools/transcriber.py

.PHONY: shim
# Run the Claude Code OpenAI-compatible shim
shim:
	@set -a; [ -f "$(DISCORD_ASSISTANT_ENV)" ] && . "$(DISCORD_ASSISTANT_ENV)"; set +a; \
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

# --- launchd (macOS local deployment) — see docs/deploy-local.md -------------

LAUNCHD_COMPONENTS = shim s2s transcriber bot gateway
LAUNCHD_DIR        = $(HOME)/Library/LaunchAgents
# Everything instance-specific derives from LAUNCHD_LABEL, so a second identity
# installs BESIDE the first rather than on top of it:
#
#   make launchd-install LAUNCHD_LABEL=com.github.bborbe.team-assistant
#
# The label was already overridable; the log directory and the launcher path were
# not. The launcher is the dangerous one — it is re-copied on every install, so a
# second checkout silently replaced the binary the first instance was running.
# Harmless while both sit on the same commit, a silent downgrade of a live
# service the moment they do not, and nothing logs it.
#
# LAUNCHD_INSTANCE is the label's last dotted segment, so every default below
# derives from the label alone. The default label itself moved from
# discord-assistant to ai-assistant (the repo rename), so a single-instance install
# now writes ~/Library/Logs/ai-assistant/ and ~/.local/bin/ai-assistant-launchd —
# see docs/deploy-local.md § Upgrading from the old label.
LAUNCHD_LABEL      = com.github.bborbe.ai-assistant
LAUNCHD_INSTANCE   = $(lastword $(subst ., ,$(LAUNCHD_LABEL)))
LAUNCHD_LOGDIR     = $(HOME)/Library/Logs/$(LAUNCHD_INSTANCE)
# A plist inherits no PATH. Explicit, absolute, and covering every binary the
# launcher reaches: uv + claude (~/.local/bin), teamvault-cli + node (homebrew),
# python3 (pyenv shims).
LAUNCHD_PATH       = $(HOME)/.local/bin:/opt/homebrew/bin:$(HOME)/.pyenv/shims:/usr/local/bin:/usr/bin:/bin
# The launcher must live OUTSIDE ~/Documents: launchd cannot execute anything
# under a TCC-protected folder and the job dies with exit 126 before running a
# line. ~/.local/bin is unprotected and already hosts uv and
# semantic-search-http for the same reason. The repo copy stays the source of
# truth; this is a deploy artifact and launchd-install always re-copies it, so
# it cannot drift.
LAUNCHD_LAUNCHER   = $(HOME)/.local/bin/$(LAUNCHD_INSTANCE)-launchd
# What the plist hands the launcher as DISCORD_ASSISTANT_ENV. A `~` is expanded
# HERE because a plist's EnvironmentVariables is a literal dict and launchd never
# expands it; the launcher also expands a leading ~/ itself, for shell use. With
# the variable unset this resolves to `local.env` relative to DISCORD_ASSISTANT_REPO
# — byte-identical in effect to what a single-instance install produced before.
LAUNCHD_ENV        = $(subst ~,$(HOME),$(DISCORD_ASSISTANT_ENV))

.PHONY: launchd-install
# Deploy the launcher outside the repo, generate the five plists, load them
#
# The log directory and files are owner-only (0700/0600), not the umask default.
# s2s logs the full request URL of every accepted websocket, and since the s2s
# gateway authenticates with a ?token= query param, that puts the gateway token
# in s2s.log in cleartext. Measured 2026-09-20: 6 occurrences, in a file that was
# mode 0644 — readable by any local user. The mode is what keeps it contained
# until the token stops travelling in the URL at all; do not relax it.
launchd-install: require-config
	@umask 077; mkdir -p $(LAUNCHD_DIR) $(LAUNCHD_LOGDIR) $(dir $(LAUNCHD_LAUNCHER))
	@chmod 700 $(LAUNCHD_LOGDIR)
	@chmod 600 $(LAUNCHD_LOGDIR)/*.log 2>/dev/null || true
	@cp scripts/launchd-run.sh $(LAUNCHD_LAUNCHER)
	@chmod +x $(LAUNCHD_LAUNCHER)
	@echo "  launcher -> $(LAUNCHD_LAUNCHER)"
	@for c in $(LAUNCHD_COMPONENTS); do \
	  sed -e 's|__COMPONENT__|'"$$c"'|g' \
	      -e 's|__LABEL__|$(LAUNCHD_LABEL)|g' \
	      -e 's|__LAUNCHER__|$(LAUNCHD_LAUNCHER)|g' \
	      -e 's|__REPO__|$(CURDIR)|g' \
	      -e 's|__ENV__|$(LAUNCHD_ENV)|g' \
	      -e 's|__HOME__|$(HOME)|g' \
	      -e 's|__LOGDIR__|$(LAUNCHD_LOGDIR)|g' \
	      -e 's|__PATH__|$(LAUNCHD_PATH)|g' \
	      deploy/launchd/discord-assistant.plist.template \
	      > $(LAUNCHD_DIR)/$(LAUNCHD_LABEL)-$$c.plist; \
	  launchctl bootout gui/$$(id -u)/$(LAUNCHD_LABEL)-$$c 2>/dev/null || true; \
	  n=0; \
	  while launchctl list | awk -v l="$(LAUNCHD_LABEL)-$$c" '$$3==l{f=1} END{exit !f}' && [ $$n -lt 50 ]; do \
	    sleep 0.2; n=$$((n+1)); \
	  done; \
	  launchctl bootstrap gui/$$(id -u) $(LAUNCHD_DIR)/$(LAUNCHD_LABEL)-$$c.plist \
	    || { echo "  FAILED to load $(LAUNCHD_LABEL)-$$c" >&2; exit 1; }; \
	  echo "  loaded $(LAUNCHD_LABEL)-$$c"; \
	done
	@echo "run 'make launchd-status' to check, and see docs/deploy-local.md"

.PHONY: launchd-uninstall
# Unload the five agents and remove their plists
launchd-uninstall:
	@for c in $(LAUNCHD_COMPONENTS); do \
	  launchctl bootout gui/$$(id -u)/$(LAUNCHD_LABEL)-$$c 2>/dev/null || true; \
	  rm -f $(LAUNCHD_DIR)/$(LAUNCHD_LABEL)-$$c.plist; \
	  echo "  removed $(LAUNCHD_LABEL)-$$c"; \
	done
	@rm -f $(LAUNCHD_LAUNCHER)
	@echo "  removed $(LAUNCHD_LAUNCHER)"

.PHONY: launchd-status
# PID and last exit code per agent. No PID + exit 0 means the launcher hit a
# config error and deliberately stopped — that is the KeepAlive rule working.
launchd-status:
	@printf '%-8s %-8s %s\n' PID EXIT LABEL; \
	for c in $(LAUNCHD_COMPONENTS); do \
	  launchctl list | awk -v l="$(LAUNCHD_LABEL)-$$c" '$$3==l {printf "%-8s %-8s %s\n", $$1, $$2, $$3; f=1} END {if(!f) printf "%-8s %-8s %s\n", "-", "-", l" (not loaded)"}'; \
	done
