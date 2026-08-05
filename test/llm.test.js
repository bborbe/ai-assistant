'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { sessionKeyFor, DEFAULT_SESSION_KEY } = require('../src/llm');

const channel = (over) => ({ isThread: () => false, isVoiceBased: () => false, ...over });

test('a voice channel shares the spoken conversation', () => {
  // The one case with teeth: a voice channel's integrated text chat is an
  // ordinary text channel to Discord, so without this it gets its own session
  // and a link pasted mid-call never reaches the conversation being spoken.
  // It is also what lets `switch` / `new` reach voice at all.
  const key = sessionKeyFor(channel({ id: 'V1', guild: {}, isVoiceBased: () => true }), 'U9');
  assert.equal(key, DEFAULT_SESSION_KEY);
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
