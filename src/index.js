#!/usr/bin/env node
'use strict';

const { Client, GatewayIntentBits, Partials, REST, Routes, MessageFlags } = require('discord.js');
const config = require('./config');
const voice = require('./voice');
const text = require('./text');
const { sessionKeyFor } = require('./llm');
const { buildCommands, VOICE_DISABLED_REPLY } = require('./slash-commands');
const log = require('./log');
const { startHealthServer } = require('./health');

const problems = config.check();
if (problems.length) {
  for (const p of problems) log.error('bad config', { problem: p });
  process.exit(2);
}

// Readiness = the gateway is actually connected. Liveness deliberately does
// NOT check this: a Discord outage should drain traffic, not restart pods.
let gatewayReady = false;
let draining = false;

const health = startHealthServer({
  host: config.healthHost,
  port: config.healthPort,
  build: config.build,
  isReady: () => gatewayReady && !draining,
});

const commands = buildCommands({ voiceEnabled: config.voiceEnabled });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel], // required to receive DMs
});

client.once('clientReady', async () => {
  gatewayReady = true;
  log.info('ready', {
    bot: client.user.tag,
    endpoint: config.baseUrl,
    model: config.model,
    voice: config.voiceEnabled ? 'enabled' : 'disabled',
    // Named as the reason rather than the value when off: `s2s: null` reads as
    // a missing setting, which is the wrong thing to go looking for.
    s2s: config.voiceEnabled ? config.s2sUrl : 'not used (VOICE_ENABLED=false)',
    allowed: config.allowedUserIds.length,
    version: config.build.version,
    chatBridge: Boolean(config.chatBridgeToken),
  });

  // A previous process may have died while in a voice channel, leaving the bot
  // visible there with nothing driving it. Clear that before anything else.
  for (const guild of client.guilds.cache.values()) {
    const ghost = await voice.evictGhost(guild).catch(() => null);
    if (ghost) log.warn('evicted leftover voice connection', { guild: guild.name, channel: ghost });
  }

  // Guild-scoped registration applies immediately; global takes ~an hour.
  const rest = new REST().setToken(config.discordToken);
  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
      log.info('commands registered', { guild: guild.name });
    } catch (e) {
      log.error('command registration failed', { guild: guild.name, error: e.message });
    }
  }
});

// Gateway drops mean "stop sending me traffic", not "restart me".
client.on('shardDisconnect', () => {
  gatewayReady = false;
});
client.on('shardResume', () => {
  gatewayReady = true;
});
client.on('shardReady', () => {
  gatewayReady = true;
});

// Arrivals and departures go into the transcript, and display names are
// refreshed as people arrive — they are otherwise resolved only at join time.
client.on('voiceStateUpdate', (oldState, newState) => {
  try {
    voice.noteVoiceState(oldState, newState);
  } catch (e) {
    log.warn('voice state note failed', { error: e.message });
  }
});

client.on('interactionCreate', async (i) => {
  // Logged before any filtering: when a slash command hangs on "Sending
  // command…", the only question that matters is whether it reached this
  // process at all. Silence here means Discord never delivered it, and no
  // amount of reading the handler will show that.
  log.info('interaction received', {
    type: i.type,
    command: i.commandName ?? null,
    user: i.user?.tag ?? null,
  });
  if (!i.isChatInputCommand()) return;

  if (!config.isAllowed(i.user.id)) {
    log.warn('slash command dropped', { command: i.commandName, user: i.user.tag, id: i.user.id });
    return i.reply({ content: 'Not authorised.', flags: MessageFlags.Ephemeral });
  }

  if (i.commandName === 'status') {
    // Deferred: the checks open sockets to the shim and to speech-to-speech,
    // which can exceed the 3s interaction deadline when one of them is exactly
    // the thing that is broken.
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const { report } = require('./status');
    return i.editReply(await report(client, sessionKeyFor(i.channel, i.user.id)));
  }

  // Belt and braces: with voice disabled these are not registered, but Discord
  // keeps a guild's previous command list until the new one is PUT, so an
  // instance restarted into text-only can still receive them for a moment.
  if ((i.commandName === 'join' || i.commandName === 'leave') && !config.voiceEnabled) {
    return i.reply({ content: VOICE_DISABLED_REPLY, flags: MessageFlags.Ephemeral });
  }

  if (i.commandName === 'join') {
    const channel = i.member?.voice?.channel;
    if (!channel) {
      return i.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
    }
    await i.reply({ content: `Joining ${channel.name}…`, flags: MessageFlags.Ephemeral });
    try {
      const session = await voice.join(channel);
      await i.followUp({ content: `Listening in ${channel.name}.`, flags: MessageFlags.Ephemeral });
      // Say it out loud in the channel: recording should never be silent, even
      // on a server where everyone present already knows.
      if (session?.transcript && config.announceTranscription) {
        await i.channel
          ?.send(`🎙️ Transcribing **${channel.name}** — every speaker is written down.`)
          .catch(() => {});
      }
    } catch (e) {
      log.error('voice join failed', { error: e.message });
      await i.followUp({
        content: `Could not join: ${e.message}. A connection stuck in "signalling" is usually permissions.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  if (i.commandName === 'new' || i.commandName === 'sessions' || i.commandName === 'switch') {
    // Deferred: each of these calls the endpoint, which can outlast the 3s
    // interaction deadline precisely when the endpoint is the thing misbehaving.
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const key = sessionKeyFor(i.channel, i.user.id);
    const { newSession, sessionsList, switchSession } = require('./commands');
    if (i.commandName === 'new') return i.editReply(await newSession(key));
    if (i.commandName === 'sessions') return i.editReply(await sessionsList(key));
    return i.editReply(await switchSession(key, i.options.getString('id')));
  }

  if (i.commandName === 'leave') {
    const left = voice.leave(i.guildId);
    await i.reply({
      content: left ? 'Left.' : 'Not in a voice channel.',
      flags: MessageFlags.Ephemeral,
    });
  }
});

text.register(client);

function shutdown(signal) {
  if (draining) return;
  draining = true; // fail readiness first, so k8s stops routing to us
  log.info('shutting down', { signal });

  const timer = setTimeout(() => {
    log.error('graceful shutdown timed out, forcing exit', {
      timeoutMs: config.shutdownTimeoutMs,
    });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  timer.unref();

  // Leave voice BEFORE tearing down the gateway, and give the voice-state
  // update a moment to actually reach Discord. Destroying the client straight
  // away cuts the connection first, leaving the bot as a ghost participant
  // that a later process then has to evict.
  for (const id of [...voice.sessions.keys()]) voice.leave(id);
  for (const guild of client.guilds.cache.values()) {
    voice.evictGhost(guild).catch(() => {});
  }
  setTimeout(() => {
    client.destroy();
    health.close(() => {
      clearTimeout(timer);
      log.info('shutdown complete');
      process.exit(0);
    });
  }, 600).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));

process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { error: String(reason) });
  process.exit(1);
});
// A single bad voice packet must not take the bot down. Discord's decryption
// layer throws asynchronously, from a UDP callback with no listener to catch it,
// so it surfaces here rather than anywhere it could be handled locally. Observed
// mid-conversation: "Failed to decrypt: DecryptionFailed(
// UnencryptedWhenPassthroughDisabled)" killed the process and the call simply
// stopped, with the last thing in the log being a normal transcript line.
//
// Deliberately narrow. Exiting on an unknown exception is right — the process
// state is unknowable — so only this known-recoverable class is survived, and it
// is still logged every time.
const RECOVERABLE = /Failed to decrypt|DecryptionFailed|Unencrypted/i;

// Transient network faults, survivable ONLY once the gateway has connected at
// least once. Observed 2026-08-05: the laptop slept, and "Opening handshake has
// timed out" arrived from inside `ws` with no listener to catch it, killing a
// bot that had been running fine for eight hours. `make run` exited and nothing
// brought it back, so the first anyone knew was `/join` doing nothing.
//
// The `connectedOnce` condition is the whole point. After login, discord.js
// reconnects on its own and swallowing the throw lets it. BEFORE login there is
// nothing to reconnect — surviving would leave a process that is alive, passing
// liveness, and permanently disconnected, which is strictly worse than exiting,
// because a crash is at least visible.
const RECOVERABLE_NET =
  /Opening handshake has timed out|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|WebSocket was closed/i;

let connectedOnce = false;
client.once('clientReady', () => {
  connectedOnce = true;
});

process.on('uncaughtException', (err) => {
  if (RECOVERABLE.test(err?.message ?? '')) {
    log.warn('dropped an undecryptable voice packet', { error: err.message });
    return;
  }
  if (connectedOnce && RECOVERABLE_NET.test(err?.message ?? '')) {
    // Readiness already reports the disconnect, so traffic drains while
    // discord.js retries. Logged at error level: it is not routine.
    log.error('survived a gateway network fault, waiting for reconnect', { error: err.message });
    gatewayReady = false;
    return;
  }
  log.error('uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

client.login(config.discordToken);
