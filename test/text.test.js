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

function fakeMsg({ content, liveGuildId = 'guild-1', channelId = 'chan-1' } = {}) {
  const sent = [];
  let typingCalls = 0;
  return {
    author: { bot: false, id: 'user-1', tag: 'user-1#0' },
    member: { displayName: 'User One' },
    guild: { id: liveGuildId },
    content,
    mentions: { users: { has: (id) => id === 'bot-1' } },
    channel: {
      id: channelId,
      // No `threads` property: conversationChannel() falls back to the
      // channel itself rather than opening a thread — keeps the fake
      // minimal for a channel that is a live call's own text chat.
      send: async (part) => sent.push(part),
      // Only the text path calls this — reaching it IS the assertion that
      // routing did not divert the message into a spoken reply.
      sendTyping: async () => {
        typingCalls += 1;
      },
    },
    _sent: sent,
    _typingCalls: () => typingCalls,
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

// The regression guard for everything this PR did NOT mean to change.
//
// The routing branch sits inside the messageCreate handler that EVERY text
// surface flows through — DMs, threads, ordinary guild channels. The two
// tests below it only exercise the live-call path, so a liveSessionFor that
// matched too broadly would turn ordinary text answering into silence and
// nothing would fail. Reaching sendTyping is the observable proof the message
// went down the text path instead.
//
// The endpoint is pointed at a closed port on purpose: this asserts the
// ROUTING decision, and must not depend on (or accidentally talk to) a shim
// that happens to be running on the developer's laptop.
test('a typed turn with no live call in that channel still answers in text', async () => {
  const client = fakeClient();
  text.register(client);
  // A live session exists — for a DIFFERENT channel. This is the case that
  // would break if the guild lookup ignored channelId.
  const live = fakeLiveSession({ speakResult: { ok: true } });
  voice.sessions.set('guild-1', live);

  const baseUrl = config.baseUrl;
  config.baseUrl = 'http://127.0.0.1:1/v1';
  try {
    const msg = fakeMsg({ content: '<@bot-1> tell me a joke', channelId: 'other-chan' });
    await client.fire(msg);

    assert.deepEqual(live._spoken, [], 'a channel with no live call must never be spoken to');
    assert.equal(msg._typingCalls(), 1, 'the text path must still run');
  } finally {
    config.baseUrl = baseUrl;
  }
});

test('the typing indicator starts immediately and stops when the response ends', async () => {
  let typingCalls = 0;
  const target = {
    sendTyping: async () => {
      typingCalls += 1;
    },
  };
  const session = { inResponse: true, closed: false };

  const timer = text.showTypingWhileAnswering(target, session);
  // The FIRST one is not on the interval — a typed turn answered in under
  // eight seconds would otherwise show no indicator at all, which is exactly
  // the gap this closes.
  await new Promise((r) => setImmediate(r));
  assert.equal(typingCalls, 1, 'shown before the first tick, not after it');

  // The response finishing is what stops it; nothing else has to remember to.
  session.inResponse = false;
  clearInterval(timer);
  assert.equal(typingCalls, 1);
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
