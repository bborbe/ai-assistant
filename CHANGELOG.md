# Changelog

## Unreleased

- Stream assistant text as it arrives instead of waiting for `result`, and run
  Claude Code on a PTY so it line-buffers. Off a pipe it block-buffers and a
  whole turn lands at once; on a PTY chunks arrive ~0.2s apart
- Caveat, measured: the model usually calls its tools _before_ saying anything,
  so there is little early text to stream. The directive asks it to speak first
  and it does not comply — a fast-LLM tier that answers regardless is the fix,
  and this streaming path is what it will use

- Voice replies stop reciting identifiers. The directive now forbids ids,
  hashes, byte counts, paths and timestamps explicitly and asks for flowing
  conversational sentences rather than clipped fragments; a regex backstop
  rewrites anything that slips through, because asking a model is not the same
  as guaranteeing

- Client disconnects are handled as normal traffic, not errors.
  speech-to-speech cancels its in-flight request on barge-in and on a
  superseded turn, so the socket is routinely gone before the answer is
  written; that produced an unhandled `BrokenPipeError` traceback per
  cancelled turn

- Leave voice properly on shutdown. `client.destroy()` ran immediately after
  leaving, cutting the gateway before the voice-state update reached Discord —
  so the bot lingered in the channel as a ghost a later process had to evict.
  Now it leaves, evicts, and waits briefly before tearing down
- Ghost eviction falls back to the guild's voice-state cache. `members.me.voice`
  may not be populated at `clientReady`, so a ghost invisible to one cache is
  usually visible to the other

- Transcripts are UTC throughout. The folder date came from `toISOString()`
  (UTC) while the line timestamps were local, so a session just after local
  midnight landed in a folder dated the previous day. UTC is also stable across
  DST and travel; times are suffixed `Z` so it is unambiguous

- The transcriber no longer borrows the speech-to-speech venv: dependencies are
  declared inline (PEP 723) so `uv run` resolves them. The repo no longer needs
  a speech-to-speech checkout to transcribe, and `make dev` starts it alongside
  the rest

- Persistent Claude Code process per session, fed as `stream-json` over stdin
  instead of spawning `claude -p` per turn. Cold 7.6s, warm 5.3s, then 4.4s —
  and context is retained on the live process. Measurement first ruled out the
  obvious suspect: trimming MCP from 15 servers to 1 saved only 1.6s of 11.8s,
  so the cost is CLI startup and only reuse fixes it
- Drop superseded turns. speech-to-speech emits progressive transcription
  finals, so one sentence arrived as four requests that each queued on the
  session lock — four invocations and a multi-second stall. A request that
  finds a newer one waiting now drops itself before doing any work
- Filler short-circuit: bare "okay"/"yeah" no longer wake Claude Code. Bare
  "yes"/"no" deliberately still do — they are answers, not backchannel

- The bot's own replies are recorded too. Its speech never returns through
  Discord, so the transcript was one-sided — questions with no answers. Written
  as timestamped `.txt` sidecars rather than appended directly, so the
  transcriber merges them in order; appending would race, since STT lags and the
  reply would land above the question
- Utterances close on sustained silence (1.5s), not on Discord's `speaking.end`
  — that fires on every brief pause, chopping a sentence into fragments and
  filling the transcript with "Yeah." lines
- Recipes source `local.env` in the shell. Make's `include` reads `$HOME` as an
  empty _Make_ variable and keeps quotes literally, so `TRANSCRIPT_DIR` became
  `"OME/Documents/...` and transcripts landed in a bogus directory

- Always-on transcription: every speaker in the channel is written to a
  speaker-labelled, timestamped `transcript.md` inside the vault, appended live
  so it is readable mid-call. Separate from the command allowlist — the
  allowlist controls who can _drive_ the bot, this controls who is _written
  down_. Announced in-channel on join
- `tools/transcriber.py` watches for segments and transcribes with the same
  Parakeet loader speech-to-speech uses. A separate process on purpose: STT
  must never stall a live conversation, and if it is not running the audio
  simply waits on disk

- Per-speaker audio buffers. Every subscribed speaker was appended to one
  buffer in arrival order, so two people would have produced interleaved
  chunks — worse than a mix, because the samples never align. Now buffered per
  user and summed sample-aligned at send time. Latent until now (the allowlist
  subscribes one person), and it keeps speaker identity available for
  per-speaker STT later

- Strip the CLAUDE.md closer panel from text replies too, not just voice. A chat
  window is not a terminal. Matching is anchored on the state icon rather than
  the keyword: the text after it is free-form, so "⚪ Status check answered" is
  a panel while "⚪ DONE" is the only form a keyword match would catch

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
