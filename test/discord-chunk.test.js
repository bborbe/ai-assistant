'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { chunk, DISCORD_LIMIT } = require('../src/discord-chunk');

test('short text is a single chunk', () => {
  assert.deepEqual(chunk('hello'), ['hello']);
});

test('empty text produces no chunks', () => {
  assert.deepEqual(chunk(''), []);
});

test('long text is split under the Discord limit, preferring a line break', () => {
  const text = 'a'.repeat(1000) + '\n' + 'b'.repeat(1500);
  const parts = chunk(text);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= DISCORD_LIMIT);
  assert.equal(parts.join('\n'), text);
});

test('text with no natural break point is hard-cut at the limit', () => {
  const text = 'x'.repeat(DISCORD_LIMIT * 2 + 10);
  const parts = chunk(text);
  assert.ok(parts.length >= 2);
  for (const part of parts) assert.ok(part.length <= DISCORD_LIMIT);
  assert.equal(parts.join(''), text);
});
