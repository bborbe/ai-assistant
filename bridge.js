#!/usr/bin/env node
// Discord voice  <->  speech-to-speech realtime  <->  MiniMax
//
//   DISCORD_TOKEN=... node bridge.js "<guild>" "<voice channel>"
//
// Requires s2s already running:  S2S_MODE=realtime ~/Documents/workspaces/scripts/s2s-minimax
//
// Three things this has to get right, all learned from the two spikes:
//  1. Discord emits audio ONLY while someone speaks. s2s's VAD closes a turn on
//     silence, so a fixed 20ms ticker must send silence during gaps — otherwise
//     the turn never ends and no response is ever generated.
//  2. Never send input_audio_buffer.commit / response.create. They race the
//     VAD-driven response ("speech during pending response: cancelled").
//  3. Audio comes back as response.output_audio.delta, NOT response.audio.delta.

const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel, EndBehaviorType, entersState, VoiceConnectionStatus,
  createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { Readable } = require('stream');
const WebSocket = require('ws');

const [guildName, channelName] = process.argv.slice(2);
const TOKEN = process.env.DISCORD_TOKEN;
const S2S_URL = process.env.S2S_URL || 'ws://127.0.0.1:8765/v1/realtime';
if (!guildName || !channelName || !TOKEN) {
  console.error('usage: DISCORD_TOKEN=... node bridge.js "<guild>" "<voice channel>"');
  process.exit(2);
}

const DISCORD_RATE = 48000, DISCORD_CH = 2;
const S2S_RATE = 16000;
const TICK_MS = 20;
const IN_BYTES = DISCORD_RATE * DISCORD_CH * 2 * TICK_MS / 1000;  // 3840 = 20ms @48k stereo
const OUT_SAMPLES = S2S_RATE * TICK_MS / 1000;                    // 320  = 20ms @16k mono

// --- resampling ------------------------------------------------------------
// Crude but adequate for speech: mix to mono, then average each group of 3
// samples (box low-pass at the decimation point). NOT naive striding, which
// both scrambles interleaved channels and aliases.
function down48StereoTo16Mono(buf) {
  const out = Buffer.alloc(OUT_SAMPLES * 2);
  for (let i = 0; i < OUT_SAMPLES; i++) {
    let acc = 0;
    for (let k = 0; k < 3; k++) {
      const off = (i * 3 + k) * 4;               // 4 bytes per stereo frame
      if (off + 3 >= buf.length) break;
      acc += (buf.readInt16LE(off) + buf.readInt16LE(off + 2)) / 2;
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc / 3))), i * 2);
  }
  return out;
}

// 16k mono -> 48k stereo, linear interpolation (better than sample-repeat).
function up16MonoTo48Stereo(buf) {
  const n = buf.length / 2;
  const out = Buffer.alloc(n * 3 * 4);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const cur = buf.readInt16LE(i * 2);
    const nxt = i + 1 < n ? buf.readInt16LE((i + 1) * 2) : cur;
    for (let k = 0; k < 3; k++) {
      const v = Math.round(cur + (nxt - cur) * (k / 3));
      out.writeInt16LE(v, o); out.writeInt16LE(v, o + 2);
      o += 4;
    }
  }
  return out;
}

// --- state -----------------------------------------------------------------
let inbox = Buffer.alloc(0);        // decoded 48k stereo waiting to be sent
let ws = null, player = null, speaking = false;
let replyChunks = [];

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.once('clientReady', async () => {
  console.log(`bot: ${client.user.tag}`);
  const guild = client.guilds.cache.find(g => g.name === guildName);
  await guild.channels.fetch();
  const channel = guild.channels.cache.find(c => c.name === channelName && c.isVoiceBased());

  const conn = joinVoiceChannel({
    channelId: channel.id, guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, selfMute: false,        // selfDeaf:false or we hear nothing
  });
  conn.on('stateChange', (o, n) => console.log(`  voice: ${o.status} -> ${n.status}`));
  await entersState(conn, VoiceConnectionStatus.Ready, 30_000);

  player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  conn.subscribe(player);
  console.log(`joined "${channel.name}"`);

  // Discord -> inbox (only fires while someone is actually speaking)
  const receiver = conn.receiver;
  const subscribed = new Set();
  receiver.speaking.on('start', (userId) => {
    if (subscribed.has(userId)) return;
    subscribed.add(userId);
    console.log(`  <- ${userId} speaking`);
    const decoder = new prism.opus.Decoder({ rate: DISCORD_RATE, channels: DISCORD_CH, frameSize: 960 });
    receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 24 * 3600 * 1000 } })
      .pipe(decoder)
      .on('data', (c) => { inbox = Buffer.concat([inbox, c]); });
  });

  connectS2S();

  // Fixed-rate pump: whatever arrived this tick, else silence. This is what
  // lets s2s's VAD ever see end-of-turn.
  setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    let frame;
    if (inbox.length >= IN_BYTES) {
      frame = down48StereoTo16Mono(inbox.subarray(0, IN_BYTES));
      inbox = inbox.subarray(IN_BYTES);
    } else {
      frame = Buffer.alloc(OUT_SAMPLES * 2);   // silence
    }
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: frame.toString('base64') }));
  }, TICK_MS);
});

function connectS2S() {
  console.log(`connecting ${S2S_URL}`);
  ws = new WebSocket(S2S_URL, { maxPayload: 0 });
  ws.on('open', () => console.log('s2s connected — talk in Discord'));
  ws.on('error', (e) => console.error('s2s error:', e.message));
  ws.on('close', () => { console.log('s2s closed, retrying in 2s'); setTimeout(connectS2S, 2000); });

  ws.on('message', (raw) => {
    let e; try { e = JSON.parse(raw); } catch { return; }
    switch (e.type) {
      case 'input_audio_buffer.speech_started':
        if (speaking) { console.log('  || barge-in — stopping playback'); player.stop(true); speaking = false; }
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (e.transcript) console.log(`  YOU: ${e.transcript}`);
        break;
      case 'response.output_audio.delta':
        if (e.delta) replyChunks.push(Buffer.from(e.delta, 'base64'));
        break;
      case 'response.output_audio_transcript.done':
        if (e.transcript) console.log(`  BOT: ${e.transcript}`);
        break;
      case 'response.output_audio.done':
      case 'response.done':
        flushReply();
        break;
      case 'error':
        console.error('  s2s event error:', JSON.stringify(e).slice(0, 300));
        break;
    }
  });
}

function flushReply() {
  if (!replyChunks.length) return;
  const pcm48 = up16MonoTo48Stereo(Buffer.concat(replyChunks));
  replyChunks = [];
  const secs = pcm48.length / (DISCORD_RATE * DISCORD_CH * 2);
  console.log(`  -> playing ${secs.toFixed(1)}s`);
  speaking = true;
  const res = createAudioResource(Readable.from(pcm48), { inputType: StreamType.Raw });
  player.play(res);
  player.once('idle', () => { speaking = false; });
}

process.on('SIGINT', () => { console.log('\nbye'); process.exit(0); });
client.login(TOKEN);
