# Changelog

## Unreleased

- Evict voice connections left by a previous process. Killing the bot mid-call
  left it visible in the channel while `/leave` said "not in a voice channel":
  a new process has no session for it and `getVoiceConnection` only sees its
  own. Now cleared on startup and as a `/leave` fallback, via the gateway voice
  state
- `make run` uses `$$( )` rather than `$(shell )` — Make expands the latter
  itself, baking the token into the `sh -c` argv where `ps` can read it

- Keyed sessions: one Claude Code session per thread/DM/channel via
  `X-Session-Key`, with per-key locks so conversations run concurrently instead
  of queueing behind a single global lock
- `/new` clears the current conversation, `/sessions` lists what is held
- Shim injects a memory directive: anything worth keeping is written to the
  vault before the turn ends, which is what makes clearing a session safe

- Text conversations run in a thread: an `@mention` opens one, follow-ups need
  no mention, and history is scoped to the thread. Falls back to the channel if
  thread permissions are missing rather than dropping the answer

- `make dev` starts the whole local stack (shim + speech-to-speech + bot) and
  stops it cleanly; `SKIP_VOICE=1` for the text surface only
- Repo is now self-contained: the speech-to-speech launcher, the realtime probe
  and the MiniMax patch moved in from outside, where a re-clone would have
  silently destroyed them

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
  fail-fast guards. Config lives in gitignored `local.env` (from
  `local.env.example`); there is no committed env file, because Make variables
  override the environment and would clobber the shell
- Health server moved to 8081 — 8080 belongs to the shim
- `Makefile.k8s` uses `teamvault-cli config parse`; `teamvault-config-parser`
  was retired in v5.7 and silently renders nothing

## v0.0.1

- Initial commit
- Voice bridge: Discord voice channel <-> speech-to-speech realtime <-> OpenAI-compatible endpoint, multi-turn, verified end to end against MiniMax-M3
- `tools/capture.js` + `tools/to16k.py` — voice-receive diagnostics from the spikes
