# Changelog

## Unreleased

- Text surface: DM or `@mention`, thread history resent per turn
- `/join` and `/leave` slash commands — joins the caller's current voice channel
- Sender-level allowlist on both surfaces, failing closed when unset
- `shim/claude_openai_shim.py`: one persistent Claude Code session behind an
  OpenAI-compatible endpoint, with voice-output enforcement
- Adopted the node-skeleton conventions: split Makefiles, `make precommit`,
  `make buca`, Dockerfile, k8s manifests, structured JSON logging
- `/healthz`, `/readiness`, `/version` and graceful shutdown that fails
  readiness before draining
- Security gates: `npm audit` (high/critical) and `trivy fs` (vulns + secrets)
- `make run` resolves the Discord token from TeamVault at run time, with
  fail-fast guards; `local.env` (gitignored) overrides committed defaults
- Health server moved to 8081 — 8080 belongs to the shim
- `Makefile.k8s` uses `teamvault-cli config parse`; `teamvault-config-parser`
  was retired in v5.7 and silently renders nothing

## v0.0.1

- Initial commit
- Voice bridge: Discord voice channel <-> speech-to-speech realtime <-> OpenAI-compatible endpoint, multi-turn, verified end to end against MiniMax-M3
- `tools/capture.js` + `tools/to16k.py` — voice-receive diagnostics from the spikes
