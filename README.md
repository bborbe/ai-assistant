# discord-assistant

One Discord bot that reaches an **OpenAI-compatible endpoint** from two surfaces — text and voice — so the backend behind it can be swapped without touching the bot.

```
Discord (cloud)
   |  outbound gateway — no ingress, no tunnel
discord-assistant  (single Node service, single bot identity)
   |-- text    DM / thread    ------------------> OpenAI-compatible endpoint
   \-- voice   /join, /leave  -> speech-to-speech -> same endpoint
```

Today that endpoint is MiniMax. Later it is a wrapper around a Claude Code session, and neither surface changes — only `OPENAI_BASE_URL`.

## Why one service

One Discord bot identity permits one gateway connection, so text and voice must live in one process. Splitting them across runtimes would need two bot _applications_ — two names, two invites — defeating the point of a single assistant. They also share the sender allowlist, which should be one list rather than two that drift.

## Status

Both surfaces work, verified end to end against a real Claude Code session:

- **Text** — DM, or `@mention` in a guild channel. A mention opens a **thread** and the conversation continues there, so follow-ups need no `@` and history stays scoped to the thread rather than to whatever else the channel was discussing. DMs stay flat — Discord has no threads in DMs.
- **Voice** — `/join` from a voice channel, talk, hear the reply. Barge-in supported.
- **Sender allowlist** on both surfaces, failing closed.
- **Cross-surface continuity** — a stateful endpoint means a voice turn and a text turn share one conversation.

Not built yet: proactive outbound (the bot speaking unprompted, e.g. reporting a finished job), a session reset policy, and Telegram as a second transport.

## Requirements

- Node 22+
- A running [speech-to-speech](https://github.com/huggingface/speech-to-speech) in realtime mode for the voice surface
- An OpenAI-compatible endpoint
- A Discord bot token — kept in TeamVault, never on disk

## Run

```bash
make install
cp local.env.example local.env      # gitignored; holds the TeamVault key, not the token

# text only — no speech-to-speech needed
DISCORD_TOKEN=$(teamvault-cli password <secret-id>) \
ALLOWED_USER_IDS=<your-discord-user-id> \
  make run

# add voice: speech-to-speech in realtime mode, LLM slot pointed at the same endpoint
S2S_MODE=realtime ~/Documents/workspaces/scripts/s2s-minimax
```

DM the bot to use text. `/join` from a voice channel to use voice, `/leave` to stop.

To put Claude Code behind it instead of a hosted model, run `make shim` and point `OPENAI_BASE_URL` at it.

| Env                | Default                           | Meaning                                                                               |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`    | —                                 | Bot token (required)                                                                  |
| `ALLOWED_USER_IDS` | —                                 | Comma-separated Discord user IDs. **Empty means nobody** — it fails closed on purpose |
| `OPENAI_BASE_URL`  | `http://127.0.0.1:8080/v1`        | The swappable endpoint                                                                |
| `OPENAI_MODEL`     | `claude-code`                     | Model name passed through                                                             |
| `S2S_URL`          | `ws://127.0.0.1:8765/v1/realtime` | speech-to-speech realtime socket                                                      |
| `HEALTH_PORT`      | `8080`                            | `/healthz`, `/readiness`, `/version`                                                  |
| `HISTORY_LIMIT`    | `20`                              | Prior messages resent per text turn                                                   |

See `local.env.example` for the full set.

There is **no committed env file** on purpose. Make variables override the environment, so a committed `export DISCORD_TOKEN=` — even an empty one — silently clobbers whatever you exported in your shell. Config lives in gitignored `local.env`; `make run` fails with a pointer to the template if it is missing.

## The shim — Claude Code behind an OpenAI endpoint

`shim/claude_openai_shim.py` exposes **one persistent Claude Code session** as `/v1/chat/completions`, so both surfaces (and anything else speaking OpenAI) continue the _same_ conversation.

It is OpenAI-**shaped but stateful**, a deliberate deviation:

| Role            | Handling     | Why                                                        |
| --------------- | ------------ | ---------------------------------------------------------- |
| `system`        | pass through | per-request output rules (voice clients send speech rules) |
| latest `user`   | the turn     | the actual new input                                       |
| everything else | **discard**  | the session already has the history                        |

Clients resend full history per the spec; appending it to a session that already has it would double context every turn and fork into a second, divergent history. Dropping it is also what makes cross-surface continuity work: the session is the conversation, not the transport.

For voice it additionally **enforces** speakable output — a session with a personal `CLAUDE.md` follows its own formatting rules (status panels, markdown, bullet lists), which are unusable as speech and which the voice prompt alone does not override.

### Threads and the stateful endpoint

Threads tidy the channel and scope history; they do **not** create separate conversations. With the stateful shim every thread maps onto the same Claude Code session, so context carries across them — which is the intended behaviour (it is what makes voice and text share a conversation), but it will surprise you if you expect one thread to be a sandbox. Against a _stateless_ endpoint, threads would be genuinely independent.

Requires **Create Public Threads** and **Send Messages in Threads**. Without them the bot logs a warning and answers in the channel instead of losing the reply.

## Service endpoints

`/healthz` (liveness), `/readiness` (gateway connected — 503 while draining), `/version`.

Liveness deliberately ignores Discord: an outage there should drain traffic, not restart every pod into a reconnect storm.

## Three things the bridge has to get right

Each of these was found the hard way; none is obvious from the docs.

1. **Inject silence during gaps.** Discord emits audio _only while someone speaks_, but speech-to-speech's VAD closes a turn _on silence_. Without a fixed-rate ticker sending silence between utterances the turn never ends and no reply is ever generated. This is the single thing that makes the bridge work.

2. **Never send `input_audio_buffer.commit` or `response.create`.** They race the VAD-driven response and show up server-side as `speech during pending response: cancelled`.

3. **Audio arrives as `response.output_audio.delta`**, not `response.audio.delta`. The latter is what OpenAI's hosted Realtime uses and what most write-ups quote — a bot written to it receives nothing and fails silently.

## Audio conversion

Discord is 48 kHz stereo interleaved; speech-to-speech is 16 kHz mono (`PIPELINE_SAMPLE_RATE`). Note this is **not** the 24 kHz that OpenAI's hosted Realtime uses.

Naive `pcm[::3]` is wrong twice over: it walks alternating channels on an interleaved stream, and decimating without a low-pass filter aliases. The bridge mixes to mono first, then averages groups of 3 (box low-pass) going down, and linearly interpolates going up. Crude but correct in shape, and adequate for speech — no ffmpeg required.

## Gotchas

- **`selfDeaf: false` is mandatory** on `joinVoiceChannel`. The default deafens the bot and it receives nothing, silently.
- **A connection stuck in `signalling` means permissions** — even when `permissionsFor(me)` reports `Connect`/`Speak`/`ViewChannel`/`UseVAD` all `true`. Trust the state machine over the permission API, and always log `conn.on('stateChange')`; otherwise the failure surfaces as an unhandled `AbortError` with no cause.
- **Run `generateDependencyReport()` first** on any voice problem — it rules out the whole Opus/encryption class in one command.
- **Discord's portal blocks auto-generated install links for private apps.** Set Installation → Install Link → None and hand-build the OAuth2 URL; keep Public Bot off.

## Deployment

`make buca` → build, upload, clean, apply. **Never scale beyond one replica** — a Discord bot identity permits exactly one gateway connection, which is why `k8s/` pins `replicas: 1` with `strategy: Recreate`.

## Running it

```bash
make dev                  # shim + speech-to-speech + bot, Ctrl-C stops all three
SKIP_VOICE=1 make dev     # text surface only — starts in seconds
```

`make dev` reuses anything already listening rather than fighting it, and waits for each port instead of sleeping a fixed time (model load is variable). Individually: `make shim`, `make run`.

| Process          | Port | Needed for                        |
| ---------------- | ---- | --------------------------------- |
| shim             | 8080 | both surfaces                     |
| speech-to-speech | 8765 | voice only (~60 s to load models) |
| bot              | 8081 | both                              |

## patches/

`speech-to-speech` needs one change for MiniMax (see `patches/README.md`). It lives here because that repo is a third-party clone — a `git pull` silently discards it, and the voice surface then fails in a way that looks unrelated.

## tools/

Diagnostics from the spikes that proved each leg, kept because they isolate faults the full bridge can't:

- `capture.js` — join a channel, capture one speaker, write raw 48 kHz stereo WAV. Proves voice receive with no endpoint involved.
- `to16k.py` — mono mix + `soxr` HQ resample to 16 kHz. Run in the speech-to-speech venv.
- `realtime_probe.py` — send a WAV to the speech-to-speech realtime socket and report every event type it emits. Proves the endpoint with no Discord involved; the reference for the protocol handling in `src/voice.js`.
