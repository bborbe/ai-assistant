'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { sessionKeyFor, DEFAULT_SESSION_KEY } = require('../src/llm');

const channel = (over) => ({ isThread: () => false, isVoiceBased: () => false, ...over });

test('a voice channel shares the spoken conversation, per guild', () => {
  // The one case with teeth: a voice channel's integrated text chat is an
  // ordinary text channel to Discord, so without this it gets its own session
  // and a link pasted mid-call never reaches the conversation being spoken.
  // It is also what lets `switch` / `new` reach voice at all.
  //
  // The guild id is load-bearing and this fixture used to omit it (`guild: {}`),
  // so the assertion held while the behaviour changed underneath it: the key
  // fell back to the default exactly because there was no id to key on.
  const key = sessionKeyFor(
    channel({ id: 'V1', guild: { id: 'G1' }, isVoiceBased: () => true }),
    'U9',
  );
  assert.equal(key, 'voice:G1');
});

test('two servers do not share one spoken conversation', () => {
  // The regression that motivated per-guild keys: joining a call at work
  // resumed the personal conversation, because ALL voice landed on one key.
  // speech-to-speech cannot send a session header, so nothing else separates
  // them.
  const inGuild = (id) =>
    sessionKeyFor(channel({ id: `V-${id}`, guild: { id }, isVoiceBased: () => true }), 'U9');
  assert.notEqual(inGuild('G1'), inGuild('G2'));
});

test('a voice channel with no resolvable guild still yields a usable key', () => {
  const key = sessionKeyFor(channel({ id: 'V1', guild: {}, isVoiceBased: () => true }), 'U9');
  assert.equal(key, DEFAULT_SESSION_KEY);
});

test('IDENTITY unset reproduces the v0.16.0 key exactly', () => {
  // No behaviour change for an existing single-identity deployment.
  delete process.env.IDENTITY;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
  const { voiceKeyFor } = require('../src/llm');
  assert.equal(voiceKeyFor('G1'), 'voice:G1');
});

test('IDENTITY set adds a third segment to the voice key', () => {
  // THE AXIS FIX: persona (identity) and session (guild) are different
  // things, so the key has to carry both once an identity is set.
  process.env.IDENTITY = 'sc';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
  const { voiceKeyFor } = require('../src/llm');
  assert.equal(voiceKeyFor('G1'), 'voice:G1:sc');
  delete process.env.IDENTITY;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
});

test('one identity across two guilds still separates sessions, sharing persona', () => {
  process.env.IDENTITY = 'sc';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
  const { voiceKeyFor } = require('../src/llm');
  const inG1 = voiceKeyFor('G1');
  const inG2 = voiceKeyFor('G2');
  assert.notEqual(inG1, inG2, 'sessions must stay separate per guild');
  assert.ok(
    inG1.endsWith(':sc') && inG2.endsWith(':sc'),
    'persona must be the same identity in both',
  );
  delete process.env.IDENTITY;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
});

test('two identities in the same guild produce different session keys', () => {
  // THE LEAK THIS FIX EXISTS TO PREVENT: without the identity segment, two
  // bots serving the same guild would collide on one `voice:<guildId>` key.
  process.env.IDENTITY = 'personal';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
  const asPersonal = require('../src/llm').voiceKeyFor('G1');

  process.env.IDENTITY = 'sc';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
  const asSc = require('../src/llm').voiceKeyFor('G1');

  assert.notEqual(asPersonal, asSc);
  delete process.env.IDENTITY;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
});

test('threads, channels and DMs each get their own conversation', () => {
  assert.equal(
    sessionKeyFor(channel({ id: 'H1', guild: {}, isThread: () => true }), 'U9'),
    'thread:H1',
  );
  assert.equal(sessionKeyFor(channel({ id: 'T1', guild: {} }), 'U9'), 'channel:T1');
  assert.equal(sessionKeyFor(channel({ id: 'D1' }), 'U9'), 'dm:U9');
});

test('switch rejects free text without calling the endpoint', async () => {
  // A slash-command option accepts anything, so `/switch speech to speech`
  // reached the shim and came back as a filesystem path. The shape check has to
  // sit in front, and must not need a reachable endpoint to say so.
  const { switchSession } = require('../src/commands');
  const reply = await switchSession('k', 'speech to speech');
  assert.match(reply, /not a session id/);
});

test('a channel object missing the type helpers still yields a key', () => {
  // Partial channels are real: a DM arrives uncached, and an older discord.js
  // object may lack isVoiceBased. Optional calls must not throw.
  assert.equal(sessionKeyFor({ id: 'X1', guild: {} }, 'U9'), 'channel:X1');
  assert.equal(sessionKeyFor(undefined, 'U9'), 'dm:U9');
});

test('two transcript lines written in the same millisecond both survive', () => {
  // The name was `${Date.now()}-<speaker>-000000`, so two writes inside one
  // millisecond collided and the second overwrote the first — a line lost with
  // nothing logged. It is not a rare race: a holding line and the first
  // sentence of the answer arrive together.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { TranscriptSession } = require('../src/transcript');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
  const session = Object.create(TranscriptSession.prototype);
  session.segments = dir;

  session.writeText('Assistant', 'holding line');
  session.writeText('Assistant', 'the actual answer');

  const files = fs.readdirSync(dir).sort();
  assert.equal(files.length, 2, 'both writes must produce their own segment');
  assert.deepEqual(
    files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')),
    ['holding line', 'the actual answer'],
    'and stay in insertion order',
  );
  // The transcriber only picks up names matching this shape.
  for (const f of files) assert.match(f, /^\d+-.+-\d+\.txt$/);
});

test('bindVoiceKey distinguishes unsupported from broken', async () => {
  // The bot may not depend on which backend sits behind OPENAI_BASE_URL, so a
  // stateless endpoint with no /voice/bind must degrade to one shared voice
  // conversation — NOT warn, and never block the join. A real error has to stay
  // distinguishable from that, because it means spoken turns are reaching a
  // conversation the speaker did not choose.
  const { bindVoiceKey } = require('../src/llm');
  const realFetch = global.fetch;

  try {
    global.fetch = async () => ({ ok: false, status: 404 });
    assert.deepEqual(await bindVoiceKey('voice:G1'), { ok: false, unsupported: true });

    global.fetch = async () => ({ ok: false, status: 500 });
    assert.deepEqual(await bindVoiceKey('voice:G1'), { ok: false, error: 'endpoint 500' });

    global.fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const down = await bindVoiceKey('voice:G1');
    assert.equal(down.retryable, true, 'an unreachable endpoint must be retried, not accepted');
    assert.match(down.error, /ECONNREFUSED/, 'and the cause must not be swallowed');

    global.fetch = async () => ({ ok: true });
    assert.deepEqual(await bindVoiceKey('voice:G1'), { ok: true });
  } finally {
    global.fetch = realFetch;
  }
});
