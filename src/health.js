'use strict';

const http = require('node:http');
const log = require('./log');
const config = require('./config');
const voice = require('./voice');

// A malformed/oversized body should never hang the request or blow memory —
// this endpoint is reachable from the shim process, not the public internet,
// but "trusted caller" is not the same as "well-formed caller".
const MAX_BODY_BYTES = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * The shim's back-edge: it has the full answer (voice only ever speaks a
 * truncated slice of it) and posts it here to land in the live call's
 * channel. No channel id in the payload on purpose — see voice.postToChannel.
 */
async function handleChatPost(req, send) {
  // Fails closed: an unset token means every request is refused, not
  // silently trusted, so a forgotten `local.env` export cannot open the
  // route rather than merely leaving it broken.
  if (!config.chatBridgeToken) {
    return send(503, { error: 'chat bridge not configured' });
  }
  const auth = req.headers['authorization'] || '';
  const expected = `Bearer ${config.chatBridgeToken}`;
  if (auth !== expected) {
    return send(401, { error: 'unauthorized' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return send(400, { error: e.message });
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return send(400, { error: 'invalid json' });
  }

  const text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
  if (!text) {
    return send(400, { error: 'text is required' });
  }

  try {
    const result = await voice.postToChannel(text);
    return send(200, result);
  } catch (e) {
    log.error('chat bridge: handler failed', { error: e.message });
    return send(500, { error: 'internal error' });
  }
}

/**
 * Liveness/readiness endpoints so this can run as a normal k8s workload.
 *
 * The split matters more here than in a plain web service, because the bot's
 * dependencies (Discord gateway, the OpenAI endpoint) are exactly the things
 * that must NOT be able to restart the pod:
 *
 *   /healthz   — the process is alive. Nothing external. A Discord outage
 *                restarting every pod would just add reconnect storms to it.
 *   /readiness — the gateway is connected AND the endpoint answered recently.
 *                503 here only drains traffic, which is the right response.
 *   POST /chat — the shim's chat-bridge back-edge (see handleChatPost).
 */
function startHealthServer({ port, host, isReady, build }) {
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
    };

    if (req.method === 'POST' && req.url === '/chat') {
      return void handleChatPost(req, send);
    }

    switch (req.url) {
      case '/healthz':
        return send(200, { status: 'ok' });
      case '/readiness': {
        const ready = isReady();
        return send(ready ? 200 : 503, { status: ready ? 'ready' : 'not-ready' });
      }
      case '/version':
        return send(200, build);
      default:
        return send(404, { error: 'not found' });
    }
  });

  server.listen(port, host, () => log.info('health server listening', { host, port }));
  return server;
}

module.exports = { startHealthServer };
