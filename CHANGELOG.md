# Changelog

## Unreleased

- Interrupt a voice turn when its listener hangs up, instead of running it to
  completion while holding the per-key lock. speech-to-speech drops its request
  every time it supersedes its own turn, which happens on any mid-sentence pause,
  so the request carrying the finished sentence queued behind one or two dead
  turns. Measured: a follow-up went from 61.8s to 2.5s

- Detect the disconnect by polling the socket, not by waiting for a failed write.
  A turn spends most of its life running tools with nothing to write, so a
  disconnect at second 5 went unnoticed until the answer at second 60. Verified
  that a `control_request` interrupt ends the turn in ~0.1s and the same process
  answers the next prompt normally, so the session is not desynchronised

- Speak the holding line as two sentences. speech-to-speech releases a sentence
  to TTS only once the NEXT one has started, so a lone holding line waited for
  the answer and was spoken immediately before it — emitted at 3s, heard at
  13.4s. The second sentence pushes the first out and lands just before the
  answer. Confirmed on a live call: spoken at 3.0s

- Set `--stream_batch_sentences 1`. Upstream buffers three sentences before
  synthesising anything, which silently defeated every streaming improvement:
  the first sentence could not be heard until the third existed

- Speak a holding line when a voice turn stays silent past 3s, so early speech no
  longer depends on the model choosing to produce it. Tuned to 3s because a warm
  no-tool turn reaches its first word at ~2.4s and a shorter threshold interjects
  in front of an answer that was already arriving; tool turns produce nothing for
  6s or more. When the model does say its own holding sentence, the duplicate is
  recognised and dropped. Override with `SHIM_HOLD_AFTER`, 0 disables

- Route all streamed model text through one emit path. The duplicate check lived
  only on the sentence-split branch, so a holding sentence that arrived without
  trailing punctuation went out via the end-of-block flush and was spoken twice

- Stream assistant text as it arrives instead of waiting for `result`, and run
  Claude Code on a PTY so it line-buffers. Off a pipe it block-buffers and a
  whole turn lands at once; on a PTY chunks arrive ~0.2s apart
- Correction to the caveat above: the model was not refusing to speak before its
  tools. Streaming was never reaching the client at all — `ask_claude` was called
  without an `on_text` callback, so the shim buffered the whole answer and only
  chunked it at send time. With the callback wired, a tool turn produces "Let me
  check that." at ~3s. A fast-LLM tier is therefore no longer the fix

- Stream token deltas via `--include-partial-messages`, split on sentence
  boundaries before handing text to TTS. Without the flag only complete
  `assistant` events arrive and there is nothing to stream; without the split,
  TTS synthesises one clipped utterance per token. Abbreviations, decimals and
  version numbers are guarded against false splits. First speech on a warm
  session: 6.5s to 2.4s

- Classify voice by session key rather than by sniffing the system prompt.
  speech-to-speech selects its voice prompt only when `wants_audio` is set, and
  with TTS as a separate stage it never is — so every real voice turn arrived
  carrying the TEXT prompt, was answered with the text directive, and got no
  live streaming. Text surfaces always carry a `thread:`/`dm:`/`channel:` prefix;
  voice uses the bare default key

- Do not emit assistant text twice. The `assistant` event arrives BEFORE
  `content_block_stop`, so emitting from both spoke each block a second time

- Keep a trailing space on each streamed sentence — deltas are concatenated
  verbatim by the client, so without it a reply reads as "here.That question"

- Raise the speech-to-speech silence floor to 700ms (upstream 64ms, shorter than
  the pause between two words). s2s can reopen a soft-ended turn, but refuses
  once the turn is committed — and streaming commits almost immediately, so
  every pause became a new turn with its own Claude invocation

- Pin STT to English. Auto-detect across 25 languages does not reject unclear
  audio, it transcribes it into fluent nonsense that Claude then answers in good
  faith. Override with `S2S_STT_LANGUAGE`

- Stop leaking the MiniMax API key into `ps`. It was passed as
  `--responses_api_api_key`, so it sat in world-readable argv; it now travels as
  `OPENAI_API_KEY`, which the SDK reads when the flag is absent

- Add `SHIM_CLAUDE_MODEL` to select the model Claude Code runs. Measured no
  latency benefit (sonnet 6.61s vs opus 6.48s warm), kept as a knob

- Log the speech-to-speech error as an object; a bare string was spread into
  `{"0":"c","1":"o",…}` and the message was unreadable

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
