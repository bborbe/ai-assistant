'use strict';

const net = require('node:net');
const fs = require('node:fs');
const config = require('./config');
const voice = require('./voice');
const { listSessions, DEFAULT_SESSION_KEY } = require('./llm');

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

function humanAge(minutes) {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  return humanUptime(minutes * 60);
}

/**
 * Which Claude Code session is answering here, and is it warm?
 *
 * The id is the actionable part: it is what `claude --resume <id>` takes, so the
 * same conversation can be opened at the desk — the shim's sessions outlive the
 * bot and are plain Claude Code sessions, not something only this process can
 * read. `live` distinguishes an id that answers immediately from one that pays a
 * cold spawn on its next turn.
 *
 * Backends without a `/sessions` route (any hosted model) simply say so. That is
 * the contract-agnostic rule showing up in the diagnostics: the bot may not
 * assume the endpoint is the shim.
 */
async function sessionLines(hereKey) {
  let sessions;
  try {
    ({ sessions = [] } = await listSessions());
  } catch {
    return ['🧠 sessions — endpoint has no `/sessions` route'];
  }
  if (!sessions.length) return ['🧠 sessions — none yet'];

  const show = (label, s) =>
    `   • ${label} \`${s.key}\` — \`${s.id}\`, ${s.live ? 'warm' : 'cold'}, ` +
    `${s.turns} turn(s), ${humanAge(s.age_minutes)}`;

  const lines = [`🧠 claude sessions — ${sessions.length} known`];
  const here = sessions.find((s) => s.key === hereKey);
  if (here) lines.push(show('here', here));
  // Said explicitly rather than omitted: a missing line reads as a fault, when
  // it only means this channel has not had a turn yet.
  else if (hereKey) lines.push(`   • here \`${hereKey}\` — none yet, the next turn opens one`);

  // The voice conversation is shown ALWAYS, not only while the bot is sitting in
  // a channel. It is the session most worth resuming — every spoken turn from
  // every channel lands in it, so it is the long one — and it outlives the visit
  // that created it. Gating it on being in voice pointed the reader at whatever
  // thin text session they happened to type from: on 2026-08-04 `status` in a
  // guild channel returned a 1-turn id, which was then resumed and found empty,
  // while the real 93-turn conversation went unmentioned.
  const spoken = sessions.find((s) => s.key === DEFAULT_SESSION_KEY);
  if (spoken && spoken.key !== hereKey) lines.push(show('voice', spoken));

  return lines;
}

async function report(client, hereKey) {
  const [s2sHost, s2sPort] = hostPort(config.s2sUrl);

  // With voice disabled, speech-to-speech is not probed at all — a red cross
  // against a service this instance was never meant to reach reads as a fault
  // and sends the reader looking for a broken thing that does not exist.
  const [shimUp, s2sUp] = await Promise.all([
    httpOk(`${config.baseUrl}/models`),
    config.voiceEnabled && s2sHost ? tcpOk(s2sHost, s2sPort) : Promise.resolve(false),
  ]);

  // Voice sessions this process owns. A ghost connection left by a crashed
  // process would not appear here, which is itself worth knowing.
  const sessions = [...voice.sessions.entries()].map(([guildId, s]) => {
    const g = client.guilds.cache.get(guildId);
    // An unbound key is the one failure a live call cannot show you: it answers
    // normally, into another server's conversation.
    const unbound = s.voiceKeyBound === false ? ' ⚠️ session key NOT bound' : '';
    return `${g?.name ?? guildId}${s.transcript ? ' (transcribing)' : ''}${unbound}`;
  });

  let transcriptOk = false;
  try {
    fs.accessSync(config.transcriptDir, fs.constants.W_OK);
    transcriptOk = true;
  } catch {
    transcriptOk = false;
  }

  const ping = Math.round(client.ws.ping);
  const claude = shimUp ? await sessionLines(hereKey) : [];
  return [
    `**${client.user.tag}** — up ${humanUptime(process.uptime())}, build \`${config.build.version}\``,
    `${tick(ping >= 0)} gateway — ${ping} ms, ${client.guilds.cache.size} guild(s)`,
    `${tick(shimUp)} endpoint — ${config.baseUrl} (${config.model})`,
    ...claude,
    config.voiceEnabled
      ? `${tick(s2sUp)} speech-to-speech — ${config.s2sUrl}`
      : '🚫 voice — disabled on this instance (VOICE_ENABLED=false), text only',
    `${tick(transcriptOk)} transcripts — ${transcriptOk ? 'writable' : 'NOT writable'}`,
    ...(config.voiceEnabled
      ? [sessions.length ? `🎙️ in voice — ${sessions.join(', ')}` : '🔇 not in a voice channel']
      : []),
    `👤 allowlist — ${config.allowedUserIds.length} user(s)`,
  ].join('\n');
}

module.exports = { report };
