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

const DISCORD_RATE = 48000,
  DISCORD_CH = 2;
const S2S_RATE = 16000;
const TICK_MS = 20;
// How long a speaker must stay silent before their utterance is considered
// finished. Discord's speaking.end fires on brief pauses within a sentence.
const UTTERANCE_GAP_MS = parseInt(process.env.UTTERANCE_GAP_MS || '1500', 10);
const IN_BYTES = (DISCORD_RATE * DISCORD_CH * 2 * TICK_MS) / 1000; // 20ms @48k stereo
const OUT_SAMPLES = (S2S_RATE * TICK_MS) / 1000; // 20ms @16k mono
// One 20ms frame of what Discord plays back: 48k, stereo, 16-bit.
const OUT_FRAME = (DISCORD_RATE * DISCORD_CH * 2 * TICK_MS) / 1000;
const SILENCE = Buffer.alloc(OUT_FRAME);

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
  constructor(connection, guildId, guildName, channelName, channelId) {
    this.conn = connection;
    this.guildId = guildId;
    // A Discord voice channel has an integrated text chat sharing its id, so
    // this is what links a posted message to the running transcript.
    this.channelId = channelId;
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

    const ws = new WebSocket(config.s2sUrl, { maxPayload: 0 });
    this.ws = ws;
    ws.on('open', () => log.info('  voice: s2s connected'));
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
        break;
      // NOTE: response.output_audio.delta — NOT response.audio.delta, which is
      // what OpenAI's hosted Realtime uses and what most write-ups quote.
      case 'response.output_audio.delta':
        if (e.delta) this.pushAudio(Buffer.from(e.delta, 'base64'));
        break;
      case 'response.output_audio_transcript.done':
        if (e.transcript) {
          log.info(`  voice BOT: ${e.transcript}`);
          // The bot's own speech never returns through Discord, so without this
          // the transcript is one-sided: questions with no answers.
          this.transcript?.writeText(config.botName, e.transcript);
        }
        break;
      case 'response.output_audio.done':
      case 'response.done':
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
  const session = new Session(conn, channel.guild.id, channel.guild.name, channel.name, channel.id);
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
function transcriptFor(guildId, channelId) {
  const s = guildId ? sessions.get(guildId) : null;
  return s && s.channelId === channelId ? s.transcript : null;
}

module.exports = { join, leave, evictGhost, sessions, transcriptFor };
