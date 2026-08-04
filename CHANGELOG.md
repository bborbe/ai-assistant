# Changelog

## Unreleased

- Keep speaking during a long turn. One filler was sized for a 6-15s turn; a
  vault question measured 30.4s live, and the listener heard "I'll look that up"
  followed by half a minute of silence and reasonably concluded it had died. A
  progress line now goes out whenever nothing has been heard for 12s
  (`SHIM_PROGRESS_EVERY`, 0 disables), never repeating the previous line — random
  choice over four options repeats about a quarter of the time, and hearing the
  same sentence twice running sounds stuck rather than busy

- Measure silence from the last thing SPOKEN, not from whether anything has been
  spoken at all. A turn commonly says "let me take a look" and then works
  silently for another twenty seconds; an anything-yet test stops watching at the
  first word and leaves exactly the dead air it was added to prevent

- Do not treat a suppressed duplicate as speech. When the model produced its own
  holding sentence and we discarded it as a duplicate of the filler, the flag
  meaning "text reached the listener" was set anyway — so a 34s turn spoke once
  and then went quiet, the watcher believing a reply was in flight while the only
  thing produced had just been thrown away

- Route by an explicit refusal contract rather than a tool call. The front model
  is told to reply `{"cannot_answer": true}` when answering would need the user's
  notes, tasks, files or systems. Measured across 20 factual trials including
  deliberately subtle phrasings — "so what's left for today", "did that finish",
  "anything I should know about" — zero fabrications. The same model given an
  `ask_claude` tool instead invented a task name, count and due date for "can you
  list all active tasks?": it treats a tool as an action needing permission, but
  a refusal token as simply the honest reply. Same model, same questions; only
  the channel changed. Tools are no longer requested

- Route three ways instead of two: recognised chat answers locally (~1s), plainly
  factual skips the round trip and takes a locally-decided filler (0.14s), and
  everything else goes to the front model under the refusal contract. The third
  band is the point — a whitelist cannot enumerate every way of being
  conversational ("yo what's up" is chat, "did that finish" is not), and that
  band is exactly where an allowlist was blunt and a blocklist was unsafe

- Recognise a refusal written in prose. The model gets the judgement right and
  the format wrong often enough to matter: "I do not have any context about what
  finished" was spoken to the user as if it were an answer, because the filter
  only matched "don't have access". Any admission of missing information now
  becomes a consult

- Consult the front tier only for utterances positively recognised as
  conversation; send everything else to Claude without asking. Routing was the
  other way round — anything not matching a list of factual-looking patterns was
  offered to the front model — and that list had a typo: `\btask\b` cannot match
  "tasks", because `\b` requires a non-word character and "s" is not one. "Can
  you list all active tasks?" reached the front tier, which answered with an
  invented task name, an invented count and an invented due date, spoken as fact.
  No such task exists.

  Every other layer failed with it: the model did not call the tool, and a
  confident invention trips neither the hedge nor the leak filter — so a single
  regex was all that stood between a fabrication and the user. A blocklist must
  enumerate every way of asking about the user's world and is wrong the moment it
  misses one; an allowlist is wrong only by being slow, costing a couple of
  seconds when an unrecognised greeting wakes Claude. Verified: both
  fabrication-shaped prompts now route to Claude, greetings still do not

- Widen the factual patterns anyway, as defence in depth: plurals throughout,
  plus "list", "show", "summarise", "remind me", and session/project/ticket
  vocabulary

- Play audio as it arrives instead of when the response completes. The bot
  accumulated every `response.output_audio.delta` and started playback only on
  `response.output_audio.done` — measured on a live turn: 211 deltas held, then
  33.6s of audio released at once. So the early "checking that now", emitted by
  the shim at 0.16s and synthesised separately by speech-to-speech, still reached
  the listener immediately before the answer. Every latency fix upstream was
  being discarded at the last step. Playback now writes into an open PassThrough,
  which pauses on a gap in synthesis rather than ending, and barge-in destroys
  the stream as well as stopping the player

- Say what is happening when we know it. The filler was deliberately vague
  ("hang on") back when a blind timer fired it and "checking that" could be a
  lie in reply to "thank you". It now fires only once a lookup is established —
  the question was recognised as factual, or the model asked for the tool — so
  the informative wording is true, and it tells the user their request landed
  rather than merely that something is alive. Measured at 0.16s

- Filter the front model's words rather than trusting the prompt to govern them.
  Three rounds of prompt-tightening each surfaced a new phrasing: told to call
  `ask_claude` it said "want me to?" instead; told never to ask permission it
  complied on the call and asked permission in the filler; told never to describe
  its own machinery it announced "I have one tool available called ask_claude".
  A reply that hedges or names the machinery is now discarded, and a discarded
  reply becomes a consult — so the bad case costs a lookup rather than reaching
  the user. Verified with the heuristics switched OFF, the hardest configuration:
  7/7 routed correctly with nothing leaked

- Tell the front model that consulting is the normal path, not an escalation.
  The tool description read like a consequential action ("hand the question to
  the full assistant"), which is most of why it asked permission to use it

- Inject an `ask_claude` tool into the front model's request and run the tool in
  the proxy. The proxy owns the loop, so Claude's answer is returned verbatim
  rather than handed back to the front model to reword — an ordinary agent loop
  would let it restate facts about the user's vault in its own words. s2s needs
  no changes because it never learns tools exist

- Skip the front round trip when the question is plainly factual. Asking the
  model whether a lookup is needed costs ~3s to be told what the wording already
  says; the filler lands at 0.14s by deciding locally

- Supply the pause-filler ourselves when the front model returns a tool call with
  no text. Models commonly emit either content or tool calls, so a filler that
  depends on getting both arrives only sometimes

- Add `SHIM_FRONT_HEURISTICS=0` to take the whitelist and factual backstop out of
  the path, leaving routing entirely to the front model. Measured on voice, that
  model defers _verbally_ ("to get the list I'd have to ask the full assistant —
  want me to?") instead of calling the tool, answers about the user's world from
  its own knowledge, and introduces itself as Claude. It fails toward talking
  rather than checking, which is the expensive direction — so the heuristics stay
  on by default and the model's tool call is a second chance to defer, not the
  only one

- Leave exactly one live speech-to-speech socket behind on reconnect. Replacing
  `this.ws` did not silence the socket it replaced — the old object kept its
  message listener and went on feeding the player, so every reply was heard once
  per stale socket and the count grew with each reconnect. One s2s restart was
  enough to start it. Superseded sockets are now unbound and closed, at most one
  reconnect timer is outstanding, and a close from a replaced socket no longer
  schedules a second chain

- Answer pure small talk from a fast hosted model instead of waking Claude Code.
  Measured: "hello" 1.2s and "thank you" 0.8s, against ~2.6s before and 6s+ for a
  lookup. Voice only — a text surface has no latency problem worth a second model

- Route by a closed whitelist of conversational phrases, not by asking the front
  model to decide. A tool-call round trip costs ~0.6s to be told what the
  transcript already says, and it puts a safety-critical judgement inside a model
  that would answer "what did I decide about the deploy" from its own head. The
  match is whole-utterance: "hello" routes to the front tier, "hello, what is my
  most important task" does not. Anything unrecognised, and any front-tier
  failure, falls through to Claude

- Disable thinking on the front model and strip any that leaks. MiniMax emits
  reasoning inside `content` rather than `reasoning_content`, so the first
  version read its own deliberation aloud

- Feed Claude's answers back into the front model's history, or "say that again"
  reaches a model that never heard what it is being asked to repeat

- Lower the filler threshold to 0.5s and the silence floor to 400ms. Both were
  set to guard against problems since fixed — the filler now waits for a
  `tool_use` block rather than firing on any slow turn, and an abandoned turn is
  interrupted in ~0.1s instead of blocking the next one

- Hold the spoken filler until there is evidence of work. A plain timer fires on
  any slow turn, so "thank you" was answered with "Checking now. Won't be long.
  You're welcome." — three sentences of scaffolding around two words. The filler
  now waits for a `tool_use` block, with an 8s fallback for a turn that is slow
  without tools. Verified: a thank-you answers directly at 2.6s with no filler,
  while a lookup still gets its early sentence

- Say nothing about what is happening in the filler itself. "Checking now" and
  "let me look that up" are claims, and the timer that speaks them cannot see
  whether anything is being looked up; the lines are now purely neutral

- Send SSE keepalives so a long turn is not aborted mid-flight. speech-to-speech
  gives up after 20s without bytes and speaks "Wow I'm a bit slow today, could
  you repeat that?" — and because that is a gap between chunks rather than a
  total, any tool phase over 20s killed a turn that was progressing normally.
  The timeout is hardcoded upstream with no CLI flag, so the fix is on our side:
  an empty delta every 8s, which resets the client's read timer and produces no
  speech. A 30s turn that previously died now completes. Covers the wait for the
  per-key lock too, where a queued turn could time out before it even began

- Make the spoken length limit hard and put it last, where the directive is
  strongest. Asking for "one or two sentences" in passing produced six on a live
  call; stating it as a limit that holds however much was found, with an explicit
  alternative — one fact plus an offer of the rest — holds at two, including on
  "summarise everything", the prompt that produced six before. Note that a live
  process keeps the directive it launched with, so changes need a respawn

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
