'use strict';

const test = require('node:test');
const assert = require('node:assert');

// The status report's value is exactly the shape of its lines — the
// transcription posture and the shim-owned toggle states must be readable at a
// glance. These smoke tests pin the lines that carry the runtime
// per-conversation toggles, so a regression in the report shape (not just the
// underlying flag logic) is caught.
//
// `report()` is exercised end-to-end: only the network is faked (a global
// fetch that answers the /voice/state probe and fails the /models probe, and
// an unreachable s2s port), so the real `getVoiceState` wiring and the real
// transcription derivation run.

delete process.env.IDENTITY;
delete require.cache[require.resolve('../src/config')];
const config = require('../src/config');
const voice = require('../src/voice');
const { report } = require('../src/status');

// Unreachable localhost ports: the s2s TCP probe fails fast and the report
// still renders, so the test never depends on a live s2s.
config.baseUrl = 'http://127.0.0.1:59999/v1';
config.s2sUrl = 'ws://127.0.0.1:59998/v1/realtime';

const client = () => ({
  user: { tag: 'Test Assistant#1' },
  ws: { ping: 5 },
  guilds: { cache: new Map() },
});

function stubFetch(voiceState) {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/voice/state')) {
      return { ok: true, status: 200, json: async () => voiceState };
    }
    return { ok: false, status: 500 }; // /models probe → shim "down"
  };
  return () => {
    global.fetch = realFetch;
  };
}

test.beforeEach(() => {
  voice.sessions.clear();
});

test('idle status shows the toggle defaults', async () => {
  const restore = stubFetch({
    key: 'voice:1',
    wake: true,
    wake_override: null,
    posting: true,
    interrupt: true,
    transcribe: true,
  });
  try {
    const out = await report(client(), 'channel:1');
    assert.match(out, /transcription: enabled \(default\)/);
    assert.match(out, /⚙️ wake: on \(default\) · posting: voice-text · interrupt: on/);
  } finally {
    restore();
  }
});

test('a live call with transcription and interrupt off is reflected', async () => {
  voice.sessions.set('guild-1', {
    guildId: 'guild-1',
    voiceKey: 'voice:1',
    voiceKeyBound: true,
    closed: false,
    transcript: null,
    channelId: 'chan-1',
  });
  const restore = stubFetch({
    key: 'voice:1',
    wake: true,
    wake_override: null,
    posting: true,
    interrupt: false,
    transcribe: false,
  });
  try {
    const out = await report(client(), 'channel:1');
    assert.match(out, /transcription: disabled/);
    assert.match(out, /interrupt: off/);
  } finally {
    restore();
  }
});

test('an unreachable toggle-state probe degrades to a note, not a broken status', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500 });
  try {
    const out = await report(client(), 'channel:1');
    assert.match(out, /⚙️ toggles — shim state unavailable/);
    assert.match(out, /transcription: enabled \(default\)/, 'transcription line must survive');
  } finally {
    global.fetch = realFetch;
  }
});
