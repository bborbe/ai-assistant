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
    // Voice commands reply via msg.reply (the slash-command surface), not
    // channel.send — the routing tests above answer in-channel, so this is
    // only reachable from a join/leave command. Tests that want a failure can
    // override it after construction.
    reply: async (part) => sent.push(part),
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

// A Collection-like stand-in for the bot's own role cache: `has` and `keys` are
// the whole surface stripAddress and the mention check depend on.
function fakeRoleCache(ids) {
  return { has: (id) => ids.includes(id), keys: () => ids[Symbol.iterator]() };
}

test('stripAddress removes the user mention in both spellings', () => {
  assert.equal(text.stripAddress('<@42> hello', '42', fakeRoleCache([])).trim(), 'hello');
  // The nickname form. Easy to miss, and a miss leaves the raw id in the prompt.
  assert.equal(text.stripAddress('<@!42> hello', '42', fakeRoleCache([])).trim(), 'hello');
});

test('stripAddress removes a mention of the bot own role', () => {
  // Discord offers the bot user and the bot's managed role as two identical
  // autocomplete entries; picking the role produces this form.
  assert.equal(
    text.stripAddress('<@&99> plan my month', '42', fakeRoleCache(['99'])).trim(),
    'plan my month',
  );
});

test('stripAddress leaves other roles alone — they are content', () => {
  const out = text.stripAddress('<@&77> and <@&99> ship it', '42', fakeRoleCache(['99']));
  assert.match(out, /<@&77>/, "another group's mention is part of what the user wrote");
  assert.doesNotMatch(out, /<@&99>/);
});

test('stripAddress is a no-op on a message that addresses nobody', () => {
  assert.equal(text.stripAddress('just talking', '42', fakeRoleCache(['99'])), 'just talking');
});

test('stripAddress tolerates a missing role cache', () => {
  // DMs have no guild, so there is no member and no role cache to read.
  assert.equal(text.stripAddress('<@42> hi', '42', undefined).trim(), 'hi');
  assert.equal(text.stripAddress('<@42> hi', '42', null).trim(), 'hi');
});

test('stripAddress leaves the @everyone role alone', () => {
  // @everyone IS a role the bot holds, and its id is the guild id. Stripping it
  // would silently eat an @everyone the user wrote on purpose; matching on it
  // would make every server-wide ping an address to the assistant.
  const guildId = 'guild-1';
  const out = text.stripAddress(
    `<@&${guildId}> heads up everyone`,
    '42',
    fakeRoleCache([guildId, '99']),
    guildId,
  );
  assert.match(out, new RegExp(`<@&${guildId}>`));
});

// Crash-loop regression: a `/join` reply that Discord rejects (160002 — bot
// lacks "Read Message History" in the guild) must not take the process down.
// Observed 2026-09-04 on the SC bot: the join reply throws, the catch's own
// reply throws again, the rejection escapes the async messageCreate handler
// and index.js's unhandledRejection handler exits(1) — launchd restarts, the
// startup evictGhost disconnects the voice connection, and the next /leave
// finds no session. The fix: a reply failure inside handleVoiceCommand is
// logged, never allowed to propagate.
test('a /leave reply failure is swallowed, not a crash', async () => {
  const client = fakeClient();
  text.register(client);
  const msg = fakeMsg({ content: '/leave' });
  // 160002: Cannot reply without permission to read message history
  msg.reply = async () => {
    throw new Error('Cannot reply without permission to read message history');
  };
  // No session, so voice.leave returns false and the reply path runs. The
  // rejection must not escape handleVoiceCommand.
  await client.fire(msg);
  // If the exception had escaped, client.fire would have rejected above.
  assert.ok(true);
});

test('a /join reply failure inside the catch is swallowed, not a crash', async () => {
  const client = fakeClient();
  text.register(client);
  const msg = fakeMsg({ content: '/join' });
  msg.member.voice = {
    channel: { id: 'chan-1', name: 'voice', guild: { id: 'guild-1' } },
  };
  msg.reply = async () => {
    throw new Error('Cannot reply without permission to read message history');
  };
  // voice.join will fail against the fake channel (no adapter), landing in the
  // catch — whose reply also rejects. Both must be contained.
  await client.fire(msg);
  assert.ok(true);
});
