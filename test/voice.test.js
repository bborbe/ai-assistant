'use strict';

const test = require('node:test');
const assert = require('node:assert');
const voice = require('../src/voice');

// postToChannel is a routing function over `sessions`, `.closed`, `.channel`,
// and `.transcript` — none of it needs a real Discord connection or audio
// pipeline, unlike the rest of this module (see CLAUDE.md's "Verifying Voice
// Changes"), so fake session objects are enough to exercise the three
// branches the design calls out: no live session, exactly one, and two+.
function fakeSession({ channelId = 'chan-1', closed = false, sendImpl } = {}) {
  const sent = [];
  const transcriptWrites = [];
  return {
    channelId,
    closed,
    channel: {
      send: sendImpl || (async (part) => sent.push(part)),
    },
    transcript: { writeText: (speaker, text) => transcriptWrites.push({ speaker, text }) },
    _sent: sent,
    _transcriptWrites: transcriptWrites,
  };
}

test.beforeEach(() => {
  voice.sessions.clear();
});

test('postToChannel drops with no-live-session when sessions is empty', async () => {
  const result = await voice.postToChannel('ARC-L1 Wide Forest Station');
  assert.deepEqual(result, { posted: false, reason: 'no-live-session' });
});

test('postToChannel drops with no-live-session when every session is closed', async () => {
  voice.sessions.set('guild-1', fakeSession({ closed: true }));
  const result = await voice.postToChannel('hello');
  assert.deepEqual(result, { posted: false, reason: 'no-live-session' });
});

test('postToChannel sends and writes the transcript for exactly one live session', async () => {
  const session = fakeSession({ channelId: 'chan-42' });
  voice.sessions.set('guild-1', session);

  const result = await voice.postToChannel('ARC-L1 Wide Forest Station');

  assert.deepEqual(result, { posted: true, channel: 'chan-42' });
  assert.deepEqual(session._sent, ['ARC-L1 Wide Forest Station']);
  assert.equal(session._transcriptWrites.length, 1);
  assert.equal(session._transcriptWrites[0].text, 'ARC-L1 Wide Forest Station');
});

test('postToChannel drops as ambiguous when two sessions are live', async () => {
  voice.sessions.set('guild-1', fakeSession({ channelId: 'chan-1' }));
  voice.sessions.set('guild-2', fakeSession({ channelId: 'chan-2' }));

  const result = await voice.postToChannel('hello');

  assert.deepEqual(result, { posted: false, reason: 'ambiguous-multiple-sessions' });
});

test('postToChannel ignores a closed session and still picks the one live session', async () => {
  voice.sessions.set('guild-1', fakeSession({ channelId: 'chan-closed', closed: true }));
  const live = fakeSession({ channelId: 'chan-live' });
  voice.sessions.set('guild-2', live);

  const result = await voice.postToChannel('hello');

  assert.deepEqual(result, { posted: true, channel: 'chan-live' });
});

test('postToChannel reports send-failed when channel.send throws', async () => {
  const session = fakeSession({
    sendImpl: async () => {
      throw new Error('boom');
    },
  });
  voice.sessions.set('guild-1', session);

  const result = await voice.postToChannel('hello');

  assert.deepEqual(result, { posted: false, reason: 'send-failed' });
  assert.equal(session._transcriptWrites.length, 0, 'no transcript write on a failed send');
});

test('postToChannel chunks long text across multiple sends', async () => {
  const session = fakeSession();
  voice.sessions.set('guild-1', session);
  const long = 'x'.repeat(2500);

  const result = await voice.postToChannel(long);

  assert.deepEqual(result, { posted: true, channel: session.channelId });
  assert.ok(
    session._sent.length >= 2,
    'a 2500-char message must span more than one Discord message',
  );
  assert.equal(session._sent.join(''), long);
});
