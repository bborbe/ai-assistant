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
