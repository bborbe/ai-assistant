'use strict';

const test = require('node:test');
const assert = require('node:assert');

test('allowlist fails closed when unset', () => {
  delete process.env.ALLOWED_USER_IDS;
  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');
  assert.equal(config.isAllowed('123'), false, 'nobody is allowed by default');
  assert.ok(config.check().some((p) => /ALLOWED_USER_IDS/.test(p)));
});

test('allowlist accepts only listed senders', () => {
  process.env.ALLOWED_USER_IDS = ' 111, 222 ';
  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');
  assert.ok(config.isAllowed('111'));
  assert.ok(config.isAllowed('222'));
  assert.equal(config.isAllowed('333'), false);
});

// Voice defaults ON: an existing deployment upgrading onto this must behave
// identically with nothing set. Failing the other way would silently take
// voice away from the laptop instance on a routine release.
test('voice is enabled when VOICE_ENABLED is unset', () => {
  delete process.env.VOICE_ENABLED;
  delete require.cache[require.resolve('../src/config')];
  assert.equal(require('../src/config').voiceEnabled, true);
});

test('voice can be disabled by any of the usual falsey spellings', () => {
  for (const raw of ['0', 'false', 'no', 'off', 'FALSE', '"0"']) {
    process.env.VOICE_ENABLED = raw;
    delete require.cache[require.resolve('../src/config')];
    assert.equal(require('../src/config').voiceEnabled, false, `VOICE_ENABLED=${raw}`);
  }
  delete process.env.VOICE_ENABLED;
});
