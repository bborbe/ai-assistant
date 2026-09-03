'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildCommands } = require('../src/slash-commands');

// "Which commands exist" is exactly the kind of decision that regresses in
// silence: nothing throws, nothing logs, the guild's list is simply wrong and
// nobody notices until someone types a command that should not have been
// offered. Both directions are asserted, because the default mattering is the
// whole reason the flag defaults to true.

const names = (opts) => buildCommands(opts).map((c) => c.name);

test('voice enabled advertises join and leave', () => {
  const n = names({ voiceEnabled: true });
  assert.ok(n.includes('join'), 'join should be registered');
  assert.ok(n.includes('leave'), 'leave should be registered');
});

test('voice disabled advertises neither join nor leave', () => {
  const n = names({ voiceEnabled: false });
  assert.equal(n.includes('join'), false, 'join must not be advertised without voice');
  assert.equal(n.includes('leave'), false, 'leave must not be advertised without voice');
});

test('disabling voice removes only the voice commands', () => {
  const enabled = names({ voiceEnabled: true });
  const disabled = names({ voiceEnabled: false });
  assert.deepEqual(
    enabled.filter((n) => n !== 'join' && n !== 'leave'),
    disabled,
    'the text surface must be identical in both modes',
  );
  // Named explicitly so removing one of these from the array is a test failure
  // rather than a silently smaller command list — the failure mode that left
  // `new` and `sessions` unreachable for weeks.
  for (const n of ['status', 'new', 'sessions', 'switch', 'mode']) {
    assert.ok(disabled.includes(n), `${n} must survive with voice disabled`);
  }
});

test('/mode advertises both voice-only and voice-text choices', () => {
  // The two names the user can type are the contract: `voice-only` silences
  // chat posting for the conversation, `voice-text` turns it back on. A
  // choice that silently drops from the list is exactly the class of
  // regression the other tests here exist to catch.
  const mode = buildCommands({ voiceEnabled: true }).find((c) => c.name === 'mode');
  assert.ok(mode, '/mode must be registered');
  const choices = mode.options[0].choices.map((c) => c.value);
  assert.deepEqual(choices.sort(), ['voice-only', 'voice-text']);
});

// Discord hides a command from anyone lacking this permission. Asserted on
// EVERY command rather than a sampled one: the whole slash surface is session
// and voice control, and a single command shipped without the field is
// silently visible to every member of the guild.
test('every command carries the admin permission gate', () => {
  const { ADMIN_PERMISSION } = require('../src/slash-commands');
  for (const voiceEnabled of [true, false]) {
    for (const c of buildCommands({ voiceEnabled })) {
      assert.equal(
        c.default_member_permissions,
        String(ADMIN_PERMISSION),
        `${c.name} must be permission-gated (voiceEnabled=${voiceEnabled})`,
      );
    }
  }
});

// ManageGuild, not ManageMessages: moderators commonly hold the latter, and
// every command here reaches a Claude Code session with vault and repo access.
test('the gate is ManageGuild', () => {
  const { PermissionFlagsBits } = require('discord.js');
  const { ADMIN_PERMISSION } = require('../src/slash-commands');
  assert.equal(ADMIN_PERMISSION, PermissionFlagsBits.ManageGuild);
});
