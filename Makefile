include Makefile.variables
include Makefile.precommit
include Makefile.docker
include example.env

SERVICE = bborbe/discord-assistant

.PHONY: all
all: precommit

.PHONY: install
# Install dependencies from the lockfile
install:
	@npm ci

.PHONY: run
# Run the bot (needs DISCORD_TOKEN and ALLOWED_USER_IDS)
run:
	node src/index.js

.PHONY: shim
# Run the Claude Code OpenAI-compatible shim
shim:
	python3 -u shim/claude_openai_shim.py

.PHONY: clean-local
# Clean build artifacts (local)
clean-local:
	rm -rf node_modules coverage out
