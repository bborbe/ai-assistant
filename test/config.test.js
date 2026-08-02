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
