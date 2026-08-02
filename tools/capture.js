#!/usr/bin/env node
// Spike: prove a Discord bot can receive voice-channel audio and decode it.
//
// Captures RAW 48 kHz stereo PCM per speaker — no resampling here on purpose.
// Discord delivers 48 kHz stereo interleaved; converting to the 16 kHz mono
// speech-to-speech wants wrongly (naive `pcm[::3]`) both scrambles channels
// and aliases. Resampling is done afterwards by to16k.py using soxr.
//
//   DISCORD_TOKEN=... node capture.js "<guild name>" "<voice channel name>"
//
// Speak for a few seconds, then Ctrl-C. Writes out/<user>-48k-stereo.wav.

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, EndBehaviorType, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const prism = require('prism-media');

const [guildName, channelName] = process.argv.slice(2);
if (!guildName || !channelName) {
  console.error('usage: node capture.js "<guild name>" "<voice channel name>"');
  process.exit(2);
}
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error('DISCORD_TOKEN not set'); process.exit(2); }

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

// 48 kHz, 16-bit, stereo — what Discord actually gives us.
function wavHeader(dataLen, rate = 48000, channels = 2, bits = 16) {
  const b = Buffer.alloc(44);
  const byteRate = rate * channels * bits / 8;
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(byteRate, 28); b.writeUInt16LE(channels * bits / 8, 32);
  b.writeUInt16LE(bits, 34); b.write('data', 36); b.writeUInt32LE(dataLen, 40);
  return b;
}

const buffers = new Map();   // userId -> Buffer[]
const seenSsrc = new Map();  // userId -> Set<ssrc>, to observe SSRC churn on rejoin

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.once('clientReady', async () => {
  console.log(`logged in as ${client.user.tag}`);
  const guild = client.guilds.cache.find(g => g.name === guildName);
  if (!guild) {
    console.error(`guild ${JSON.stringify(guildName)} not found. visible:`,
      [...client.guilds.cache.values()].map(g => g.name));
    process.exit(1);
  }
  await guild.channels.fetch();
  const channel = guild.channels.cache.find(c => c.name === channelName && c.isVoiceBased());
  if (!channel) {
    console.error(`voice channel ${JSON.stringify(channelName)} not found. visible:`,
      [...guild.channels.cache.values()].filter(c => c.isVoiceBased()).map(c => c.name));
    process.exit(1);
  }

  const conn = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,   // MUST be false or we receive nothing
    selfMute: true,
  });
  conn.on('stateChange', (o, n) => {
    console.log(`  voice state: ${o.status} -> ${n.status}`
      + (n.reason ? ` (${n.reason})` : '')
      + (n.closeCode ? ` close=${n.closeCode}` : ''));
  });
  conn.on('error', (e) => console.error('  voice error:', e.message));

  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 30_000);
  } catch (e) {
    console.error(`\n!! never reached Ready (stuck in ${conn.state.status}) — ${e.message}`);
    console.error('   Signalling  = Discord never answered the voice-server-update');
    console.error('   Connecting  = websocket up, UDP handshake failing (network/firewall)');
    conn.destroy();
    process.exit(1);
  }
  console.log(`joined "${channel.name}" — speak now`);

  const receiver = conn.receiver;
  receiver.speaking.on('start', (userId) => {
    if (buffers.has(userId)) return;  // already subscribed
    buffers.set(userId, []);
    console.log(`  <- ${userId} started speaking`);

    const opus = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 30_000 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

    opus.on('data', () => {});  // keep flowing
    opus.pipe(decoder);
    decoder.on('data', (chunk) => buffers.get(userId).push(chunk));
    decoder.on('error', (e) => console.error(`  !! decode error ${userId}:`, e.message));
    opus.on('end', () => {
      console.log(`  -- ${userId} stream ended`);
      buffers.delete(userId) && null;
    });
  });

  receiver.speaking.on('end', (userId) => {
    const set = seenSsrc.get(userId) || new Set();
    seenSsrc.set(userId, set);
  });
});

function flush() {
  let wrote = 0;
  for (const [userId, chunks] of buffers) {
    const data = Buffer.concat(chunks);
    if (data.length === 0) { console.log(`  (no audio for ${userId})`); continue; }
    const file = path.join(OUT, `${userId}-48k-stereo.wav`);
    fs.writeFileSync(file, Buffer.concat([wavHeader(data.length), data]));
    const secs = data.length / (48000 * 2 * 2);
    console.log(`wrote ${file}  ${(data.length / 1024).toFixed(0)} KiB  ${secs.toFixed(1)}s`);
    wrote++;
  }
  if (!wrote) console.log('NOTHING CAPTURED — check selfDeaf:false, that you actually spoke, and bot permissions');
  process.exit(wrote ? 0 : 1);
}

process.on('SIGINT', () => { console.log('\nstopping…'); flush(); });
client.login(TOKEN);
