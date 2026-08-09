'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const voice = require('../src/voice');
const config = require('../src/config');
const { Session } = voice;

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

// speak() tells the endpoint out of band that the turn came from the keyboard
// (llm.markTypedTurn). Stubbed here so the suite never reaches a real endpoint
// — an unstubbed call would POST to whatever is listening on the developer's
// machine and set a hint on a LIVE shim, which is a test quietly mutating
// production-ish state, not a passing test. Recorded so the calls themselves
// can be asserted.
const llm = require('../src/llm');
const realMarkTypedTurn = llm.markTypedTurn;
let typedTurnCalls = [];

test.beforeEach(() => {
  voice.sessions.clear();
  typedTurnCalls = [];
  llm.markTypedTurn = async (key, typed = true) => {
    typedTurnCalls.push({ key, typed });
    return true;
  };
});

test.after(() => {
  llm.markTypedTurn = realMarkTypedTurn;
});

// speak() awaits the typed-turn hint BEFORE touching the socket, so the two
// sends no longer happen in the same tick as the call — they land one
// microtask later. Tests that assert on the sends, or that emit the ack the
// sends are waiting for, have to let that turn first.
const flush = () => new Promise((r) => setImmediate(r));

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

// liveSessionFor and Session.speak are the routing + injection halves of
// "typed during a live call is answered aloud" — exercised the same way as
// postToChannel above: fake collaborators, no real Discord/s2s connection.

function fakeWs({ readyState = WebSocket.OPEN } = {}) {
  const ws = new EventEmitter();
  ws.readyState = readyState;
  ws.sent = [];
  ws.send = (raw) => ws.sent.push(JSON.parse(raw));
  return ws;
}

test('liveSessionFor returns null when the guild has no session', () => {
  assert.equal(voice.liveSessionFor('guild-1', 'chan-1'), null);
});

test('liveSessionFor returns null for a closed session', () => {
  voice.sessions.set('guild-1', fakeSession({ channelId: 'chan-1', closed: true }));
  assert.equal(voice.liveSessionFor('guild-1', 'chan-1'), null);
});

test('liveSessionFor returns null when the channel does not match', () => {
  voice.sessions.set('guild-1', fakeSession({ channelId: 'chan-1' }));
  assert.equal(voice.liveSessionFor('guild-1', 'chan-2'), null);
});

test('liveSessionFor returns the session when live and the channel matches', () => {
  const session = fakeSession({ channelId: 'chan-1' });
  voice.sessions.set('guild-1', session);
  assert.equal(voice.liveSessionFor('guild-1', 'chan-1'), session);
});

test('speak resolves no-socket when the session is closed', async () => {
  const fake = { closed: true, ws: fakeWs(), typedReplyPending: false };
  const result = await Session.prototype.speak.call(fake, 'hello');
  assert.deepEqual(result, { ok: false, reason: 'no-socket' });
});

test('speak resolves no-socket when the ws is not open', async () => {
  const fake = {
    closed: false,
    ws: fakeWs({ readyState: WebSocket.CONNECTING }),
    typedReplyPending: false,
  };
  const result = await Session.prototype.speak.call(fake, 'hello');
  assert.deepEqual(result, { ok: false, reason: 'no-socket' });
});

test('speak sends conversation.item.create then response.create, in order', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false };
  const pending = Session.prototype.speak.call(fake, 'tell me a joke via voice');
  await flush();
  assert.equal(ws.sent.length, 2);
  assert.equal(ws.sent[0].type, 'conversation.item.create');
  assert.deepEqual(ws.sent[0].item, {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'tell me a joke via voice' }],
  });
  assert.equal(ws.sent[1].type, 'response.create');
  ws.emit('message', JSON.stringify({ type: 'response.created' }));
  assert.deepEqual(await pending, { ok: true });
});

test('speak tells the endpoint the turn was typed, before sending anything', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false };
  const pending = Session.prototype.speak.call(fake, 'what is my most important task');
  // Ordering is the whole point: the endpoint consumes the hint at the top of
  // the turn, so a hint that lands after the send is a hint that arrives too
  // late for the turn it describes.
  assert.deepEqual(typedTurnCalls, [{ key: 'default', typed: true }]);
  assert.equal(ws.sent.length, 0, 'nothing sent until the hint is in');
  await flush();
  assert.equal(ws.sent.length, 2);
  ws.emit('message', JSON.stringify({ type: 'response.created' }));
  await pending;
  assert.deepEqual(typedTurnCalls, [{ key: 'default', typed: true }], 'not retracted on success');
});

test('speak retracts the typed hint when the turn never happens', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false };
  const pending = Session.prototype.speak.call(fake, 'hi', { timeoutMs: 20 });
  await flush();
  assert.deepEqual(await pending, { ok: false, reason: 'timeout' });
  // Otherwise the next unrelated SPOKEN reply inherits the flag and gets
  // posted to the channel as though someone had typed the question.
  assert.deepEqual(typedTurnCalls, [
    { key: 'default', typed: true },
    { key: 'default', typed: false },
  ]);
});

test('a proactively-refused speak never sets a hint at all', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false, inResponse: true };
  await Session.prototype.speak.call(fake, 'hi');
  assert.deepEqual(typedTurnCalls, [], 'the common busy case must not touch the endpoint');
});

test('speak sets typedReplyPending on a successful ack', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false };
  const pending = Session.prototype.speak.call(fake, 'hi');
  await flush();
  ws.emit('message', JSON.stringify({ type: 'response.created' }));
  await pending;
  assert.equal(fake.typedReplyPending, true);
});

test('speak resolves busy on conversation_already_has_active_response', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false };
  const pending = Session.prototype.speak.call(fake, 'hi');
  await flush();
  ws.emit(
    'message',
    JSON.stringify({ type: 'error', error: { type: 'conversation_already_has_active_response' } }),
  );
  assert.deepEqual(await pending, { ok: false, reason: 'busy' });
  assert.equal(fake.typedReplyPending, false, 'a refused response must not be marked pending');
});

test('speak ignores unrelated events and resolves timeout if nothing acks', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false };
  const pending = Session.prototype.speak.call(fake, 'hi', { timeoutMs: 20 });
  await flush();
  ws.emit('message', JSON.stringify({ type: 'response.output_audio.delta', delta: 'AAAA' }));
  assert.deepEqual(await pending, { ok: false, reason: 'timeout' });
});

test('speak resolves on any error type, not just conversation_already_has_active_response', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false };
  const pending = Session.prototype.speak.call(fake, 'hi');
  await flush();
  ws.emit('message', JSON.stringify({ type: 'error', error: { type: 'invalid_request' } }));
  assert.deepEqual(await pending, { ok: false, reason: 'invalid_request' });
});

test('speak refuses busy without sending anything when a response is already in flight', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false, inResponse: true };
  const result = await Session.prototype.speak.call(fake, 'hi');
  assert.deepEqual(result, { ok: false, reason: 'busy' });
  assert.equal(ws.sent.length, 0, 'a proactively-refused speak() must not send anything');
});

test('speak refuses busy when another speak() is already awaiting its ack', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false, awaitingSpeakAck: true };
  const result = await Session.prototype.speak.call(fake, 'hi');
  assert.deepEqual(result, { ok: false, reason: 'busy' });
  assert.equal(ws.sent.length, 0);
});

test('speak sets and clears awaitingSpeakAck around a successful round trip', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false };
  const pending = Session.prototype.speak.call(fake, 'hi');
  await flush();
  assert.equal(fake.awaitingSpeakAck, true, 'set before the ack arrives');
  ws.emit('message', JSON.stringify({ type: 'response.created' }));
  await pending;
  assert.equal(fake.awaitingSpeakAck, false, 'cleared once the ack settles the promise');
  assert.equal(fake.pendingSpeakFinish, null);
});

test('speak resolves no-socket immediately when connectS2S tears down the socket mid-wait', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false };
  const pending = Session.prototype.speak.call(fake, 'hi', { timeoutMs: 5000 });
  await flush();
  // Simulate connectS2S()'s fail-fast hook without a real reconnect.
  fake.pendingSpeakFinish({ ok: false, reason: 'no-socket' });
  assert.deepEqual(await pending, { ok: false, reason: 'no-socket' });
});

// onEvent is the other half of the round trip: it is what actually flips
// inResponse/typedReplyPending as real server events arrive, and what marks
// the transcript. Exercised directly (not just observed via speak()'s
// side effects) with a fake collaborator — onEvent's only preconditions are
// `this.audio` (endAudio() no-ops when null) and `this.transcript`.
function fakeOnEventTarget(overrides = {}) {
  const transcriptWrites = [];
  return {
    audio: null,
    speaking: false,
    typedReplyPending: false,
    inResponse: false,
    transcript: { writeText: (speaker, text) => transcriptWrites.push({ speaker, text }) },
    _transcriptWrites: transcriptWrites,
    endAudio: () => {},
    ...overrides,
  };
}

test('onEvent sets inResponse on response.created, for any trigger', () => {
  const fake = fakeOnEventTarget();
  Session.prototype.onEvent.call(fake, JSON.stringify({ type: 'response.created' }));
  assert.equal(fake.inResponse, true);
});

test('onEvent clears inResponse and typedReplyPending on response.done', () => {
  const fake = fakeOnEventTarget({ inResponse: true, typedReplyPending: true });
  Session.prototype.onEvent.call(fake, JSON.stringify({ type: 'response.done' }));
  assert.equal(fake.inResponse, false);
  assert.equal(fake.typedReplyPending, false);
});

test('onEvent marks a typed-triggered reply distinctly in the transcript', () => {
  const fake = fakeOnEventTarget({ typedReplyPending: true });
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'response.output_audio_transcript.done',
      transcript: 'here is your answer',
    }),
  );
  assert.deepEqual(fake._transcriptWrites, [
    { speaker: config.botName, text: '(typed→spoken) here is your answer' },
  ]);
  assert.equal(fake.typedReplyPending, false, 'consumed once written');
});

test('onEvent marks an ordinary spoken reply with no typed marker', () => {
  const fake = fakeOnEventTarget({ typedReplyPending: false });
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: 'hello there' }),
  );
  assert.deepEqual(fake._transcriptWrites, [{ speaker: config.botName, text: 'hello there' }]);
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
