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

One Discord bot identity permits one gateway connection, so text and voice must live in one process. Splitting them across runtimes would need two bot *applications* — two names, two invites — defeating the point of a single assistant. They also share the sender allowlist, which should be one list rather than two that drift.

## Status

Working: voice round trip (`bridge.js`) — Discord voice in, spoken reply out, multi-turn, verified in a real voice channel.

Not built yet: `/join` + `/leave` slash commands (it currently auto-joins a channel named on the command line), the text surface, sender allowlist.

## Requirements

- Node 22+
- A running [speech-to-speech](https://github.com/huggingface/speech-to-speech) in realtime mode for the voice surface
- An OpenAI-compatible endpoint
- A Discord bot token — kept in TeamVault, never on disk

## Run

```bash
# 1. speech-to-speech, realtime mode, pointed at your endpoint
S2S_MODE=realtime ~/Documents/workspaces/scripts/s2s-minimax

# 2. the bridge
DISCORD_TOKEN=$(teamvault-cli password <secret-id>) \
  node bridge.js "<guild name>" "<voice channel name>"
```

Then join that voice channel and talk.

| Env | Default | Meaning |
|---|---|---|
| `DISCORD_TOKEN` | — | Bot token (required) |
| `S2S_URL` | `ws://127.0.0.1:8765/v1/realtime` | speech-to-speech realtime socket |

## Three things the bridge has to get right

Each of these was found the hard way; none is obvious from the docs.

1. **Inject silence during gaps.** Discord emits audio *only while someone speaks*, but speech-to-speech's VAD closes a turn *on silence*. Without a fixed-rate ticker sending silence between utterances the turn never ends and no reply is ever generated. This is the single thing that makes the bridge work.

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

## tools/

Diagnostics from the spikes that proved each leg, kept because they isolate faults the full bridge can't:

- `capture.js` — join a channel, capture one speaker, write raw 48 kHz stereo WAV. Proves voice receive with no endpoint involved.
- `to16k.py` — mono mix + `soxr` HQ resample to 16 kHz. Run in the speech-to-speech venv.
