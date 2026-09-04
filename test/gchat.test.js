'use strict';

const test = require('node:test');
const assert = require('node:assert');

// The session-key tests assume a single identity; set it before config is
// first required (mirrors llm.test.js, which deletes it — same reason, the
// module-level require captures config.identity at load).
process.env.IDENTITY = 'data';
delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/gchat')];
const { parseEvent, gchatSessionKey, classify } = require('../src/gchat');

const CHAT_EVENT = {
  commonEventObject: { hostApp: 'CHAT', platform: 'WEB' },
  chat: {
    user: { name: 'users/1', displayName: 'Alice', email: 'alice@example.com', type: 'HUMAN' },
    eventTime: '2026-09-04T08:51:28.326367Z',
    messagePayload: {
      space: { name: 'spaces/AAA', type: 'DM' },
      message: {
        name: 'spaces/AAA/messages/1',
        argumentText: 'ping',
        thread: { name: 'spaces/AAA/threads/BBB' },
      },
    },
  },
};

test('parseEvent extracts Chat message fields', () => {
  const event = parseEvent(Buffer.from(JSON.stringify(CHAT_EVENT)));
  assert.deepEqual(event, {
    spaceName: 'spaces/AAA',
    threadName: 'spaces/AAA/threads/BBB',
    senderEmail: 'alice@example.com',
    argumentText: 'ping',
  });
});

test('parseEvent skips non-CHAT host', () => {
  const payload = { ...CHAT_EVENT, commonEventObject: { hostApp: 'GMAIL' } };
  assert.equal(parseEvent(Buffer.from(JSON.stringify(payload))), null);
});

test('parseEvent skips events without messagePayload', () => {
  const payload = { commonEventObject: { hostApp: 'CHAT' }, chat: {} };
  assert.equal(parseEvent(Buffer.from(JSON.stringify(payload))), null);
});

test('parseEvent returns null on invalid JSON', () => {
  assert.equal(parseEvent(Buffer.from('not json')), null);
});

test('gchatSessionKey uses trailing ids, identity last', () => {
  assert.equal(gchatSessionKey('spaces/AAA', 'spaces/AAA/threads/BBB'), 'gchat:AAA_BBB:data');
});

test('gchatSessionKey degrades to _space without a thread', () => {
  assert.equal(gchatSessionKey('spaces/AAA', null), 'gchat:AAA_space:data');
});

test('gchatSessionKey has exactly three colon segments, gchat prefix', () => {
  const key = gchatSessionKey('spaces/AAA', 'spaces/AAA/threads/BBB');
  assert.equal(key.split(':').length, 3);
  assert.equal(key.split(':')[0], 'gchat');
  assert.equal(key.split(':')[2], 'data');
});

test('classify: non-empty is shape, empty is ask-requester', () => {
  assert.equal(classify('how do I deploy kafka'), 'shape');
  assert.equal(classify(''), 'ask-requester');
  assert.equal(classify('   '), 'ask-requester');
});
