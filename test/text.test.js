'use strict';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const voice = require('../src/voice');
const text = require('../src/text');

// The routing branch added for "typed messages cannot be answered aloud"
// lives inside register()'s messageCreate handler — there is no standalone
// function to call directly, so this drives the handler itself with fake
// Discord.js collaborators, the same way voice.test.js fakes a Session
// rather than opening a real socket. Only the shape register() actually
// touches is provided; anything unused (guilds, mentions beyond `has`) is
// left absent on purpose so a change that starts depending on more of the
// Discord.js API fails loudly here instead of silently working by accident.

function fakeClient() {
  let handler;
  return {
    user: { id: 'bot-1' },
    on: (event, cb) => {
      if (event === 'messageCreate') handler = cb;
    },
    fire: (msg) => handler(msg),
  };
}

function fakeMsg({ content, liveGuildId = 'guild-1' } = {}) {
  const sent = [];
  return {
    author: { bot: false, id: 'user-1', tag: 'user-1#0' },
    member: { displayName: 'User One' },
    guild: { id: liveGuildId },
    content,
    mentions: { users: { has: (id) => id === 'bot-1' } },
    channel: {
      id: 'chan-1',
      // No `threads` property: conversationChannel() falls back to the
      // channel itself rather than opening a thread — keeps the fake
      // minimal for a channel that is a live call's own text chat.
      send: async (part) => sent.push(part),
    },
    _sent: sent,
  };
}

function fakeLiveSession({ speakResult }) {
  const transcriptWrites = [];
  const spoken = [];
  return {
    closed: false,
    channelId: 'chan-1',
    transcript: { writeText: (speaker, t) => transcriptWrites.push({ speaker, t }) },
    speak: async (t) => {
      spoken.push(t);
      return speakResult;
    },
    _transcriptWrites: transcriptWrites,
    _spoken: spoken,
  };
}

test.beforeEach(() => {
  voice.sessions.clear();
  config.allowedUserIds = ['user-1'];
});

test('a typed turn in a live call channel is routed to speak() and never answered in text', async () => {
  const client = fakeClient();
  text.register(client);
  const live = fakeLiveSession({ speakResult: { ok: true } });
  voice.sessions.set('guild-1', live);

  const msg = fakeMsg({ content: '<@bot-1> tell me a joke' });
  await client.fire(msg);

  assert.deepEqual(live._spoken, ['tell me a joke']);
  assert.equal(msg._sent.length, 0, 'a spoken reply must not also get a text reply');
});

test('a refused speak() is reported in the channel and recorded in the transcript, never falls back to a second text answer', async () => {
  const client = fakeClient();
  text.register(client);
  const live = fakeLiveSession({ speakResult: { ok: false, reason: 'busy' } });
  voice.sessions.set('guild-1', live);

  const msg = fakeMsg({ content: '<@bot-1> tell me a joke' });
  await client.fire(msg);

  // The pre-existing chat-bridge capture (text.js's own top-of-handler
  // block) already writes every typed line to the same session's
  // transcript before routing is even decided — this asserts the NEW
  // failure-reason write lands alongside it, not that it is the only entry.
  assert.deepEqual(live._transcriptWrites.at(-1), {
    speaker: config.botName,
    t: '(voice reply failed: busy)',
  });
  assert.equal(msg._sent.length, 1);
  assert.match(msg._sent[0], /busy/);
});
