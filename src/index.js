#!/usr/bin/env node
'use strict';

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
} = require('discord.js');
const config = require('./config');
const voice = require('./voice');
const text = require('./text');
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

const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join the voice channel you are in and start listening'),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Stop listening and leave the voice channel'),
].map((c) => c.toJSON());

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
    s2s: config.s2sUrl,
    allowed: config.allowedUserIds.length,
    version: config.build.version,
  });

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

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  if (!config.isAllowed(i.user.id)) {
    log.warn('slash command dropped', { command: i.commandName, user: i.user.tag, id: i.user.id });
    return i.reply({ content: 'Not authorised.', flags: MessageFlags.Ephemeral });
  }

  if (i.commandName === 'join') {
    const channel = i.member?.voice?.channel;
    if (!channel) {
      return i.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
    }
    await i.reply({ content: `Joining ${channel.name}…`, flags: MessageFlags.Ephemeral });
    try {
      await voice.join(channel);
      await i.followUp({ content: `Listening in ${channel.name}.`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      log.error('voice join failed', { error: e.message });
      await i.followUp({
        content: `Could not join: ${e.message}. A connection stuck in "signalling" is usually permissions.`,
        flags: MessageFlags.Ephemeral,
      });
    }
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

  // Leaving voice channels first is a courtesy: otherwise the bot lingers as a
  // ghost participant until Discord times the connection out.
  for (const id of [...voice.sessions.keys()]) voice.leave(id);
  client.destroy();
  health.close(() => {
    clearTimeout(timer);
    log.info('shutdown complete');
    process.exit(0);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));

process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { error: String(reason) });
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

client.login(config.discordToken);
