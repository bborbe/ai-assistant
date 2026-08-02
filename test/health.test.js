'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startHealthServer } = require('../src/health');

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
