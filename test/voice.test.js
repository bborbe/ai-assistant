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
function fakeSession({ channelId = 'chan-1', closed = false, sendImpl, guildId } = {}) {
  const sent = [];
  const transcriptWrites = [];
  return {
    channelId,
    guildId,
    closed,
    channel: {
      send: sendImpl || (async (part) => sent.push(part)),
    },
    transcript: { writeText: (speaker, text) => transcriptWrites.push({ speaker, text }) },
    // yieldVoice() (and leave()) call destroy() — a no-op is enough here since
    // these fakes never own a real voice connection.
    destroy: () => {},
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
const realSetVoiceSolo = llm.setVoiceSolo;
let typedTurnCalls = [];
let voiceSoloCalls = [];

test.beforeEach(() => {
  voice.sessions.clear();
  typedTurnCalls = [];
  voiceSoloCalls = [];
  llm.markTypedTurn = async (key, typed = true) => {
    typedTurnCalls.push({ key, typed });
    return true;
  };
  llm.setVoiceSolo = async (solo, key) => {
    voiceSoloCalls.push({ solo, key });
    return { ok: true };
  };
});

test.after(() => {
  llm.markTypedTurn = realMarkTypedTurn;
  llm.setVoiceSolo = realSetVoiceSolo;
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

test('yieldVoice is a no-op success when this identity holds no call', async () => {
  const result = await voice.yieldVoice('sc');
  assert.deepEqual(result, { yielded: false, reason: 'no-live-session' });
});

test('yieldVoice leaves the live call and announces who took over', async () => {
  const session = fakeSession({ channelId: 'chan-1', guildId: 'guild-1' });
  voice.sessions.set('guild-1', session);
  let destroyed = false;
  session.destroy = () => (destroyed = true);

  const result = await voice.yieldVoice('sc');

  assert.equal(result.yielded, true);
  assert.deepEqual(result.channels, ['chan-1']);
  assert.equal(destroyed, true);
  assert.equal(voice.sessions.has('guild-1'), false);
  assert.equal(session._sent.length, 1);
  assert.match(session._sent[0], /sc is taking over/);
  assert.equal(session._transcriptWrites.length, 1);
  assert.match(session._transcriptWrites[0].text, /yielded to sc/);
});

test('yieldVoice ignores a closed session, same as postToChannel', async () => {
  voice.sessions.set('guild-1', fakeSession({ closed: true }));
  const result = await voice.yieldVoice('sc');
  assert.deepEqual(result, { yielded: false, reason: 'no-live-session' });
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

test('a transcribed mic utterance raises the typing indicator', () => {
  let typingCalls = 0;
  const fake = fakeOnEventTarget({
    channel: {
      sendTyping: async () => {
        typingCalls += 1;
      },
    },
    typingTimer: null,
    closed: false,
    showTyping: Session.prototype.showTyping,
  });

  // The spoken path does NOT get response.created — the server only emits it
  // for a client-requested response (handlers/response.py:191). Driving this
  // test with response.created is what made the first attempt look correct
  // while doing nothing on a real call.
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hey bot, how many vision pages do I have',
    }),
  );

  assert.equal(fake.answering, true);
  assert.equal(typingCalls, 1, 'shown immediately, not on the first 8s tick');
  clearInterval(fake.typingTimer);
});

test('an accumulated turn is still addressed when a later sentence opens with the phrase', () => {
  // The exact live failure: speech-to-speech grows one turn across progressive
  // finals, so the phrase never sits at position zero and a whole-utterance
  // prefix match rejected three properly-addressed attempts in a row.
  assert.equal(
    config.isAddressed(
      'Uh can you check about my free disk space? Hey bot, can you check about my free disk space?',
    ),
    true,
  );
  // Still anchored — the phrase has to OPEN a sentence, not merely appear.
  assert.equal(config.isAddressed('I told him the bot was broken'), false);
  assert.equal(config.isAddressed("So, hey bot, what's my task"), false);
  assert.equal(config.isAddressed('hey Bob, did you see this'), false);
});

test('boolean settings accept the spellings people actually write', () => {
  // INTERRUPT_RESPONSE=true silently did nothing when this only tested for '1'.
  const saved = process.env.INTERRUPT_RESPONSE;
  try {
    for (const [raw, want] of [
      ['1', true],
      ['true', true],
      ['ON', true],
      ['yes', true],
      ['0', false],
      ['false', false],
      ['off', false],
      ['"1"', true], // Make's include leaves the quotes in the value
    ]) {
      process.env.INTERRUPT_RESPONSE = raw;
      delete require.cache[require.resolve('../src/config')];
      assert.equal(require('../src/config').interruptResponse, want, `for ${raw}`);
    }
  } finally {
    if (saved === undefined) delete process.env.INTERRUPT_RESPONSE;
    else process.env.INTERRUPT_RESPONSE = saved;
    delete require.cache[require.resolve('../src/config')];
    require('../src/config');
  }
});

test('an unaddressed utterance raises no indicator and never sets answering', () => {
  let typingCalls = 0;
  const fake = fakeOnEventTarget({
    channel: {
      sendTyping: async () => {
        typingCalls += 1;
      },
    },
    typingTimer: null,
    closed: false,
    showTyping: Session.prototype.showTyping,
  });

  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'what do you think about the deploy',
    }),
  );

  // Not cosmetic: the endpoint answers an unaddressed turn with silence, so
  // nothing arrives to clear `answering`. Left set, it hangs the dots until the
  // five-minute cap AND makes speak() refuse typed turns as busy for the same
  // period — every sentence said to a colleague would wedge the typed path.
  assert.equal(typingCalls, 0, 'no dots for speech that will never be answered');
  assert.equal(fake.answering, false, 'and the busy gate must not arm');
  assert.equal(fake.typingTimer, null);
});

test('the indicator stops when the response ends', () => {
  const fake = fakeOnEventTarget({
    channel: { sendTyping: async () => {} },
    typingTimer: null,
    closed: false,
    showTyping: Session.prototype.showTyping,
  });

  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hey bot, hi',
    }),
  );
  assert.equal(fake.answering, true);
  Session.prototype.onEvent.call(fake, JSON.stringify({ type: 'response.done' }));
  assert.equal(fake.answering, false, 'the ticker stops itself on the next tick');
  clearInterval(fake.typingTimer);
});

test('showTyping does not stack a second ticker on a repeated response.created', () => {
  let typingCalls = 0;
  const fake = fakeOnEventTarget({
    channel: {
      sendTyping: async () => {
        typingCalls += 1;
      },
    },
    typingTimer: null,
    closed: false,
    showTyping: Session.prototype.showTyping,
  });

  const utterance = JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'hey bot, hi',
  });
  Session.prototype.onEvent.call(fake, utterance);
  Session.prototype.onEvent.call(fake, utterance);

  assert.equal(typingCalls, 1, 'the second call must find a live ticker and leave it alone');
  clearInterval(fake.typingTimer);
});

// These two carry a real `guildId`. Without one, `voiceKeyFor(undefined)` falls
// back to `default` — so a keyless fake made them pass against BOTH the buggy
// and the fixed code, which is how they came to assert `default` and quietly
// contradict the regression test below.
test('speak tells the endpoint the turn was typed, before sending anything', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false, guildId: 'guild-1' };
  const pending = Session.prototype.speak.call(fake, 'what is my most important task');
  // Ordering is the whole point: the endpoint consumes the hint at the top of
  // the turn, so a hint that lands after the send is a hint that arrives too
  // late for the turn it describes.
  assert.deepEqual(typedTurnCalls, [{ key: 'voice:guild-1', typed: true }]);
  assert.equal(ws.sent.length, 0, 'nothing sent until the hint is in');
  await flush();
  assert.equal(ws.sent.length, 2);
  ws.emit('message', JSON.stringify({ type: 'response.created' }));
  await pending;
  assert.deepEqual(
    typedTurnCalls,
    [{ key: 'voice:guild-1', typed: true }],
    'not retracted on success',
  );
});

test('speak retracts the typed hint when the turn never happens', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false, guildId: 'guild-1' };
  const pending = Session.prototype.speak.call(fake, 'hi', { timeoutMs: 20 });
  await flush();
  assert.deepEqual(await pending, { ok: false, reason: 'timeout' });
  // Otherwise the next unrelated SPOKEN reply inherits the flag and gets
  // posted to the channel as though someone had typed the question.
  assert.deepEqual(typedTurnCalls, [
    { key: 'voice:guild-1', typed: true },
    { key: 'voice:guild-1', typed: false },
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

test('speak refuses busy while a MIC turn is being answered', async () => {
  const ws = fakeWs();
  // `inResponse` deliberately false: a mic turn never gets response.created,
  // so this is the state a real spoken answer is actually in. Gating only on
  // inResponse let this case through to be refused by the server instead.
  const fake = { closed: false, ws, typedReplyPending: false, answering: true };
  const result = await Session.prototype.speak.call(fake, 'hi');
  assert.deepEqual(result, { ok: false, reason: 'busy' });
  assert.equal(ws.sent.length, 0);
  assert.deepEqual(typedTurnCalls, [], 'and no typed hint is left behind');
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
    // Stubbed by default so the event tests stay about event handling; the two
    // tests that are ABOUT the indicator pass the real prototype method in.
    showTyping: () => {},
    answering: false,
    // Wait state for the "slot already in use" retry deadline — see
    // Session.prototype.onSlotFreed and the 'error' handler in onEvent.
    slotWaitStartedAt: null,
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

test('barge-in obeys the interrupt switch, not just the server side', () => {
  // Two interrupt paths exist: the server cancels generation, the bot destroys
  // playback. Gating only the server left an acknowledgement still cutting the
  // assistant off mid-sentence, with the switch reading "off".
  const stopped = [];
  const fake = fakeOnEventTarget({
    speaking: true,
    stopAudio: () => stopped.push('stopped'),
  });

  const saved = config.interruptResponse;
  try {
    config.interruptResponse = false;
    Session.prototype.onEvent.call(
      fake,
      JSON.stringify({ type: 'input_audio_buffer.speech_started' }),
    );
    assert.deepEqual(stopped, [], 'switch off: speaking over it must not kill playback');

    config.interruptResponse = true;
    Session.prototype.onEvent.call(
      fake,
      JSON.stringify({ type: 'input_audio_buffer.speech_started' }),
    );
    assert.deepEqual(stopped, ['stopped'], 'switch on: barge-in still works');
  } finally {
    config.interruptResponse = saved;
  }
});

test('a wake phrase preceded by hesitation still counts', () => {
  // Three real failures from one call. Requiring the phrase at the literal
  // sentence start made the feature unusable in ordinary speech while passing
  // every test written from imagined utterances.
  assert.equal(
    config.isAddressed('Hello. How are you? Uh hey bot, can you check my free disk space?'),
    true,
  );
  assert.equal(config.isAddressed('Uh hey hey bot, did you hear me?'), true);
  assert.equal(config.isAddressed("Okay, um, hey bot, what's my task?"), true);
  // Only NOISE may precede it — a real word still does not count.
  assert.equal(config.isAddressed("So, hey bot, what's my task"), false);
  assert.equal(config.isAddressed('Oh hey.'), false);
});

test('a turn that produces nothing does not leave the indicator stuck', () => {
  // Observed live at 12:39: an addressed turn died with "listener gone", so no
  // response.done arrived and `answering` stayed true — dots to the cap, and
  // speak() refusing typed turns as busy for the same period.
  const fake = fakeOnEventTarget({
    channel: { sendTyping: async () => {} },
    typingTimer: null,
    closed: false,
    showTyping: Session.prototype.showTyping,
  });
  const utter = (t) =>
    Session.prototype.onEvent.call(
      fake,
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: t,
      }),
    );

  utter('hey bot, check my tasks');
  assert.equal(fake.answering, true);

  // The turn dies silently — no response.done. The NEXT utterance is what ends
  // the stuck state, so the bound is "until you speak again", not the cap.
  utter('so anyway, as I was saying to you');
  assert.equal(fake.answering, false, 'a later utterance must clear a stranded flag');

  clearInterval(fake.typingTimer);
});

test('hi bot is accepted — the mishearing that blocked a real question', () => {
  assert.equal(
    config.isAddressed('…Ghost MK2 spaceship. Ah hi bot. Can you check for a task?'),
    true,
  );
  // Still not a free-for-all: a different word after "hi" is not a wake phrase.
  assert.equal(config.isAddressed('hi Bob, did you see this'), false);
});

test('ooh is a hesitation too — the ninth attempt in the reliability run', () => {
  // 'oh' was on the list, 'ooh' was not: one letter, and the gate declined a
  // real question. Third variant found the same way (hey bought, hi bot, ooh)
  // — every miss this feature has had is a transcription spelling, never logic.
  assert.equal(config.isAddressed('Ooh, hey bot, how many tasks do I have in progress?'), true);
  assert.equal(config.isAddressed('Oh hey bot, how many tasks do we have in progress?'), true);
  // Unchanged: only noise may precede the phrase.
  assert.equal(config.isAddressed("So, hey bot, what's my task"), false);
});

test('an s2s error is reported on both surfaces, not just logged', async () => {
  const sent = [];
  const fake = fakeOnEventTarget({
    channel: { send: async (t) => sent.push(t) },
  });

  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'error',
      error: { type: 'response_failed', message: 'Language model generation failed: boom' },
    }),
  );
  await new Promise((r) => setImmediate(r));

  // From inside Discord a failed answer and an ignored utterance are the same
  // event — silence. Both surfaces must carry the reason.
  assert.equal(fake._transcriptWrites.length, 1);
  assert.match(fake._transcriptWrites[0].text, /^\(voice reply failed: Language model/);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Could not answer that out loud/);
});

test('an s2s error clears the flags no response.done will clear', async () => {
  const fake = fakeOnEventTarget({
    channel: { send: async () => {} },
    answering: true,
    inResponse: true,
    typedReplyPending: true,
  });

  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({ type: 'error', error: { type: 'response_failed', message: 'boom' } }),
  );

  // A turn failing before any assistant text emits no response.done, so these
  // would stay raised and wedge every later speak() as permanently busy —
  // observed on 2026-08-11 as a typed turn refused with reason `busy` while
  // nothing was in flight.
  assert.equal(fake.answering, false);
  assert.equal(fake.inResponse, false);
  assert.equal(fake.typedReplyPending, false);
});

test('a multi-line server error is compacted to one readable line', async () => {
  const sent = [];
  const fake = fakeOnEventTarget({ channel: { send: async (t) => sent.push(t) } });

  // Verbatim shape of the NLTK LookupError that caused the 30h silent outage:
  // a banner line, the reason, then a bulleted list of searched paths.
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'error',
      error: {
        type: 'response_failed',
        message:
          '\n**********************************************************************\n' +
          "  Resource 'punkt_tab' not found.\n  Please use the NLTK Downloader:\n" +
          "  Searched in:\n    - '/Users/x/nltk_data'\n",
      },
    }),
  );
  await new Promise((r) => setImmediate(r));

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /\n/, 'a chat notice must stay one line');
  assert.match(sent[0], /punkt_tab' not found/);
});

test('a busy refusal does not cut off the answer already being spoken', async () => {
  const sent = [];
  let endAudioCalls = 0;
  const fake = fakeOnEventTarget({
    channel: { send: async (t) => sent.push(t) },
    endAudio: () => {
      endAudioCalls += 1;
    },
    answering: true,
    inResponse: true,
  });

  // conversation_already_has_active_response arrives BY DEFINITION while a
  // response is in flight. Treating it as a dead turn would clear the flags and
  // stop playback mid-answer -- and text.js already reports it for typed turns,
  // so handling it here would also double-post.
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'error',
      error: { type: 'conversation_already_has_active_response', message: 'busy' },
    }),
  );
  await new Promise((r) => setImmediate(r));

  assert.equal(fake.answering, true, 'an in-flight answer must survive a busy refusal');
  assert.equal(fake.inResponse, true);
  assert.equal(endAudioCalls, 0, 'playback must not be stopped');
  assert.equal(sent.length, 0, 'text.js already reports this one');
  assert.equal(fake._transcriptWrites.length, 0);
});

function slotInUseErrorJson() {
  // speech-to-speech has exactly one session slot machine-wide — this is the
  // error text it sends when another process already holds it.
  return JSON.stringify({
    type: 'error',
    error: {
      type: 'server_error',
      message: 'session slots are in use, disconnect an existing client',
    },
  });
}

test('the FIRST slot-in-use refusal waits instead of leaving immediately', async () => {
  const sent = [];
  const guildId = 'guild-slot-wait';
  let destroyed = false;
  voice.sessions.set(guildId, { destroy: () => (destroyed = true) });
  const fake = fakeOnEventTarget({
    guildId,
    channel: { send: async (t) => sent.push(t) },
  });

  // v0.19.0 left on the FIRST refusal — a race against its own handover, which
  // asks the previous holder to yield before this bot even tries to connect.
  // The first refusal can arrive while that yield is still in flight.
  Session.prototype.onEvent.call(fake, slotInUseErrorJson());
  await new Promise((r) => setImmediate(r));

  assert.equal(destroyed, false, 'must not leave on the first refusal');
  assert.equal(voice.sessions.has(guildId), true);
  assert.equal(sent.length, 0, 'no channel notice while still within the retry window');
  assert.equal(fake._transcriptWrites.length, 0);
  assert.ok(fake.slotWaitStartedAt, 'wait state must be recorded');
});

test('a slot-in-use refusal within the deadline keeps waiting on later attempts too', async () => {
  const sent = [];
  const guildId = 'guild-slot-still-waiting';
  let destroyed = false;
  voice.sessions.set(guildId, { destroy: () => (destroyed = true) });
  // Started 3s ago — well inside the 10s default deadline, mirroring the 2s
  // retry cadence's second or third attempt.
  const fake = fakeOnEventTarget({
    guildId,
    channel: { send: async (t) => sent.push(t) },
    slotWaitStartedAt: Date.now() - 3000,
  });

  Session.prototype.onEvent.call(fake, slotInUseErrorJson());
  await new Promise((r) => setImmediate(r));

  assert.equal(destroyed, false);
  assert.equal(voice.sessions.has(guildId), true);
  assert.equal(sent.length, 0, 'still no channel notice — a successful handover must be silent');
  assert.equal(fake._transcriptWrites.length, 0);
});

test('a slot-in-use refusal past the deadline leaves loudly, exactly as before', async () => {
  const sent = [];
  const guildId = 'guild-slot-deadline-expired';
  let destroyed = false;
  voice.sessions.set(guildId, { destroy: () => (destroyed = true) });
  // Started well before the 10s default deadline.
  const fake = fakeOnEventTarget({
    guildId,
    channel: { send: async (t) => sent.push(t) },
    slotWaitStartedAt: Date.now() - (config.voiceSlotRetryDeadlineMs + 1000),
  });

  Session.prototype.onEvent.call(fake, slotInUseErrorJson());
  await new Promise((r) => setImmediate(r));

  assert.equal(destroyed, true, 'the session must be left once the deadline passes');
  assert.equal(voice.sessions.has(guildId), false);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /already in use/i);
  assert.equal(fake._transcriptWrites.length, 1);
  assert.match(fake._transcriptWrites[0].text, /slot in use elsewhere/);
});

test('the retry deadline is configurable', () => {
  const original = process.env.VOICE_SLOT_RETRY_DEADLINE_MS;
  try {
    process.env.VOICE_SLOT_RETRY_DEADLINE_MS = '2500';
    delete require.cache[require.resolve('../src/config')];
    const freshConfig = require('../src/config');
    assert.equal(freshConfig.voiceSlotRetryDeadlineMs, 2500);
  } finally {
    if (original === undefined) delete process.env.VOICE_SLOT_RETRY_DEADLINE_MS;
    else process.env.VOICE_SLOT_RETRY_DEADLINE_MS = original;
    delete require.cache[require.resolve('../src/config')];
    require('../src/config');
  }
});

test('onSlotFreed logs recovery and clears the wait state, once the slot frees', () => {
  const fake = fakeOnEventTarget({ slotWaitStartedAt: Date.now() - 4000 });
  Session.prototype.onSlotFreed.call(fake);
  assert.equal(fake.slotWaitStartedAt, null);
});

test('onSlotFreed is a no-op when nothing was being waited on', () => {
  const fake = fakeOnEventTarget({ slotWaitStartedAt: null });
  // Must not throw computing Date.now() - null in some unexpected way, and
  // must leave the (already-null) state alone.
  Session.prototype.onSlotFreed.call(fake);
  assert.equal(fake.slotWaitStartedAt, null);
});

test('the handover is claimed on session.created, the server acceptance, not WS open', () => {
  // WS open precedes BOTH outcomes — the router may still reject with
  // session_limit_reached, which sends no session.created. So the "handover
  // completed" claim (onSlotFreed) belongs to session.created, and a wait
  // state set by a prior rejection must be cleared there, not in the open
  // handler. This is the honesty fix for the 2026-08-22 secondary defect.
  const fake = fakeOnEventTarget({
    slotWaitStartedAt: Date.now() - 4000,
    onSlotFreed: Session.prototype.onSlotFreed,
  });
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({ type: 'session.created', session: { id: 'sess-1' } }),
  );
  assert.equal(fake.slotWaitStartedAt, null, 'acceptance clears the wait state');
});

test('session.created is a no-op when nothing was being waited on', () => {
  const fake = fakeOnEventTarget({
    slotWaitStartedAt: null,
    onSlotFreed: Session.prototype.onSlotFreed,
  });
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({ type: 'session.created', session: { id: 'sess-2' } }),
  );
  assert.equal(fake.slotWaitStartedAt, null, 'already-clear state stays clear');
});

// A minimal session the noteVoiceState idle-release path needs: channelId for
// the "here" anchor, `channel` for the fire-time humansIn re-check, the real
// schedule/cancel methods, a destroy() that records, and (optionally) a
// transcript whose writes are captured. voiceStateUpdate-shaped objects carry
// the same `guild` with a channel cache resolving to `channel`.
function fakeNvsSession({ channel, transcript, guildId = 'guild-nvs' }) {
  return {
    guildId,
    channelId: 'chan-A',
    channel,
    closed: false,
    idleReleaseTimer: null,
    scheduleIdleRelease: Session.prototype.scheduleIdleRelease,
    cancelIdleRelease: Session.prototype.cancelIdleRelease,
    names: new Map(),
    ...(transcript ? { transcript } : {}),
    destroy: () => {},
  };
}

function voiceStatePair({ channel, member = { id: 'u1', displayName: 'Uno' } }) {
  const guild = { id: 'guild-nvs', channels: { cache: { get: () => channel } } };
  return {
    old: { guildId: guild.id, guild, channelId: 'chan-A', member },
    next: { guildId: guild.id, guild, channelId: null, member },
  };
}

test('noteVoiceState schedules (not takes) the idle release when the last human leaves', () => {
  const guildId = 'guild-nvs';
  const channel = { members: fakeMembers([]) };
  const writes = [];
  const session = fakeNvsSession({
    channel,
    transcript: { writeText: (speaker, text) => writes.push({ speaker, text }) },
  });
  voice.sessions.set(guildId, session);
  const { old, next } = voiceStatePair({ channel });
  voice.noteVoiceState(old, next);

  assert.ok(
    session.idleReleaseTimer,
    'a brief absence must not tear the session down — a grace timer is armed instead',
  );
  assert.equal(voice.sessions.has(guildId), true, 'session stays in the map during the grace');
  assert.deepEqual(
    writes,
    [{ speaker: 'Uno', text: '(left the channel)' }],
    'the departing member is still written while the session exists',
  );
});

test('noteVoiceState schedules the idle release with transcription off too', () => {
  const guildId = 'guild-nvs';
  const channel = { members: fakeMembers([]) };
  const session = fakeNvsSession({ channel }); // no transcript — transcription off
  voice.sessions.set(guildId, session);
  const { old, next } = voiceStatePair({ channel });
  voice.noteVoiceState(old, next);

  assert.ok(session.idleReleaseTimer, 'grace must hold for calls with transcription off');
  assert.equal(voice.sessions.has(guildId), true);
});

test('the idle grace timer releases the session when it fires and the channel is still empty', async () => {
  const guildId = 'guild-nvs';
  const channel = { members: fakeMembers([]) };
  let destroyed = false;
  const session = fakeNvsSession({ channel });
  session.destroy = () => (destroyed = true);
  voice.sessions.set(guildId, session);

  const original = config.voiceIdleReleaseMs;
  config.voiceIdleReleaseMs = 20;
  try {
    const { old, next } = voiceStatePair({ channel });
    voice.noteVoiceState(old, next);
    assert.ok(session.idleReleaseTimer, 'timer armed on empty');
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    config.voiceIdleReleaseMs = original;
  }

  assert.equal(destroyed, true, 'release fires after the grace window');
  assert.equal(voice.sessions.has(guildId), false);
});

test('a rejoining human cancels the scheduled idle release', async () => {
  const guildId = 'guild-nvs';
  const emptyChannel = { members: fakeMembers([]) };
  const filledChannel = { members: fakeMembers([{ user: { bot: false } }]) };
  let destroyed = false;
  const session = fakeNvsSession({ channel: emptyChannel });
  session.destroy = () => (destroyed = true);
  voice.sessions.set(guildId, session);

  const original = config.voiceIdleReleaseMs;
  config.voiceIdleReleaseMs = 20;
  try {
    const { old, next } = voiceStatePair({ channel: emptyChannel });
    voice.noteVoiceState(old, next); // last human leaves -> armed
    assert.ok(session.idleReleaseTimer, 'timer armed on empty');
    // Someone rejoins before the grace elapses.
    const pair2 = voiceStatePair({ channel: filledChannel });
    voice.noteVoiceState({ ...pair2.next, channelId: null }, { ...pair2.old, channelId: 'chan-A' });
    assert.equal(session.idleReleaseTimer, null, 'rejoin cancels the timer');
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    config.voiceIdleReleaseMs = original;
  }

  assert.equal(destroyed, false, 'the session survives once someone is back');
  assert.equal(voice.sessions.has(guildId), true);
});

test('noteVoiceState keeps the session while other humans remain', () => {
  const guildId = 'guild-nvs';
  const channel = { members: fakeMembers([{ user: { bot: false } }]) };
  const session = fakeNvsSession({ channel });
  voice.sessions.set(guildId, session);
  const { old, next } = voiceStatePair({ channel });
  voice.noteVoiceState(old, next);

  assert.equal(session.idleReleaseTimer, null, 'a departing member is not the last human');
  assert.equal(voice.sessions.has(guildId), true);
});

test('cancelIdleRelease clears a pending grace timer (what destroy calls)', () => {
  const guildId = 'guild-nvs';
  const channel = { members: fakeMembers([]) };
  const session = fakeNvsSession({ channel });
  voice.sessions.set(guildId, session);
  const { old, next } = voiceStatePair({ channel });
  voice.noteVoiceState(old, next);
  assert.ok(session.idleReleaseTimer, 'armed by the empty departure');

  session.cancelIdleRelease();
  assert.equal(session.idleReleaseTimer, null, 'cleared');
});

test('a non-slot s2s error still follows its existing path unchanged', async () => {
  const sent = [];
  const guildId = 'guild-non-slot-error';
  let destroyed = false;
  voice.sessions.set(guildId, { destroy: () => (destroyed = true) });
  const fake = fakeOnEventTarget({
    guildId,
    channel: { send: async (t) => sent.push(t) },
    answering: true,
    inResponse: true,
  });

  // A generic server error unrelated to the slot must never trip the
  // slot-in-use wait/leave machinery.
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({ type: 'error', error: { type: 'server_error', message: 'boom, unrelated' } }),
  );
  await new Promise((r) => setImmediate(r));

  assert.equal(destroyed, false);
  assert.equal(voice.sessions.has(guildId), true);
  assert.equal(sent.length, 0);
  assert.equal(fake._transcriptWrites.length, 0);
  assert.equal(fake.slotWaitStartedAt, null);
});

// A Collection-like stand-in: `.filter` returning something with `.size` is the
// whole contract humansIn depends on, so a Map-backed fake is enough.
function fakeMembers(users) {
  return {
    filter: (fn) => ({ size: users.filter(fn).length }),
  };
}

test('humansIn does not count the assistant itself', () => {
  // The bot is a member of the channel it listens to, so counting naively makes
  // "alone" unreachable — the case this whole feature turns on.
  const channel = {
    members: fakeMembers([{ user: { bot: false } }, { user: { bot: true } }]),
  };
  assert.equal(voice.humansIn(channel), 1);
});

test('humansIn returns null for an unreadable channel, not zero', () => {
  // null and 0 must not collapse: an unreadable room leaves the gate where it
  // is, while zero would read as "nobody here" and is a different claim.
  assert.equal(voice.humansIn(undefined), null);
  assert.equal(voice.humansIn({}), null);
  assert.equal(voice.humansIn({ members: {} }), null);
});

test('humansIn counts a second person, which is what re-arms the gate', () => {
  const channel = {
    members: fakeMembers([
      { user: { bot: false } },
      { user: { bot: false } },
      { user: { bot: true } },
    ]),
  };
  assert.equal(voice.humansIn(channel), 2);
});

test('solo raises the typing indicator for an unaddressed utterance', () => {
  let typing = 0;
  const fake = fakeOnEventTarget({ solo: true, showTyping: () => (typing += 1) });

  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'so what does that leave for tomorrow',
    }),
  );

  // The shim answers this turn when solo, so the bot must raise the dots for it
  // — a drift between the two sides shows up exactly here.
  assert.equal(fake.answering, true);
  assert.equal(typing, 1);
});

test('not solo still requires the phrase on the bot side', () => {
  let typing = 0;
  const fake = fakeOnEventTarget({ solo: false, showTyping: () => (typing += 1) });

  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'so what does that leave for tomorrow',
    }),
  );

  assert.equal(fake.answering, false);
  assert.equal(typing, 0, 'no dots for a turn the shim will not answer');
});

test('the typed-turn hint is keyed per guild, matching the turn it describes', async () => {
  // THE REGRESSION. v0.10.0 keyed voice as `voice:<guildId>` but this call kept
  // sending DEFAULT_SESSION_KEY, so the shim wrote the hint to `default` and
  // read it from `voice:<guildId>`. It never matched, `typed_turn` stayed false,
  // and every typed message in a live call was judged by the WAKE PHRASE as if
  // spoken — anything not opening with "hey bot" dropped as unaddressed, with
  // no error and no log line beyond QUIET.
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false, guildId: 'guild-9' };
  const pending = Session.prototype.speak.call(fake, 'what were we working on?');
  await flush();

  assert.deepEqual(typedTurnCalls, [{ key: 'voice:guild-9', typed: true }]);
  assert.notEqual(typedTurnCalls[0].key, llm.DEFAULT_SESSION_KEY);

  ws.emit('message', JSON.stringify({ type: 'response.created' }));
  await pending;
});

test('a failed typed turn retracts the hint on the same key it set', async () => {
  // A retraction on the wrong key leaves the hint standing, which marks the
  // next unrelated SPOKEN reply as typed-originated.
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false, guildId: 'guild-9' };
  const pending = Session.prototype.speak.call(fake, 'this one dies');
  await flush();
  ws.emit(
    'message',
    JSON.stringify({ type: 'error', error: { type: 'conversation_already_has_active_response' } }),
  );
  assert.deepEqual(await pending, { ok: false, reason: 'busy' });

  assert.deepEqual(typedTurnCalls, [
    { key: 'voice:guild-9', typed: true },
    { key: 'voice:guild-9', typed: false },
  ]);
});

test('syncSolo POSTs even when the channel is unreadable, arming the gate', async () => {
  // THE 2026-08-18 FIX. Pre-fix this early-returned without POSTing when
  // humans===null (channel.members not readable at slash-command time), so the
  // shim kept whatever stale value a previous call had set. The Brogrammers
  // join inherited a private session's solo=True and answered unaddressed
  // speech. Post-fix the POST happens regardless, the shim's per-key entry
  // is explicitly set to not-solo, and the bot's local flag arms too.
  const fakeSession = { voiceKey: 'voice:G1', solo: false };
  await voice.syncSolo(fakeSession, { members: {} });
  assert.deepEqual(voiceSoloCalls, [{ solo: false, key: 'voice:G1' }]);
  assert.equal(fakeSession.solo, false, 'unreadable channel keeps the gate armed');
});

test('syncSolo carries the session key on the POST', async () => {
  // The shim keys solo state by the same identifier bindVoiceKey uses. If the
  // POST drops the key, the shim rejects with 400 — the test above covered
  // the bot-side obligation to always POST; this covers the value it carries.
  const fakeSession = { voiceKey: 'voice:G1:personal', solo: false };
  await voice.syncSolo(fakeSession, makeChannel({ humans: 2 }));
  assert.deepEqual(voiceSoloCalls, [{ solo: false, key: 'voice:G1:personal' }]);
});

test('syncSolo POSTs even when the new value matches session.solo', async () => {
  // Belt-and-braces against the cross-call leak. The old code skipped the
  // POST when nothing changed; today the POST always runs because a missed
  // POST is exactly the failure mode this whole change exists to prevent.
  // Two consecutive calls with the same value produce two POSTs.
  const fakeSession = { voiceKey: 'voice:G2', solo: false };
  await voice.syncSolo(fakeSession, makeChannel({ humans: 2 }));
  await voice.syncSolo(fakeSession, makeChannel({ humans: 2 }));
  assert.equal(voiceSoloCalls.length, 2, 'unconditional POST every syncSolo');
  assert.ok(voiceSoloCalls.every((c) => c.key === 'voice:G2' && c.solo === false));
});

test('syncSolo flips session.solo on a real change', async () => {
  const fakeSession = { voiceKey: 'voice:G3', solo: false };
  await voice.syncSolo(fakeSession, makeChannel({ humans: 1 }));
  assert.equal(fakeSession.solo, true, 'alone flips local flag to true on POST success');
  await voice.syncSolo(fakeSession, makeChannel({ humans: 2 }));
  assert.equal(fakeSession.solo, false, 'second human re-arms the gate');
  assert.deepEqual(
    voiceSoloCalls.map((c) => c.solo),
    [true, false],
  );
});

test('syncSolo stays armed when VOICE_ALWAYS_WAKE forces it', async () => {
  // An instance that opted out must never tell the shim it is solo, even when
  // exactly one human is in the channel. Same direction as the unreadable
  // channel: the gate stays armed, so unaddressed speech is not answered.
  const prev = config.voiceAlwaysWake;
  config.voiceAlwaysWake = true;
  try {
    const fakeSession = { voiceKey: 'voice:G4', solo: false };
    await voice.syncSolo(fakeSession, makeChannel({ humans: 1 }));
    assert.equal(fakeSession.solo, false, 'flag forces the armed state locally');
    assert.deepEqual(voiceSoloCalls, [{ solo: false, key: 'voice:G4' }]);
  } finally {
    config.voiceAlwaysWake = prev;
  }
});

test('syncSolo honours a runtime wake override in both directions', async () => {
  // The override replaces the env default for THIS call. Forcing it on an
  // instance whose default is off is the noisy-room case; relaxing it on one
  // whose default is on is the Star Citizen instance going solo for a session.
  const prev = config.voiceAlwaysWake;
  try {
    config.voiceAlwaysWake = false;
    const forced = { voiceKey: 'voice:G5', solo: false, wakeOverride: true };
    await voice.syncSolo(forced, makeChannel({ humans: 1 }));
    assert.equal(forced.solo, false, 'override on keeps the gate armed while alone');

    config.voiceAlwaysWake = true;
    const relaxed = { voiceKey: 'voice:G6', solo: false, wakeOverride: false };
    await voice.syncSolo(relaxed, makeChannel({ humans: 1 }));
    assert.equal(relaxed.solo, true, 'override off disarms despite the env default');
  } finally {
    config.voiceAlwaysWake = prev;
  }
});

test('a null wake override falls back to the configured default', async () => {
  // The third state — what `/wake auto` restores. A session that has never been
  // touched by the command must behave exactly as it did before the command existed.
  const prev = config.voiceAlwaysWake;
  try {
    config.voiceAlwaysWake = true;
    const session = { voiceKey: 'voice:G7', solo: false, wakeOverride: null };
    await voice.syncSolo(session, makeChannel({ humans: 1 }));
    assert.equal(session.solo, false, 'null defers to VOICE_ALWAYS_WAKE');
  } finally {
    config.voiceAlwaysWake = prev;
  }
});

test('a relaxed override still cannot disarm the gate in a shared room', async () => {
  // Precedence: the override replaces only the always-wake term. Head-count is
  // untouched, so `/wake off` never makes the bot answer unaddressed speech
  // while someone else is in the channel.
  const prev = config.voiceAlwaysWake;
  try {
    config.voiceAlwaysWake = true;
    const session = { voiceKey: 'voice:G8', solo: false, wakeOverride: false };
    await voice.syncSolo(session, makeChannel({ humans: 3 }));
    assert.equal(session.solo, false, 'three humans keep the gate armed');
  } finally {
    config.voiceAlwaysWake = prev;
  }
});

test('syncSolo keeps session.solo armed when the POST fails', async () => {
  // The shim's per-key state did not get updated on a failed POST, so the bot
  // must mirror that — fail closed, never fail open. Same direction as a
  // 404 from /voice/solo: the gate stays armed until proven otherwise.
  const realStub = llm.setVoiceSolo;
  llm.setVoiceSolo = async () => ({ ok: false, error: 'endpoint 500' });
  try {
    const fakeSession = { voiceKey: 'voice:G4', solo: false };
    await voice.syncSolo(fakeSession, makeChannel({ humans: 1 }));
    assert.equal(fakeSession.solo, false, 'a failed POST keeps the gate armed');
  } finally {
    llm.setVoiceSolo = realStub;
  }
});

function makeChannel({ humans, bots = 0 }) {
  const users = [
    ...Array.from({ length: humans }, () => ({ user: { bot: false } })),
    ...Array.from({ length: bots }, () => ({ user: { bot: true } })),
  ];
  return { members: fakeMembers(users) };
}
