'use strict';

const { resetSession, listSessions, bindSession, availableSessions } = require('./llm');
const { DEFAULT_SESSION_KEY } = require('./llm');
const log = require('./log');

/**
 * Session commands, shared by both transports.
 *
 * The bodies live here rather than in the slash handler because slash commands
 * are interactions and interactions are a separate Discord subsystem — during
 * the 2026-08-04 outage every one was dropped while messages flowed. Anything
 * worth doing is worth being able to type.
 */

const DISCORD_LIMIT = 2000;
const clip = (s) => (s.length > DISCORD_LIMIT ? `${s.slice(0, DISCORD_LIMIT - 3)}...` : s);

function age(minutes) {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.round(minutes / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** Start a fresh conversation here. The old session is left on disk, not deleted. */
async function newSession(key) {
  try {
    const r = await resetSession(key);
    log.info('session reset', { key, previous: r.previous || null });
    // The old id is quoted deliberately: "fresh start" reads as destruction, and
    // this is the one line that shows the previous conversation still exists.
    return r.previous
      ? `Fresh start here. The previous session is still on disk — \`switch ${r.previous}\` returns to it.`
      : 'Fresh start here.';
  } catch (e) {
    return `Could not reset: ${e.message}`;
  }
}

/** What is bound where, and what could be switched to. */
async function sessionsList(hereKey) {
  const out = [];
  const boundTo = new Map();
  try {
    const { sessions = [] } = await listSessions();
    for (const s of sessions) boundTo.set(s.id, s.key);
    const show = (label, s) =>
      `• ${label} \`${s.key}\` — \`${s.id}\`, ${s.live ? 'warm' : 'cold'}, ${s.turns} turn(s)`;
    const here = sessions.find((s) => s.key === hereKey);
    const voice = sessions.find((s) => s.key === DEFAULT_SESSION_KEY);
    out.push('**Bound now**');
    if (here) out.push(show('here', here));
    else out.push(`• here \`${hereKey}\` — none yet`);
    if (voice && voice.key !== hereKey) out.push(show('voice', voice));
  } catch (e) {
    return `Could not list sessions: ${e.message}`;
  }

  try {
    const { available = [] } = await availableSessions();
    if (available.length) {
      out.push('', '**Switch to** — `switch <id>`');
      for (const a of available.slice(0, 8)) {
        const label = a.label ? ` — "${a.label}"` : '';
        // Marked rather than hidden: switching to a taken id is refused, so
        // offering it unannotated invites a failure. Seeing WHERE a session
        // already lives is also the answer to "which one is the voice one".
        const taken = boundTo.get(a.id);
        const note = taken ? ` — **already \`${taken}\`**` : '';
        out.push(`• \`${a.id}\`${label} — ${a.turns} turn(s), ${age(a.age_minutes)} ago${note}`);
      }
    }
  } catch {
    // An endpoint without the route is fine; the bound list above still stands.
  }
  return clip(out.join('\n'));
}

/** Point this conversation at an existing session. */
async function switchSession(key, id) {
  const clean = (id ?? '').trim().replace(/^`|`$/g, '');
  if (!clean) return 'Give me a session id — `sessions` lists them.';
  try {
    const r = await bindSession(key, clean);
    log.info('session switched', { key, id: clean, previous: r.previous || null });
    return `This conversation now continues \`${clean}\`. Its history is already there — say something to pick it up.`;
  } catch (e) {
    // The shim refuses an id with no transcript, and one already bound
    // elsewhere. Both messages name the reason, so pass them through.
    return `Could not switch: ${e.message}`;
  }
}

module.exports = { newSession, sessionsList, switchSession };
