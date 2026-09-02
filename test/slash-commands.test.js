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

// Every command that exists only because this instance can hear. Kept as one
// list so adding a voice command means updating this in exactly one place —
// `wake` was added here after it shipped as the third member and the old
// hard-coded `join`/`leave` filter turned it into a text-surface regression.
const VOICE_ONLY = ['join', 'leave', 'wake'];

test('voice enabled advertises the voice commands', () => {
  const n = names({ voiceEnabled: true });
  for (const c of VOICE_ONLY) {
    assert.ok(n.includes(c), `${c} should be registered`);
  }
});

test('voice disabled advertises none of the voice commands', () => {
  const n = names({ voiceEnabled: false });
  for (const c of VOICE_ONLY) {
    assert.equal(n.includes(c), false, `${c} must not be advertised without voice`);
  }
});

test('disabling voice removes only the voice commands', () => {
  const enabled = names({ voiceEnabled: true });
  const disabled = names({ voiceEnabled: false });
  assert.deepEqual(
    enabled.filter((n) => !VOICE_ONLY.includes(n)),
    disabled,
    'the text surface must be identical in both modes',
  );
  // Named explicitly so removing one of these from the array is a test failure
  // rather than a silently smaller command list — the failure mode that left
  // `new` and `sessions` unreachable for weeks.
  for (const n of ['status', 'new', 'sessions', 'switch']) {
    assert.ok(disabled.includes(n), `${n} must survive with voice disabled`);
  }
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
