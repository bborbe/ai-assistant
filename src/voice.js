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
const { Readable } = require('stream');
const WebSocket = require('ws');
const config = require('./config');
const log = require('./log');

const DISCORD_RATE = 48000,
  DISCORD_CH = 2;
const S2S_RATE = 16000;
const TICK_MS = 20;
const IN_BYTES = (DISCORD_RATE * DISCORD_CH * 2 * TICK_MS) / 1000; // 20ms @48k stereo
const OUT_SAMPLES = (S2S_RATE * TICK_MS) / 1000; // 20ms @16k mono

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
  constructor(connection, guildId) {
    this.conn = connection;
    this.guildId = guildId;
    this.inbox = Buffer.alloc(0);
    this.reply = [];
    this.speaking = false;
    this.subscribed = new Set();
    this.closed = false;

    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.conn.subscribe(this.player);
    this.player.on('idle', () => {
      this.speaking = false;
    });

    this.conn.receiver.speaking.on('start', (userId) => this.listen(userId));
    this.connectS2S();

    // Discord emits audio ONLY while someone speaks, but s2s closes a turn on
    // SILENCE. Without this fixed-rate pump sending silence between utterances
    // the turn never ends and no reply is ever produced.
    this.pump = setInterval(() => this.tick(), TICK_MS);
  }

  listen(userId) {
    if (this.subscribed.has(userId)) return;
    if (!config.isAllowed(userId)) {
      if (!this.subscribed.has(`denied:${userId}`)) {
        this.subscribed.add(`denied:${userId}`);
        log.info(`  voice: IGNORING ${userId} — not allowlisted`);
      }
      return;
    }
    this.subscribed.add(userId);
    log.info(`  voice <- ${userId} speaking`);
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
        this.inbox = Buffer.concat([this.inbox, c]);
      });
  }

  tick() {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    let frame;
    if (this.inbox.length >= IN_BYTES) {
      frame = down(this.inbox.subarray(0, IN_BYTES));
      this.inbox = this.inbox.subarray(IN_BYTES);
    } else {
      frame = Buffer.alloc(OUT_SAMPLES * 2); // silence
    }
    this.ws.send(
      JSON.stringify({ type: 'input_audio_buffer.append', audio: frame.toString('base64') }),
    );
  }

  connectS2S() {
    if (this.closed) return;
    this.ws = new WebSocket(config.s2sUrl, { maxPayload: 0 });
    this.ws.on('open', () => log.info('  voice: s2s connected'));
    this.ws.on('error', (e) => log.error('  voice: s2s error', e.message));
    this.ws.on('close', () => {
      if (this.closed) return;
      log.info('  voice: s2s closed, retrying in 2s');
      setTimeout(() => this.connectS2S(), 2000);
    });
    this.ws.on('message', (raw) => this.onEvent(raw));
  }

  onEvent(raw) {
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      return;
    }
    switch (e.type) {
      case 'input_audio_buffer.speech_started':
        if (this.speaking) {
          log.info('  voice: barge-in — stopping playback');
          this.player.stop(true);
          this.speaking = false;
        }
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (e.transcript) log.info(`  voice YOU: ${e.transcript}`);
        break;
      // NOTE: response.output_audio.delta — NOT response.audio.delta, which is
      // what OpenAI's hosted Realtime uses and what most write-ups quote.
      case 'response.output_audio.delta':
        if (e.delta) this.reply.push(Buffer.from(e.delta, 'base64'));
        break;
      case 'response.output_audio_transcript.done':
        if (e.transcript) log.info(`  voice BOT: ${e.transcript}`);
        break;
      case 'response.output_audio.done':
      case 'response.done':
        this.play();
        break;
      case 'error':
        log.error('  voice: s2s event error', JSON.stringify(e).slice(0, 200));
        break;
    }
  }

  play() {
    if (!this.reply.length) return;
    const pcm = up(Buffer.concat(this.reply));
    this.reply = [];
    this.speaking = true;
    this.player.play(createAudioResource(Readable.from(pcm), { inputType: StreamType.Raw }));
  }

  destroy() {
    this.closed = true;
    clearInterval(this.pump);
    try {
      this.player.stop(true);
    } catch {}
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
  sessions.set(channel.guild.id, new Session(conn, channel.guild.id));
  log.info(`  voice: joined #${channel.name}`);
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
  if (!me?.voice?.channelId) return null;
  const name = me.voice.channel?.name ?? me.voice.channelId;
  await me.voice.disconnect().catch(() => {});
  return name;
}

module.exports = { join, leave, evictGhost, sessions };
