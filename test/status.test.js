'use strict';

const test = require('node:test');
const assert = require('node:assert');

// The status report's value is exactly the shape of its lines — the
// transcription posture and the shim-owned toggle states must be readable at a
// glance. These smoke tests pin the lines that carry the runtime
// per-conversation toggles, so a regression in the report shape (not just the
// underlying flag logic) is caught.
//
// The three toggles get one line each, prefixed by their own icon, so the
// toggle assertions are anchored to whole lines: an `interrupt: off` appearing
// mid-line in a re-joined `wake: … · posting: … · interrupt: off` must fail,
// because that run-on line is the shape this guards. The icon is the only glyph
// on the line — a per-flag tick was tried and dropped, so an assertion that
// tolerates one would let it creep back.
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
    assert.match(out, /^👂 wake: on \(default\)$/m);
    assert.match(out, /^🎚️ mode: voice-text$/m);
    assert.match(out, /^✋ interrupt: on$/m);
  } finally {
    restore();
  }
});

test('a live call with every toggle flipped is reflected', async () => {
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
    wake: false,
    wake_override: false,
    posting: false,
    interrupt: false,
    transcribe: false,
  });
  try {
    const out = await report(client(), 'channel:1');
    assert.match(out, /transcription: disabled/);
    assert.match(out, /^👂 wake: off \(override\)$/m);
    assert.match(out, /^🎚️ mode: voice-only$/m);
    assert.match(out, /^✋ interrupt: off$/m, 'the icon is the only glyph on the line');
  } finally {
    restore();
  }
});

test('text-only is reported by name, not as a posting flag', async () => {
  // The mode is ONE setting held as a pair of shim flags, so /status names it.
  // `posting: true, speech: false` is exactly text-only, and seeing it at a
  // glance is the whole point — a stale text-only that reads as broken voice is
  // the failure this line exists to prevent.
  const restore = stubFetch({
    key: 'voice:1',
    wake: true,
    wake_override: null,
    posting: true,
    speech: false,
    interrupt: true,
    transcribe: true,
  });
  try {
    const out = await report(client(), 'channel:1');
    assert.match(out, /^🎚️ mode: text-only$/m);
  } finally {
    restore();
  }
});

test('a shim without the speech field reads as voice-text, never text-only', async () => {
  // `speech` is absent on a shim predating text-only. Absent must mean the
  // default: a truthiness test would report every older shim as text-only, the
  // one reading that sends an operator hunting a fault that is not there.
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
    assert.match(out, /^🎚️ mode: voice-text$/m);
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
