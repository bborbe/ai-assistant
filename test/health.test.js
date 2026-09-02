'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startHealthServer } = require('../src/health');
const config = require('../src/config');
const voice = require('../src/voice');

function withServer(opts, fn) {
  return new Promise((resolve, reject) => {
    const server = startHealthServer({
      host: '127.0.0.1',
      port: 0,
      build: { version: 'test' },
      ...opts,
    });
    server.on('listening', async () => {
      try {
        await fn(`http://127.0.0.1:${server.address().port}`);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

test('healthz is ok regardless of readiness', async () => {
  await withServer({ isReady: () => false }, async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });
});

test('readiness is 200 when the gateway is connected', async () => {
  await withServer({ isReady: () => true }, async (base) => {
    assert.equal((await fetch(`${base}/readiness`)).status, 200);
  });
});

test('readiness is 503 when draining, so k8s removes us from endpoints', async () => {
  await withServer({ isReady: () => false }, async (base) => {
    const res = await fetch(`${base}/readiness`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { status: 'not-ready' });
  });
});

// POST /chat — the shim's chat-bridge back-edge. Fails closed by default
// (chatBridgeToken unset in test config), so most tests set a token first and
// restore it after — an unset token must never be a silent pass-through.
test('POST /chat is 503 when no token is configured (fails closed)', async () => {
  const before = config.chatBridgeToken;
  config.chatBridgeToken = '';
  try {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      assert.equal(res.status, 503);
    });
  } finally {
    config.chatBridgeToken = before;
  }
});

test('POST /chat is 401 with a missing or wrong bearer token', async () => {
  const before = config.chatBridgeToken;
  config.chatBridgeToken = 'secret';
  try {
    await withServer({}, async (base) => {
      const noAuth = await fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      assert.equal(noAuth.status, 401);

      const wrongAuth = await fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
        body: JSON.stringify({ text: 'hello' }),
      });
      assert.equal(wrongAuth.status, 401);
    });
  } finally {
    config.chatBridgeToken = before;
  }
});

test('POST /chat is 400 on invalid json or missing text', async () => {
  const before = config.chatBridgeToken;
  config.chatBridgeToken = 'secret';
  try {
    await withServer({}, async (base) => {
      const badJson = await fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
        body: '{not json',
      });
      assert.equal(badJson.status, 400);

      const noText = await fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
        body: JSON.stringify({}),
      });
      assert.equal(noText.status, 400);
    });
  } finally {
    config.chatBridgeToken = before;
  }
});

test('POST /chat with a valid token and text calls voice.postToChannel and returns its result', async () => {
  const before = config.chatBridgeToken;
  const beforePost = voice.postToChannel;
  config.chatBridgeToken = 'secret';
  let received = null;
  voice.postToChannel = async (text) => {
    received = text;
    return { posted: true, channel: 'chan-1' };
  };
  try {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
        body: JSON.stringify({ text: 'ARC-L1 Wide Forest Station' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { posted: true, channel: 'chan-1' });
      assert.equal(received, 'ARC-L1 Wide Forest Station');
    });
  } finally {
    config.chatBridgeToken = before;
    voice.postToChannel = beforePost;
  }
});

// POST /voice/yield — LAST JOINER WINS handover. Same auth mechanism as
// /chat on purpose (see handleVoiceYieldPost) — one shared secret, not a
// second scheme for a second bridge route.
test('POST /voice/yield is 503 when no token is configured (fails closed)', async () => {
  const before = config.chatBridgeToken;
  config.chatBridgeToken = '';
  try {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/voice/yield`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newIdentity: 'sc' }),
      });
      assert.equal(res.status, 503);
    });
  } finally {
    config.chatBridgeToken = before;
  }
});

test('POST /voice/yield is 401 with a missing or wrong bearer token', async () => {
  const before = config.chatBridgeToken;
  config.chatBridgeToken = 'secret';
  try {
    await withServer({}, async (base) => {
      const noAuth = await fetch(`${base}/voice/yield`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newIdentity: 'sc' }),
      });
      assert.equal(noAuth.status, 401);

      const wrongAuth = await fetch(`${base}/voice/yield`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
        body: JSON.stringify({ newIdentity: 'sc' }),
      });
      assert.equal(wrongAuth.status, 401);
    });
  } finally {
    config.chatBridgeToken = before;
  }
});

test('POST /voice/yield with a valid token calls voice.yieldVoice and returns its result', async () => {
  const before = config.chatBridgeToken;
  const beforeYield = voice.yieldVoice;
  config.chatBridgeToken = 'secret';
  let received = null;
  voice.yieldVoice = async (newIdentity) => {
    received = newIdentity;
    return { yielded: true, channels: ['chan-1'] };
  };
  try {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/voice/yield`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
        body: JSON.stringify({ newIdentity: 'sc' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { yielded: true, channels: ['chan-1'] });
      assert.equal(received, 'sc');
    });
  } finally {
    config.chatBridgeToken = before;
    voice.yieldVoice = beforeYield;
  }
});

test('POST /voice/yield with no body still succeeds — a bot holding no call is a no-op', async () => {
  const before = config.chatBridgeToken;
  const beforeYield = voice.yieldVoice;
  config.chatBridgeToken = 'secret';
  let received = 'unset';
  voice.yieldVoice = async (newIdentity) => {
    received = newIdentity;
    return { yielded: false, reason: 'no-live-session' };
  };
  try {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/voice/yield`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { yielded: false, reason: 'no-live-session' });
      assert.equal(received, undefined);
    });
  } finally {
    config.chatBridgeToken = before;
    voice.yieldVoice = beforeYield;
  }
});

// POST /voice/rebind — shim restart, re-announce live binds. Same auth as
// /chat and /voice/yield on purpose (see handleVoiceRebindPost) — one shared
// secret, not a third scheme for a third bridge route.
test('POST /voice/rebind is 503 when no token is configured (fails closed)', async () => {
  const before = config.chatBridgeToken;
  config.chatBridgeToken = '';
  try {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/voice/rebind`, { method: 'POST' });
      assert.equal(res.status, 503);
    });
  } finally {
    config.chatBridgeToken = before;
  }
});

test('POST /voice/rebind is 401 with a missing or wrong bearer token', async () => {
  const before = config.chatBridgeToken;
  config.chatBridgeToken = 'secret';
  try {
    await withServer({}, async (base) => {
      const noAuth = await fetch(`${base}/voice/rebind`, { method: 'POST' });
      assert.equal(noAuth.status, 401);

      const wrongAuth = await fetch(`${base}/voice/rebind`, {
        method: 'POST',
        headers: { Authorization: 'Bearer nope' },
      });
      assert.equal(wrongAuth.status, 401);
    });
  } finally {
    config.chatBridgeToken = before;
  }
});

test('POST /voice/rebind with a valid token calls voice.rebindVoice and returns its result', async () => {
  const before = config.chatBridgeToken;
  const beforeRebind = voice.rebindVoice;
  config.chatBridgeToken = 'secret';
  let called = false;
  voice.rebindVoice = async () => {
    called = true;
    return { rebound: true, guilds: ['guild-1'] };
  };
  try {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/voice/rebind`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { rebound: true, guilds: ['guild-1'] });
      assert.equal(called, true);
    });
  } finally {
    config.chatBridgeToken = before;
    voice.rebindVoice = beforeRebind;
  }
});
