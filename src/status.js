'use strict';

const net = require('node:net');
const fs = require('node:fs');
const config = require('./config');
const voice = require('./voice');

/**
 * One-shot health summary, readable from inside Discord.
 *
 * Deliberately reachable over BOTH transports — `/status` and a typed `status`.
 * A diagnostic that shares a transport with the thing it diagnoses is useless
 * exactly when it is needed: during the Discord API outage on 2026-08-04 every
 * interaction was dropped while messages flowed normally, so a slash-only
 * version could not have been asked.
 *
 * Each leg is checked live rather than reported from cached state. "The shim is
 * configured at :8080" is not the same claim as "the shim answers", and only the
 * second one is worth reading when something is broken.
 */

/** Can we open a TCP connection to host:port within the timeout? */
function tcpOk(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

async function httpOk(url, timeoutMs = 2000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function hostPort(wsUrl) {
  try {
    const u = new URL(wsUrl);
    return [u.hostname, Number(u.port) || (u.protocol === 'wss:' ? 443 : 80)];
  } catch {
    return [null, null];
  }
}

function humanUptime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

const tick = (ok) => (ok ? '✅' : '❌');

async function report(client) {
  const [s2sHost, s2sPort] = hostPort(config.s2sUrl);

  const [shimUp, s2sUp] = await Promise.all([
    httpOk(`${config.baseUrl}/models`),
    s2sHost ? tcpOk(s2sHost, s2sPort) : Promise.resolve(false),
  ]);

  // Voice sessions this process owns. A ghost connection left by a crashed
  // process would not appear here, which is itself worth knowing.
  const sessions = [...voice.sessions.entries()].map(([guildId, s]) => {
    const g = client.guilds.cache.get(guildId);
    return `${g?.name ?? guildId}${s.transcript ? ' (transcribing)' : ''}`;
  });

  let transcriptOk = false;
  try {
    fs.accessSync(config.transcriptDir, fs.constants.W_OK);
    transcriptOk = true;
  } catch {
    transcriptOk = false;
  }

  const ping = Math.round(client.ws.ping);
  return [
    `**${client.user.tag}** — up ${humanUptime(process.uptime())}, build \`${config.build.version}\``,
    `${tick(ping >= 0)} gateway — ${ping} ms, ${client.guilds.cache.size} guild(s)`,
    `${tick(shimUp)} endpoint — ${config.baseUrl} (${config.model})`,
    `${tick(s2sUp)} speech-to-speech — ${config.s2sUrl}`,
    `${tick(transcriptOk)} transcripts — ${transcriptOk ? 'writable' : 'NOT writable'}`,
    sessions.length ? `🎙️ in voice — ${sessions.join(', ')}` : '🔇 not in a voice channel',
    `👤 allowlist — ${config.allowedUserIds.length} user(s)`,
  ].join('\n');
}

module.exports = { report };
