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
  for (const n of ['status', 'new', 'sessions', 'switch']) {
    assert.ok(disabled.includes(n), `${n} must survive with voice disabled`);
  }
});
