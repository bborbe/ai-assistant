'use strict';

const config = require('./config');

/**
 * Minimal OpenAI chat-completions client.
 *
 * Deliberately assumes NOTHING about server statefulness: it sends the full
 * message array as the spec requires. A stateless backend (MiniMax) uses that
 * history; a stateful one (the Claude Code shim) discards all but the newest
 * user message. Keeping the bot ignorant of which is what lets the backend be
 * swapped with only a base-URL change.
 *
 * `sessionKey` is an extra-spec hint. Backends that ignore it behave normally;
 * the shim uses it to give each conversation its own Claude Code session, so
 * two threads run concurrently instead of queueing behind one another.
 */
async function chat(messages, { sessionKey, signal } = {}) {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      ...(sessionKey ? { 'X-Session-Key': sessionKey } : {}),
    },
    body: JSON.stringify({ model: config.model, messages, stream: false }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`endpoint ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`no content in response: ${JSON.stringify(data).slice(0, 200)}`);
  return text.trim();
}

/** Ask the backend to forget a conversation. Backends without the route say so. */
async function resetSession(sessionKey) {
  const res = await fetch(`${config.baseUrl}/sessions/reset`, {
    method: 'POST',
    headers: { 'X-Session-Key': sessionKey, Authorization: `Bearer ${config.apiKey}` },
  });
  if (!res.ok) throw new Error(`endpoint ${res.status} — does it support sessions?`);
  return res.json();
}

async function listSessions() {
  const res = await fetch(`${config.baseUrl}/sessions`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!res.ok) throw new Error(`endpoint ${res.status} — does it support sessions?`);
  return res.json();
}

/**
 * One conversation per thread, per DM, per channel.
 *
 * Clearing a session is only safe because anything worth keeping is written to
 * the vault — see the shim's MEMORY_DIRECTIVE. The session is a cache; the
 * vault is the record.
 */
function sessionKeyFor(channel, userId) {
  if (channel?.isThread?.()) return `thread:${channel.id}`;
  if (!channel?.guild) return `dm:${userId}`;
  return `channel:${channel.id}`;
}

module.exports = { chat, resetSession, listSessions, sessionKeyFor };
