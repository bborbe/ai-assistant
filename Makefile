include Makefile.variables
include Makefile.precommit
include Makefile.docker
include example.env
# Optional, gitignored: local overrides. Included last so it wins — point at a
# different endpoint, use a different allowlist, or set DISCORD_TOKEN directly
# without touching committed config.
-include local.env

SERVICE = bborbe/discord-assistant

.PHONY: all
all: precommit

.PHONY: install
# Install dependencies from the lockfile
install:
	@npm ci

.PHONY: run
# Run the bot. The Discord token is resolved from TeamVault at run time, so it
# never lands on disk. DISCORD_TOKEN_KEY and ALLOWED_USER_IDS live in example.env.
run:
	@command -v teamvault-cli >/dev/null 2>&1 || { echo "teamvault-cli not on PATH" >&2; exit 1; }
	@DISCORD_TOKEN="$(shell teamvault-cli password $(DISCORD_TOKEN_KEY))"; \
	[ -n "$$DISCORD_TOKEN" ] || { echo "empty token from TeamVault key $(DISCORD_TOKEN_KEY)" >&2; exit 1; }; \
	export DISCORD_TOKEN; node src/index.js

.PHONY: shim
# Run the Claude Code OpenAI-compatible shim
shim:
	python3 -u shim/claude_openai_shim.py

.PHONY: clean-local
# Clean build artifacts (local)
clean-local:
	rm -rf node_modules coverage out
