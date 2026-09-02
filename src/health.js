'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
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
  // Constant-time via crypto.timingSafeEqual: plain `!==`/Buffer.compare
  // short-circuit at the first mismatched byte, which is a timing
  // side-channel on the token — and healthHost defaults to 0.0.0.0 (see
  // config.js), so this route is reachable from anything on the pod network,
  // not just localhost. The length check above must stay outside the
  // constant-time compare: timingSafeEqual throws on mismatched lengths.
  const auth = Buffer.from(req.headers['authorization'] || '');
  const expected = Buffer.from(`Bearer ${config.chatBridgeToken}`);
  const authorized = auth.length === expected.length && crypto.timingSafeEqual(auth, expected);
  if (!authorized) {
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
 * The shim's other back-edge: LAST JOINER WINS. Called by the identity that
 * just took the shared speech-to-speech slot, telling this process (whichever
 * identity previously held it) to leave voice — see voice.yieldVoice. Same
 * auth mechanism as /chat, deliberately: one shared secret, one fail-closed
 * check, not a second scheme for a second bridge route. No channel id in the
 * payload either, for the same reason as /chat — only WHO is taking over,
 * never WHICH channel.
 */
async function handleVoiceYieldPost(req, send) {
  if (!config.chatBridgeToken) {
    return send(503, { error: 'chat bridge not configured' });
  }
  const auth = Buffer.from(req.headers['authorization'] || '');
  const expected = Buffer.from(`Bearer ${config.chatBridgeToken}`);
  const authorized = auth.length === expected.length && crypto.timingSafeEqual(auth, expected);
  if (!authorized) {
    return send(401, { error: 'unauthorized' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return send(400, { error: e.message });
  }

  let parsed = {};
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch {
      return send(400, { error: 'invalid json' });
    }
  }
  const newIdentity = typeof parsed?.newIdentity === 'string' ? parsed.newIdentity.trim() : '';

  try {
    const result = await voice.yieldVoice(newIdentity || undefined);
    return send(200, result);
  } catch (e) {
    log.error('voice yield: handler failed', { error: e.message });
    return send(500, { error: 'internal error' });
  }
}

/**
 * The shim's startup back-edge: it just restarted and lost its in-memory
 * `/voice/bind` pointer, so it asks every bot it serves to re-announce its
 * live calls. Same auth mechanism as /chat and /voice/yield deliberately —
 * one shared secret, one fail-closed check, not a third scheme. No body:
 * the caller knows WHAT happened (a shim restart), never WHICH channel — the
 * bot decides from its own sessions map.
 */
async function handleVoiceRebindPost(req, send) {
  if (!config.chatBridgeToken) {
    return send(503, { error: 'chat bridge not configured' });
  }
  const auth = Buffer.from(req.headers['authorization'] || '');
  const expected = Buffer.from(`Bearer ${config.chatBridgeToken}`);
  const authorized = auth.length === expected.length && crypto.timingSafeEqual(auth, expected);
  if (!authorized) {
    return send(401, { error: 'unauthorized' });
  }

  try {
    const result = await voice.rebindVoice();
    return send(200, result);
  } catch (e) {
    log.error('voice rebind: handler failed', { error: e.message });
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
 *   POST /voice/yield — LAST JOINER WINS handover (see handleVoiceYieldPost).
 *   POST /voice/rebind — shim restarted, re-announce live binds (see handleVoiceRebindPost).
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
      // No outer try/catch inside handleChatPost covers a throw from send()
      // itself (e.g. a future JSON.stringify edge case) — without this, that
      // becomes an unhandled rejection, which by default kills the whole
      // process and drops every live voice call with it.
      handleChatPost(req, send).catch((e) => {
        log.error('chat bridge: unhandled', { error: e.message });
        try {
          send(500, { error: 'internal error' });
        } catch {
          // Response already sent or the socket is gone; nothing more to do.
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/voice/yield') {
      // Same unhandled-rejection guard as /chat above.
      handleVoiceYieldPost(req, send).catch((e) => {
        log.error('voice yield: unhandled', { error: e.message });
        try {
          send(500, { error: 'internal error' });
        } catch {
          // Response already sent or the socket is gone; nothing more to do.
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/voice/rebind') {
      // Same unhandled-rejection guard as /chat above.
      handleVoiceRebindPost(req, send).catch((e) => {
        log.error('voice rebind: unhandled', { error: e.message });
        try {
          send(500, { error: 'internal error' });
        } catch {
          // Response already sent or the socket is gone; nothing more to do.
        }
      });
      return;
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
