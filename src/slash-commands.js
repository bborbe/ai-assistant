'use strict';

const { SlashCommandBuilder } = require('discord.js');

/**
 * The slash commands this instance advertises.
 *
 * Its own module because "which commands exist" is a decision worth testing,
 * and index.js logs in at require time so a test cannot reach anything defined
 * there.
 *
 * `voiceEnabled: false` omits `join` and `leave` entirely rather than
 * registering them to refuse. A command in the guild's list is a promise the
 * instance can do the thing; a text-only deployment has no speech-to-speech to
 * reach, so the honest surface is for them not to appear at all. The TYPED
 * forms still answer with a reason (see text.js) — that path costs nothing and
 * tells someone who tries anyway why it did not work.
 */
/**
 * What a voice request gets answered with on a text-only instance.
 *
 * Shared by the slash-command guard and the typed-command path so the two
 * cannot drift into explaining the same state two different ways.
 */
const VOICE_DISABLED_REPLY =
  'Voice is disabled on this instance — it runs text-only, so there is no voice channel to join.';

function buildCommands({ voiceEnabled }) {
  const commands = [];

  if (voiceEnabled) {
    commands.push(
      new SlashCommandBuilder()
        .setName('join')
        .setDescription('Join the voice channel you are in and start listening'),
      new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Stop listening and leave the voice channel'),
    );
  }

  commands.push(
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Health of the bot, endpoint, speech-to-speech and transcripts'),
    // These two had working handlers for weeks and were unreachable: a
    // handler is not a command until it is in this array.
    new SlashCommandBuilder()
      .setName('new')
      .setDescription('Start a fresh Claude Code session for this conversation'),
    new SlashCommandBuilder()
      .setName('sessions')
      .setDescription('List Claude Code sessions, and transcripts you can switch to'),
    new SlashCommandBuilder()
      .setName('switch')
      .setDescription('Point this conversation at an existing Claude Code session')
      .addStringOption((o) =>
        o.setName('id').setDescription('Session id from /sessions').setRequired(true),
      ),
  );

  return commands.map((c) => c.toJSON());
}

module.exports = { buildCommands, VOICE_DISABLED_REPLY };
