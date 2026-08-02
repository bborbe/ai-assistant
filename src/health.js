'use strict';

const http = require('node:http');
const log = require('./log');

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
