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
      // Stated rather than inferred. A voice channel's text chat shares the
      // SPOKEN session, so the key can no longer tell the shim which kind of
      // output this turn wants — only the transport knows, and this is it.
      'X-Output-Mode': 'text',
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

/**
 * Tell the endpoint that the next turn on this key came from the KEYBOARD.
 *
 * A typed turn reaches the endpoint through speech-to-speech looking exactly
 * like a spoken one — that indistinguishability is what lets one pipeline
 * answer both, and it is also why the endpoint cannot work out on its own that
 * the answer should also be written down. Hence out of band, immediately
 * before the turn.
 *
 * Best-effort by design: a backend without the route, or an endpoint that is
 * momentarily unreachable, must never stop the user being answered aloud. The
 * cost of failure is one missing written copy, not a missing reply.
 */
async function markTypedTurn(sessionKey, typed = true) {
  try {
    const res = await fetch(`${config.baseUrl}/turns/typed`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(sessionKey ? { 'X-Session-Key': sessionKey } : {}),
        'X-Turn-Typed': typed ? 'true' : 'false',
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Tell the endpoint which conversation spoken turns belong to from now on.
 *
 * speech-to-speech owns the HTTP call to the endpoint and cannot set
 * `X-Session-Key`, so the endpoint would otherwise put every spoken turn — from
 * any server — into one conversation. This is the only way it can be told which
 * one, and it must be sent BEFORE the first utterance of a call.
 *
 * Unlike `markTypedTurn`, failure here is not cosmetic: the call still works,
 * but it lands in whichever conversation was bound last, which may be another
 * server's. Callers log it rather than swallow it.
 */
async function bindVoiceKey(sessionKey) {
  try {
    const res = await fetch(`${config.baseUrl}/voice/bind`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'X-Session-Key': sessionKey,
      },
    });
    return res.ok;
  } catch {
    return false;
  }
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

/** Point this conversation at an existing session. The shim validates and may refuse. */
async function bindSession(sessionKey, id) {
  const res = await fetch(`${config.baseUrl}/sessions/bind`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Key': sessionKey,
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ id }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `endpoint ${res.status}`);
  return data;
}

/** Transcripts on disk that a conversation could be switched to. */
async function availableSessions() {
  const res = await fetch(`${config.baseUrl}/sessions/available`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
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
 * The key a request carries when it sends none — voice, which reaches the
 * endpoint through speech-to-speech and cannot set headers. Mirrors the shim's
 * own `DEFAULT_KEY`; kept here so `status` can name the voice conversation
 * rather than printing a bare "default" the reader has to decode.
 */
const DEFAULT_SESSION_KEY = 'default';

/**
 * One conversation per thread, per DM, per channel — and **one per voice
 * channel, shared with what is spoken in it**.
 *
 * A voice channel's integrated text chat is a normal text channel as far as
 * Discord is concerned, so it would otherwise get its own `channel:<id>`
 * session: you could paste a link during a call and the voice conversation
 * would never see it, because it is a different Claude Code session. Mapping it
 * to the same key speech uses makes the call ONE conversation regardless of
 * whether a turn was spoken or typed.
 *
 * It also makes the session commands reach voice at all. They derive their key
 * from the channel they are typed in, so before this, `switch` and `new` in a
 * voice channel operated on a `channel:` session nothing was using, and the
 * spoken conversation was unmanageable from Discord.
 *
 * Voice is keyed per GUILD, not per channel and no longer globally. Two voice
 * channels in one server still share a conversation — speech-to-speech has no
 * notion of which channel a turn came from, so that part is unchanged — but two
 * SERVERS do not. Joining a call at work must not resume the personal
 * conversation; that is a boundary between contexts, not a preference.
 *
 * Guild rather than channel because guild is the coarsest thing s2s can be told
 * about out of band (see `bindVoiceKey`) and the finest that is actually true:
 * one call at a time, and moving between channels in the same server is
 * continuing the same conversation.
 *
 * Clearing a session is only safe because anything worth keeping is written to
 * the vault — see the shim's MEMORY_DIRECTIVE. The session is a cache; the
 * vault is the record.
 */
function sessionKeyFor(channel, userId) {
  if (channel?.isThread?.()) return `thread:${channel.id}`;
  if (!channel?.guild) return `dm:${userId}`;
  if (channel?.isVoiceBased?.()) return voiceKeyFor(channel.guild.id);
  return `channel:${channel.id}`;
}

/** The conversation spoken turns in `guildId` belong to. */
function voiceKeyFor(guildId) {
  return guildId ? `voice:${guildId}` : DEFAULT_SESSION_KEY;
}

module.exports = {
  chat,
  markTypedTurn,
  resetSession,
  listSessions,
  bindSession,
  bindVoiceKey,
  availableSessions,
  sessionKeyFor,
  voiceKeyFor,
  DEFAULT_SESSION_KEY,
};
