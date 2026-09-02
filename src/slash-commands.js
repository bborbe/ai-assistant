'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

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

/**
 * The permission a member needs before Discord will SHOW them these commands.
 *
 * ManageGuild rather than ManageMessages: moderators routinely hold the latter,
 * and every command here drives a Claude Code session with vault and repository
 * access — a moderator is not an operator. Guild owners bypass permission checks
 * entirely, so the owner always sees them without holding anything explicitly.
 *
 * Note what this is NOT: Discord's gate is permission-based, so it cannot
 * express "these user ids". A member holding ManageGuild sees the commands
 * whether or not they are in ADMIN_USER_IDS — which is why index.js still
 * checks config.isAdmin before acting. Hiding is a UX affordance; the id check
 * is the actual authorisation.
 */
const ADMIN_PERMISSION = PermissionFlagsBits.ManageGuild;

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
      // Voice-only for the same reason join/leave are: the wake phrase gates
      // voice turns and nothing else, so on a text-only instance the command
      // would advertise control over a gate that never runs.
      //
      // The option is NOT required — invoking it bare is the query form, which
      // is the first thing you want mid-call ("is the gate on right now?").
      new SlashCommandBuilder()
        .setName('wake')
        .setDescription('Show or change whether the wake phrase is required in this call')
        .addStringOption((o) =>
          o
            .setName('mode')
            .setDescription(
              'on = always require it, off = allow solo auto-answer, auto = use the default',
            )
            .addChoices(
              { name: 'on', value: 'on' },
              { name: 'off', value: 'off' },
              { name: 'auto', value: 'auto' },
            ),
        ),
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

  // Applied to every command, not a subset: the whole slash surface is session
  // and voice control, and there is no command here an ordinary user should
  // reach. The mention surface is what they get, and it is not built here.
  return commands.map((c) => c.setDefaultMemberPermissions(ADMIN_PERMISSION).toJSON());
}

module.exports = { buildCommands, VOICE_DISABLED_REPLY, ADMIN_PERMISSION };
