'use strict';

const {
  joinVoiceChannel,
  EndBehaviorType,
  entersState,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
  getVoiceConnection,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { PassThrough } = require('stream');
const WebSocket = require('ws');
const config = require('./config');
const log = require('./log');
const { TranscriptSession } = require('./transcript');
const { chunk } = require('./discord-chunk');
// Imported as a namespace, not destructured: the typed-turn hint is stubbed in
// tests, and a destructured binding would capture the original function.
const llm = require('./llm');

const DISCORD_RATE = 48000,
  DISCORD_CH = 2;
const S2S_RATE = 16000;
const TICK_MS = 20;
// Resolved in config.js with every other env read, so the service's real
// configuration surface can be enumerated in one place.
const UTTERANCE_GAP_MS = config.utteranceGapMs;
const IN_BYTES = (DISCORD_RATE * DISCORD_CH * 2 * TICK_MS) / 1000; // 20ms @48k stereo
const OUT_SAMPLES = (S2S_RATE * TICK_MS) / 1000; // 20ms @16k mono
// One 20ms frame of what Discord plays back: 48k, stereo, 16-bit.
const OUT_FRAME = (DISCORD_RATE * DISCORD_CH * 2 * TICK_MS) / 1000;

/**
 * A sentence ending welded to the next sentence's capital: `long.No`.
 *
 * Seen once in a real transcript — a holding line and an answer with nothing
 * between them. Every layer we can inspect preserves the space (the endpoint
 * ends each SSE chunk with one, speech-to-speech joins sentence batches with
 * one), so the next occurrence has to be caught in flight rather than
 * reconstructed afterwards.
 *
 * Requiring an uppercase letter keeps abbreviations, decimals and URLs out —
 * `e.g`, `3.5` and `example.com` do not match.
 */
const RUN_ON = /[.!?][A-Z]/;
const SILENCE = Buffer.alloc(OUT_FRAME);

// Discord's typing indicator lapses after ~10s, so it has to be re-sent while
// an answer is still being produced. The cap bounds a response that never
// reports finishing — dots that never stop are worse than none.
const TYPING_TICK_MS = 8000;
const TYPING_MAX_MS = 5 * 60 * 1000;

// 48k stereo -> 16k mono. Mix channels first, then average groups of 3 (box
// low-pass). NOT naive striding, which walks alternating channels on an
// interleaved stream and aliases everything above 8 kHz back into the band.
function down(buf) {
  const out = Buffer.alloc(OUT_SAMPLES * 2);
  for (let i = 0; i < OUT_SAMPLES; i++) {
    let acc = 0;
    for (let k = 0; k < 3; k++) {
      const off = (i * 3 + k) * 4;
      if (off + 3 >= buf.length) break;
      acc += (buf.readInt16LE(off) + buf.readInt16LE(off + 2)) / 2;
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc / 3))), i * 2);
  }
  return out;
}

// 16k mono -> 48k stereo, linear interpolation.
function up(buf) {
  const n = buf.length / 2;
  const out = Buffer.alloc(n * 3 * 4);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const cur = buf.readInt16LE(i * 2);
    const nxt = i + 1 < n ? buf.readInt16LE((i + 1) * 2) : cur;
    for (let k = 0; k < 3; k++) {
      const v = Math.round(cur + (nxt - cur) * (k / 3));
      out.writeInt16LE(v, o);
      out.writeInt16LE(v, o + 2);
      o += 4;
    }
  }
  return out;
}

/** One live voice session: Discord audio <-> speech-to-speech. */
class Session {
  constructor(connection, guildId, guildName, channelName, channelId, channel) {
    this.conn = connection;
    this.guildId = guildId;
    // A Discord voice channel has an integrated text chat sharing its id, so
    // this is what links a posted message to the running transcript.
    this.channelId = channelId;
    // The channel object itself, kept for postToChannel — the shim's
    // chat-bridge posts arrive with no channel id (see postToChannel below),
    // so this is what lets the bot answer "which channel" on its own.
    this.channel = channel;
    // Per-speaker buffers. Discord gives a separate stream per user (per SSRC),
    // which is the expensive half of any diarization pipeline — appending them
    // all to one buffer would throw that away AND garble the audio, since the
    // chunks interleave rather than align in time.
    this.inbox = new Map(); // userId -> Buffer
    this.audio = null; // open PassThrough while a reply is playing
    this.outQueue = Buffer.alloc(0); // 48k stereo PCM waiting to be paced out
    this.outTick = null;
    this.ending = false;
    this.speaking = false;
    this.subscribed = new Set();
    this.closed = false;
    this.ws = null;
    this.retry = null; // at most one outstanding reconnect
    // Set while a response triggered by speak() (a typed turn, not a mic
    // turn) is in flight, so the transcript line it produces can be marked
    // distinctly from an ordinary spoken reply. Cleared once that reply's
    // transcript is written, or defensively on response.done.
    this.typedReplyPending = false;
    // Mirrors the server's own `st.in_response` (response.py) — set on
    // EVERY `response.created`, mic-triggered or not, cleared defensively on
    // BOTH `response.output_audio.done` and `response.done` (same two events
    // that reset typedReplyPending, for the same reason: a response that
    // ends abnormally must not wedge the next speak() as permanently busy).
    // speak() reads this before sending anything, because the server allows
    // only one response at a time regardless of who triggered it, and a
    // mic-driven reply to someone else on the call can otherwise be
    // mistaken, event-type-only, for the ack of our own request — see
    // speak()'s doc comment.
    this.inResponse = false;
    // True only while THIS session's own speak() call is waiting on its ack,
    // so a second typed turn arriving before the first is acked is refused
    // client-side rather than racing the same listener.
    this.awaitingSpeakAck = false;
    // Set by speak() while it is waiting; connectS2S() calls this to fail a
    // pending speak() fast (rather than making its caller wait out the full
    // ack timeout) when the socket it was waiting on is torn down.
    this.pendingSpeakFinish = null;
    // Live "…is typing" ticker in the call's text chat, while any answer is
    // being produced — see showTyping().
    this.typingTimer = null;
    // "An answer is on its way", for the typing indicator only.
    //
    // Deliberately NOT `inResponse`: that mirrors the server's client-visible
    // response state, and the server only announces `response.created` for a
    // response the CLIENT asked for (handlers/response.py:191). A mic turn
    // never emits one — by the time audio begins, assistant text has already
    // called `_ensure_response`, so `audio.py`'s `need_created` is false and
    // the event is skipped. So a spoken turn needs its own signal, and the
    // earliest honest one is the user's utterance being transcribed.
    this.answering = false;

    // Transcript path — EVERY speaker, independent of the command allowlist.
    // Buffers here are flushed on each speaker's silence boundary.
    this.transcript = config.transcribe ? new TranscriptSession(guildName, channelName) : null;
    this.utterance = new Map(); // userId -> Buffer (48k stereo, as captured)
    this.flushTimers = new Map(); // userId -> pending flush
    this.names = new Map(); // userId -> display name

    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.conn.subscribe(this.player);
    this.player.on('idle', () => {
      this.speaking = false;
    });

    this.conn.receiver.speaking.on('start', (userId) => {
      clearTimeout(this.flushTimers.get(userId)); // resumed — keep accumulating
      this.flushTimers.delete(userId);
      this.listen(userId);
    });
    // Silence boundary per speaker: this is what turns a continuous stream into
    // utterances, and it is why the transcript reads like a conversation rather
    // than one undifferentiated block.
    this.conn.receiver.speaking.on('end', (userId) => this.scheduleFlush(userId));
    this.connectS2S();

    // Discord emits audio ONLY while someone speaks, but s2s closes a turn on
    // SILENCE. Without this fixed-rate pump sending silence between utterances
    // the turn never ends and no reply is ever produced.
    this.pump = setInterval(() => this.tick(), TICK_MS);
  }

  listen(userId) {
    if (this.subscribed.has(userId)) return;
    const allowed = config.isAllowed(userId);
    // Subscribe to everyone when transcribing; otherwise only to people who may
    // drive the bot. Two different questions: who can COMMAND it (allowlist)
    // and who gets WRITTEN DOWN (transcript).
    if (!allowed && !this.transcript) {
      if (!this.subscribed.has(`denied:${userId}`)) {
        this.subscribed.add(`denied:${userId}`);
        log.info('voice: ignoring speaker, not allowlisted', { userId });
      }
      return;
    }
    this.subscribed.add(userId);
    log.info('voice: speaker subscribed', { userId, drivesBot: allowed });
    const decoder = new prism.opus.Decoder({
      rate: DISCORD_RATE,
      channels: DISCORD_CH,
      frameSize: 960,
    });
    this.conn.receiver
      .subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 24 * 3600 * 1000 },
      })
      .pipe(decoder)
      .on('data', (c) => {
        // Command path: only allowlisted audio reaches speech-to-speech.
        if (allowed) {
          this.inbox.set(userId, Buffer.concat([this.inbox.get(userId) ?? Buffer.alloc(0), c]));
        }
        // Transcript path: everyone, kept separate per speaker.
        if (this.transcript) {
          this.utterance.set(
            userId,
            Buffer.concat([this.utterance.get(userId) ?? Buffer.alloc(0), c]),
          );
        }
      });
  }

  /**
   * Close an utterance only after sustained silence.
   *
   * Discord fires `speaking.end` on every brief pause, so flushing immediately
   * chops one sentence into fragments and the transcript fills with "Yeah."
   * lines. Waiting UTTERANCE_GAP_MS — and cancelling if the same speaker
   * resumes — keeps a sentence together.
   */
  scheduleFlush(userId) {
    if (!this.transcript) return;
    clearTimeout(this.flushTimers.get(userId));
    this.flushTimers.set(
      userId,
      setTimeout(() => {
        this.flushTimers.delete(userId);
        this.flush(userId);
      }, UTTERANCE_GAP_MS),
    );
  }

  /** Write one speaker's utterance to disk. */
  flush(userId) {
    if (!this.transcript) return;
    const pcm = this.utterance.get(userId);
    if (!pcm?.length) return;
    this.utterance.delete(userId);
    this.transcript.write(userId, this.names.get(userId) ?? userId, pcm);
  }

  tick() {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Take one 20ms slice from each speaker and sum them sample-aligned. With a
    // single speaker this is a pass-through; with several it is a real mix
    // rather than interleaved garbage. Speaker identity is preserved in the
    // buffers above, so per-speaker STT stays possible later.
    const ready = [];
    for (const [userId, buf] of this.inbox) {
      if (buf.length < IN_BYTES) continue;
      ready.push(buf.subarray(0, IN_BYTES));
      this.inbox.set(userId, buf.subarray(IN_BYTES));
    }

    let frame;
    if (ready.length === 0) {
      frame = Buffer.alloc(OUT_SAMPLES * 2); // silence keeps the VAD turn closing
    } else if (ready.length === 1) {
      frame = down(ready[0]);
    } else {
      frame = Buffer.alloc(OUT_SAMPLES * 2);
      const mixed = ready.map(down);
      for (let i = 0; i < OUT_SAMPLES; i++) {
        let sum = 0;
        for (const m of mixed) sum += m.readInt16LE(i * 2);
        frame.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), i * 2);
      }
    }
    this.ws.send(
      JSON.stringify({ type: 'input_audio_buffer.append', audio: frame.toString('base64') }),
    );
  }

  /**
   * (Re)connect to speech-to-speech, leaving exactly ONE live socket behind.
   *
   * Replacing `this.ws` does not silence the socket it replaced: the old object
   * keeps its `message` listener, so it goes on feeding onEvent and every reply
   * is played once per stale socket. Heard as a doubled response, and it grows
   * with each reconnect — one s2s restart is enough to start it.
   *
   * Likewise only one retry timer may be outstanding, or two chains race and
   * each leaves its own socket.
   */
  connectS2S() {
    if (this.closed) return;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    // A pending speak() was waiting on the socket that just got torn down —
    // fail it now rather than making the caller wait out the full ack
    // timeout for a reply that can never arrive.
    if (this.pendingSpeakFinish) this.pendingSpeakFinish({ ok: false, reason: 'no-socket' });

    const ws = new WebSocket(config.s2sUrl, { maxPayload: 0 });
    this.ws = ws;
    ws.on('open', () => {
      log.info('  voice: s2s connected');
      // Deliberately a PARTIAL session.update: speech-to-speech deep-merges
      // incoming fields (handlers/session.py:28), so sending only this one
      // leaves the launcher's VAD tuning — thresholds, silence durations —
      // exactly as it was. Sending a full `turn_detection` object would reset
      // whatever it does not mention.
      // Both `type` discriminators are REQUIRED, and omitting either gets the
      // whole update rejected with "Unknown or invalid event: session.update"
      // — a message that reads like the event is unsupported when it is really
      // a validation failure. Verified against the openai SessionUpdateEvent
      // model directly: without `session.type` it does not validate.
      ws.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            turn_detection: { type: 'server_vad', interrupt_response: config.interruptResponse },
          },
        }),
      );
      log.info('  voice: interrupt-on-speech', { enabled: config.interruptResponse });
    });
    // Object, not a bare string: the logger spreads its second argument, so a
    // string renders as {"0":"c","1":"o",…} and the message is unreadable.
    ws.on('error', (e) => log.error('  voice: s2s error', { error: e.message }));
    ws.on('close', () => {
      // Ignore a close from a socket we already replaced, or it schedules a
      // reconnect on top of the live one.
      if (this.closed || this.ws !== ws) return;
      log.info('  voice: s2s closed, retrying in 2s');
      this.retry = setTimeout(() => this.connectS2S(), 2000);
    });
    // Same guard: a superseded socket must not reach the player.
    ws.on('message', (raw) => {
      if (this.ws === ws) this.onEvent(raw);
    });
  }

  /**
   * Push a typed turn into this session's own s2s socket so it is answered
   * aloud through the playback path already wired for spoken turns — see the
   * design note in [[Typed messages cannot be answered aloud]]. No second TTS
   * path: the reply returns through the existing `response.output_audio.delta`
   * -> `pushAudio` route once the server accepts the request below.
   *
   * Two events per the realtime protocol: `conversation.item.create` adds the
   * text to the LLM context without triggering generation, `response.create`
   * triggers it. The server acks with `response.created`, or refuses cleanly
   * with `conversation_already_has_active_response` if a response is already
   * in flight (response.py:150).
   *
   * **Why this gates on `inResponse`/`awaitingSpeakAck` before sending
   * anything**, rather than just racing the next `response.created` off the
   * shared socket: the server auto-generates a response for a MIC turn via
   * VAD with no client `response.create` at all, so a bare event-type match
   * cannot tell "the ack for MY request" from "someone else on the call just
   * finished a sentence". Gating first — refusing as `busy` client-side when
   * a response is already known to be in flight, and refusing a second
   * concurrent `speak()` the same way — closes that window down to the
   * network round-trip between the check and the send, which is the same
   * residual race the server itself accepts (its own gate is a plain
   * boolean, not a queue). Still not a client-side response STATE MACHINE:
   * `inResponse` only mirrors what the server already reports on every
   * `response.created`/`response.done`, it decides nothing on its own.
   *
   * Accepted tradeoff: once `conversation.item.create` is actually sent, a
   * `timeout` or a lost-race `no-socket` (via `connectS2S()`'s reconnect
   * hook) is reported to the caller, but the item itself is never retracted
   * — the server has no "cancel this item" message, and the deferred-item
   * flush in conversation.py means it may still surface in the transcript
   * later, attributed correctly to the user, just without a spoken reply
   * this turn. The common busy case never reaches this window at all,
   * because the gate above refuses before sending anything.
   */
  async speak(text, { timeoutMs = config.speakAckTimeoutMs } = {}) {
    // Both refusals are decided BEFORE the typed-turn hint is set, so the
    // common "someone is already talking" case never leaves a hint behind for
    // a turn that will not happen.
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { ok: false, reason: 'no-socket' };
    }
    // `answering` as well as `inResponse`, and it is the one that matters for
    // a MIC turn: the server announces `response.created` only for a response
    // the client asked for, so `inResponse` stays false through an entire
    // spoken answer. Gating on it alone meant typing while the assistant was
    // already talking sailed past this check and was refused by the server
    // instead — correct, but a round trip later and with a worse reason.
    if (this.awaitingSpeakAck || this.inResponse || this.answering) {
      return { ok: false, reason: 'busy' };
    }

    // Before the turn, not after: the endpoint consumes the hint at the top of
    // the turn it belongs to, and s2s only calls the endpoint once generation
    // starts — strictly after the `response.created` awaited below. Awaited so
    // it cannot lose the race against a fast turn. Voice always lands on the
    // default session key, which is the key the endpoint will read.
    await llm.markTypedTurn(llm.DEFAULT_SESSION_KEY);
    // Deliberately a local closure rather than a second method: `speak` is
    // driven in tests as `Session.prototype.speak.call(fakeSession, …)`, and
    // anything reached through `this` would have to be re-attached to every
    // fake — a helper whose only effect is to make the code harder to test.
    const awaitAck = () =>
      new Promise((resolve) => {
        this.awaitingSpeakAck = true;
        const ws = this.ws;
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.removeListener('message', onAck);
          this.awaitingSpeakAck = false;
          this.pendingSpeakFinish = null;
          resolve(result);
        };
        this.pendingSpeakFinish = finish;
        const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
        const onAck = (raw) => {
          let e;
          try {
            e = JSON.parse(raw);
          } catch {
            return;
          }
          if (e.type === 'response.created') {
            this.typedReplyPending = true;
            finish({ ok: true });
          } else if (e.type === 'error') {
            // Any refusal ends the wait immediately — not just the one reason
            // this path anticipates — so a caller sees the real reason instead
            // of a misleading `timeout` several seconds later. The server's own
            // "one response at a time" refusal keeps its documented `busy`
            // label (response.py:150); every other error type is passed
            // through as-is rather than flattened to a generic string.
            const type = e.error?.type;
            finish({
              ok: false,
              reason:
                type === 'conversation_already_has_active_response' ? 'busy' : type || 'error',
            });
          }
        };
        ws.on('message', onAck);
        ws.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
          }),
        );
        ws.send(JSON.stringify({ type: 'response.create' }));
      });

    const result = await awaitAck();
    // A hint left behind by a turn that died after the send would mark the
    // next unrelated SPOKEN reply as typed-originated. Cheap to undo.
    if (!result.ok) await llm.markTypedTurn(llm.DEFAULT_SESSION_KEY, false);
    return result;
  }

  /**
   * Keep Discord's "…is typing" dots alive in the call's text chat while the
   * assistant is answering — whichever surface asked.
   *
   * Raised from TWO signals, because the two surfaces announce themselves
   * differently and there is no single event covering both: `response.created`
   * for a turn the client asked for (typed), and the user's utterance being
   * transcribed for a mic turn — which never emits `response.created` at all.
   * Assuming one event covered both is exactly how the first attempt at this
   * shipped without working for speech.
   *
   * Accepted cost, stated because it is a real one: a spoken turn that never
   * produces a written copy (a greeting, a two-sentence answer with nothing
   * postable) now flashes the dots for a moment and posts nothing. That reads
   * as "it is working", which is true, and is the lesser evil against text
   * arriving with no warning it was coming.
   *
   * Self-terminating three ways, because an indicator nobody clears is worse
   * than none: the response ending, the session closing, and a hard cap.
   * Discord also clears it by itself the moment a message is sent.
   */
  showTyping() {
    if (!this.channel?.sendTyping || this.typingTimer) return;
    const startedAt = Date.now();
    const tick = () => this.channel.sendTyping().catch(() => {});
    tick();
    this.typingTimer = setInterval(() => {
      if (!this.answering || this.closed || Date.now() - startedAt > TYPING_MAX_MS) {
        clearInterval(this.typingTimer);
        this.typingTimer = null;
        // The cap is now a stuck-state guard, not just a cosmetic stop: since
        // speak() refuses while `answering` is true, a response that never
        // reports finishing would otherwise wedge typed turns as permanently
        // busy. Releasing it here bounds that to TYPING_MAX_MS.
        this.answering = false;
        return;
      }
      tick();
    }, TYPING_TICK_MS);
    // Never hold the process open for a cosmetic indicator.
    this.typingTimer.unref?.();
  }

  onEvent(raw) {
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      return;
    }
    // LOG_LEVEL=debug traces the audio path: which events arrive, how much PCM
    // each carries, and how many times playback is triggered per turn. Cheap to
    // leave in — a doubled reply is invisible in the transcript, because it is
    // the same text played twice rather than said twice.
    log.debug('  voice: s2s event', {
      type: e.type,
      bytes: e.delta ? Buffer.byteLength(e.delta, 'base64') : undefined,
      playing: Boolean(this.audio),
    });
    switch (e.type) {
      // Mirrors the server's own st.in_response gate (response.py) — set on
      // EVERY response.created, not just ones speak() triggered, because a
      // mic-driven VAD turn puts the connection in the same busy state and
      // speak() must refuse just as cleanly during someone else's live reply.
      case 'response.created':
        this.inResponse = true;
        this.answering = true;
        this.showTyping();
        break;
      case 'input_audio_buffer.speech_started':
        if (this.speaking) {
          log.info('  voice: barge-in — stopping playback');
          // Must destroy the stream too: stopping the player alone leaves it
          // open, and the next chunk would resume the abandoned reply.
          this.stopAudio();
        }
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (e.transcript) log.info(`  voice YOU: ${e.transcript}`);
        // The mic turn's "an answer is coming" signal — the user has finished
        // an utterance and it has been transcribed. This is where the spoken
        // path raises the dots, because `response.created` never arrives for
        // it (see `answering` in the constructor).
        //
        // Only when the utterance was actually ADDRESSED to the bot. An
        // unaddressed one is answered with silence by the endpoint, so nothing
        // ever arrives to clear the flag: the dots hung until the five-minute
        // cap, and — worse than cosmetic — `speak()` refuses typed turns as
        // `busy` for exactly as long. Every sentence spoken to a colleague
        // would have wedged the typed path.
        if (config.isAddressed(e.transcript)) {
          this.answering = true;
          this.showTyping();
        } else {
          log.debug('  voice: not addressed, no typing indicator');
        }
        break;
      // NOTE: response.output_audio.delta — NOT response.audio.delta, which is
      // what OpenAI's hosted Realtime uses and what most write-ups quote.
      case 'response.output_audio.delta':
        if (e.delta) this.pushAudio(Buffer.from(e.delta, 'base64'));
        break;
      // Deltas are logged only to settle where a missing separator comes from.
      // A transcript once read "Won't be long.No — I didn't send anything
      // anywhere": a holding line and an answer with nothing between them. The
      // endpoint demonstrably ends every SSE chunk with a trailing space, and
      // speech-to-speech joins sentence batches with a space, so the loss is
      // somewhere between — and unquoted logging cannot show it, because the
      // whole question is whitespace.
      case 'response.output_audio_transcript.delta':
        if (e.delta) log.debug('  voice BOT delta', { raw: JSON.stringify(e.delta) });
        break;
      case 'response.output_audio_transcript.done':
        if (e.transcript) {
          // Fires only on the defect, so it costs nothing until it happens and
          // needs no log level raised to catch it — the failure is rare, comes
          // from a live call, and is invisible in unquoted output.
          if (RUN_ON.test(e.transcript)) {
            log.warn('transcript run-on: sentence end with no separator', {
              raw: JSON.stringify(e.transcript.slice(0, 200)),
            });
          }
          log.info(`  voice BOT: ${e.transcript}`);
          // The bot's own speech never returns through Discord, so without this
          // the transcript is one-sided: questions with no answers. A reply
          // triggered by speak() (a typed turn) is marked distinctly from an
          // ordinary spoken reply — same write path, but the record still has
          // to show WHICH surface asked, matching the "(typed) " marker
          // already put on the user's turn.
          this.transcript?.writeText(
            config.botName,
            this.typedReplyPending ? `(typed→spoken) ${e.transcript}` : e.transcript,
          );
          this.typedReplyPending = false;
        }
        break;
      case 'response.output_audio.done':
      case 'response.done':
        // Defensive: a response that ends with no transcript (empty/failed
        // synthesis) must not leave a stale flag marking the NEXT unrelated
        // reply as typed-originated. Same for inResponse — a stuck `true`
        // here would wedge every future speak() as permanently busy.
        this.typedReplyPending = false;
        this.inResponse = false;
        this.answering = false;
        this.endAudio();
        break;
      case 'error':
        log.error('  voice: s2s event error', JSON.stringify(e).slice(0, 200));
        break;
    }
  }

  /**
   * Start playback on the FIRST audio chunk, not when the response completes.
   *
   * Waiting for `response.output_audio.done` buffers the whole reply and plays
   * it in one go — measured: 211 deltas held, then 33.6s of audio at once. The
   * shim emits its "checking that now" at 0.16s and speech-to-speech synthesises
   * it separately, but the listener still heard it immediately before the
   * answer, because nothing reached the speaker until the answer existed. Every
   * upstream latency fix was being discarded here.
   *
   * A PassThrough lets the player consume audio while more is still arriving:
   * the stream stays open between chunks rather than ending, so a gap in
   * synthesis pauses playback instead of finishing it.
   */
  pushAudio(chunk) {
    this.outQueue = Buffer.concat([this.outQueue, up(chunk)]);
    if (this.audio) return;

    this.audio = new PassThrough();
    this.ending = false;
    this.speaking = true;
    log.debug('  voice: playback started');
    this.player.play(createAudioResource(this.audio, { inputType: StreamType.Raw }));
    // Paced writer, mirroring the input pump above. Writing chunks straight
    // through as they arrive underruns: a turn speaks a one-second filler, then
    // synthesises nothing for four seconds while tools run. The player drains
    // the stream, finds it empty, treats that as the end of the resource and
    // goes idle — after which every later write lands in a stream nobody reads.
    // Measured: the filler was heard, the answer never was, though both were
    // synthesised. Silence between utterances keeps the resource alive.
    this.outTick = setInterval(() => this.pumpOut(), TICK_MS);
  }

  /** One 20ms frame out: real audio if we have it, silence if we do not. */
  pumpOut() {
    if (!this.audio) return;
    if (this.outQueue.length >= OUT_FRAME) {
      this.audio.write(this.outQueue.subarray(0, OUT_FRAME));
      this.outQueue = this.outQueue.subarray(OUT_FRAME);
      return;
    }
    // Nothing queued. Once the turn has ended, drain the tail and close;
    // otherwise hold the resource open with silence.
    //
    // The silence is also load-bearing for the UI, which is easy to miss: while
    // a resource is live Discord shows the bot's speaking ring, so the ring
    // stays lit for the whole turn — through the pauses while tools run, not
    // only while words are coming out. That is a free "still working" signal,
    // and it is the same signal that keeps the audio alive. An optimisation
    // that skips silence during long gaps would remove both.
    if (this.ending) {
      if (this.outQueue.length) {
        this.audio.write(this.outQueue);
        this.outQueue = Buffer.alloc(0);
        return;
      }
      return this.finishAudio();
    }
    this.audio.write(SILENCE);
  }

  /** Turn is over: drain whatever is queued, then let the player go idle. */
  endAudio() {
    if (!this.audio) return;
    this.ending = true;
  }

  finishAudio() {
    clearInterval(this.outTick);
    this.outTick = null;
    try {
      this.audio?.end();
    } catch {}
    this.audio = null;
    this.ending = false;
    log.debug('  voice: playback finished');
  }

  /** Abandon playback mid-stream — barge-in, or teardown. */
  stopAudio() {
    clearInterval(this.outTick);
    this.outTick = null;
    this.outQueue = Buffer.alloc(0);
    if (this.audio) {
      this.audio.destroy();
      this.audio = null;
    }
    this.ending = false;
    try {
      this.player.stop(true);
    } catch {}
    this.speaking = false;
  }

  destroy() {
    // Flush in-flight utterances before tearing down, or the last thing anyone
    // said is silently lost.
    for (const t of this.flushTimers.values()) clearTimeout(t);
    this.flushTimers.clear();
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    for (const userId of [...this.utterance.keys()]) this.flush(userId);
    this.closed = true;
    // Same fail-fast as connectS2S()'s reconnect hook: a pending speak() has
    // no socket to hear an ack on once the session is torn down, so it must
    // not sit out the full ack timeout for a reply that can never arrive.
    if (this.pendingSpeakFinish) this.pendingSpeakFinish({ ok: false, reason: 'no-socket' });
    clearInterval(this.pump);
    this.stopAudio(); // also destroys an open playback stream, not just the player
    try {
      this.ws?.close();
    } catch {}
    try {
      this.conn.destroy();
    } catch {}
  }
}

const sessions = new Map(); // guildId -> Session

async function join(channel) {
  leave(channel.guild.id);
  const conn = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false, // MUST be false — the default deafens the bot and it hears nothing
    selfMute: false,
  });
  conn.on('stateChange', (o, n) => log.info(`  voice: ${o.status} -> ${n.status}`));
  await entersState(conn, VoiceConnectionStatus.Ready, 30000);
  const session = new Session(
    conn,
    channel.guild.id,
    channel.guild.name,
    channel.name,
    channel.id,
    channel,
  );
  // Resolve display names once so the transcript reads with names, not ids.
  for (const [id, member] of channel.members) {
    session.names.set(id, member.displayName ?? member.user.username);
  }
  sessions.set(channel.guild.id, session);
  log.info('voice: joined', { channel: channel.name, transcribing: Boolean(session.transcript) });
  return session;
}

function leave(guildId) {
  const s = sessions.get(guildId);
  if (s) {
    s.destroy();
    sessions.delete(guildId);
    return true;
  }
  const stray = getVoiceConnection(guildId);
  if (stray) {
    stray.destroy();
    return true;
  }
  return false;
}

/**
 * Evict a voice connection left behind by a previous process.
 *
 * If the bot is killed while in a voice channel, Discord keeps showing it as a
 * participant. A fresh process has no session for it, and `getVoiceConnection`
 * only sees connections *this* process opened — so /leave reports "not in a
 * voice channel" while the bot is visibly sitting in one. Disconnecting via the
 * gateway voice state works regardless of which process opened it.
 */
async function evictGhost(guild) {
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) return null;

  // members.me.voice reads a cache that may not be populated yet at
  // clientReady, so fall back to the guild's voice-state cache directly. A
  // ghost that is invisible to one of these is usually visible to the other.
  const channelId = me.voice?.channelId ?? guild.voiceStates?.cache?.get(me.id)?.channelId ?? null;
  if (!channelId) return null;

  const name = guild.channels.cache.get(channelId)?.name ?? channelId;
  // disconnect() goes through the gateway voice state, so it works regardless
  // of which process opened the connection.
  await me.voice.disconnect().catch(() => {});
  return name;
}

/**
 * The live transcript for a channel, if that channel's voice session is running.
 *
 * A voice channel's text chat shares the voice channel's id, so a message posted
 * there belongs in the same record as the speech — that is what lets someone
 * paste a link and then ask about it out loud.
 */
/**
 * Record arrivals and departures in the transcript.
 *
 * Two reasons beyond tidiness. A reader — human or the assistant — cannot tell
 * from speech alone who was present, so a gap in someone's contributions is
 * ambiguous between "said nothing" and "was not there". And it makes SSRC churn
 * self-evidencing: a rejoin appears in the record, so whether audio survived it
 * is visible in the file rather than only in a debug log.
 *
 * Also the moment to refresh display names. They are resolved once at join
 * (see `join` below), so anyone arriving later was previously written down as a
 * raw user id.
 */
function noteVoiceState(oldState, newState) {
  const guildId = newState.guild?.id ?? oldState.guild?.id;
  const session = guildId ? sessions.get(guildId) : null;
  if (!session?.transcript) return;

  const here = session.channelId;
  const was = oldState.channelId === here;
  const is = newState.channelId === here;
  if (was === is) return; // mute/deafen/camera — not an arrival or departure

  const member = newState.member ?? oldState.member;
  const userId = member?.id ?? newState.id ?? oldState.id;
  const name = member?.displayName ?? member?.user?.username ?? userId;
  if (userId && name) session.names.set(userId, name);

  session.transcript.writeText(name, is ? '(joined the channel)' : '(left the channel)');
  log.info(`voice: ${is ? 'joined' : 'left'}`, { user: name });
}

function transcriptFor(guildId, channelId) {
  const s = guildId ? sessions.get(guildId) : null;
  return s && s.channelId === channelId ? s.transcript : null;
}

/**
 * The live `Session` whose call this channel IS, if any.
 *
 * A voice channel's integrated text chat shares the voice channel's id (see
 * `transcriptFor` above), so this is the same match used to route a typed
 * message that arrived DURING that call into it — see `Session.speak` and
 * [[Typed messages cannot be answered aloud]]. `null` for every other
 * channel (DM, thread, guild channel with no live call), which is what keeps
 * ordinary text answering unaffected.
 */
function liveSessionFor(guildId, channelId) {
  const s = guildId ? sessions.get(guildId) : null;
  return s && !s.closed && s.channelId === channelId ? s : null;
}

/**
 * Post the shim's full answer into the live voice call's channel.
 *
 * The payload that reaches here carries no channel id on purpose (see the
 * shim's `post_chat_message`) — speech-to-speech owns the voice HTTP call and
 * cannot set one, so the shim cannot know which call is live even in
 * principle. This bot can: `sessions` holds exactly the calls it is actually
 * in. Two concurrent calls is therefore ambiguous by construction rather than
 * by a missing feature, and is dropped rather than guessed at (see the task's
 * Out of Scope).
 */
async function postToChannel(text) {
  const live = [...sessions.values()].filter((s) => !s.closed);
  if (live.length === 0) {
    log.warn('chat bridge: no live voice session, dropping', { chars: text.length });
    return { posted: false, reason: 'no-live-session' };
  }
  if (live.length > 1) {
    log.warn('chat bridge: multiple live voice sessions, dropping (ambiguous)', {
      count: live.length,
    });
    return { posted: false, reason: 'ambiguous-multiple-sessions' };
  }
  const session = live[0];
  try {
    for (const part of chunk(text)) await session.channel.send(part);
    session.transcript?.writeText(config.botName, text);
    log.info('chat bridge: posted to channel', { channel: session.channelId, chars: text.length });
    return { posted: true, channel: session.channelId };
  } catch (e) {
    log.error('chat bridge: post failed', { error: e.message });
    return { posted: false, reason: 'send-failed' };
  }
}

module.exports = {
  join,
  leave,
  evictGhost,
  sessions,
  transcriptFor,
  liveSessionFor,
  noteVoiceState,
  postToChannel,
  // Exported for unit tests to exercise Session.prototype.speak against a
  // fake ws (no real audio pipeline needed) — see test/voice.test.js.
  Session,
};
