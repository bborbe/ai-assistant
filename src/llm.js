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
    if (res.ok) return { ok: true };
    // 404 means the backend has no such route — a stateless endpoint like
    // MiniMax, which keys nothing and cannot mis-route. Not a failure to warn
    // about, and telling it apart matters: the bot may not depend on which
    // backend sits behind OPENAI_BASE_URL, so an unsupported route must degrade
    // to the old single-conversation behaviour rather than break voice.
    if (res.status === 404) return { ok: false, unsupported: true };
    return { ok: false, error: `endpoint ${res.status}` };
  } catch (e) {
    // Transient and retryable — the endpoint is unreachable right now. Returned
    // rather than swallowed: silence here means spoken turns land in whatever
    // conversation was bound last, which may be another server's.
    return { ok: false, error: e.message, retryable: true };
  }
}

/**
 * Tell the endpoint whether the operator is the only human in the call.
 *
 * Sticky like `bindVoiceKey`, not one-shot like `markTypedTurn`: it describes a
 * standing state of the room, so it is sent when the room CHANGES, never per
 * turn. The bot is the only side that can see who is in the voice channel; the
 * shim is the only side that runs the wake gate.
 *
 * `sessionKey` names which conversation this solo state belongs to — the
 * same key `bindVoiceKey` uses (`voice:<guildId>` or `voice:<guildId>:<identity>`).
 * The shim keys solo state by it, so a private call's `solo=True` cannot leak
 * into a team channel that joined later (the 2026-08-18 Brogrammers incident
 * before per-key state existed).
 *
 * Failure degrades toward the gate staying armed, which is the direction that
 * cannot surprise anyone: an unreached endpoint keeps demanding the wake phrase
 * rather than answering every sentence in a room it can no longer see.
 */
async function setVoiceSolo(solo, sessionKey) {
  try {
    const res = await fetch(`${config.baseUrl}/voice/solo`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'X-Voice-Solo': solo ? 'true' : 'false',
        'X-Session-Key': sessionKey,
      },
    });
    if (res.ok) return { ok: true };
    if (res.status === 404) return { ok: false, unsupported: true };
    return { ok: false, error: `endpoint ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.message, retryable: true };
  }
}

/**
 * Set the runtime wake-phrase override for a voice key. `null` clears it.
 *
 * Same shape and same degrade contract as `setVoiceSolo` above: a 404 means the
 * backend predates the route, and the caller treats that as "gate stays as it
 * was" rather than as a failure to retry.
 *
 * Authenticated with the chat-bridge token, not `config.apiKey`: this route is
 * the admin surface (the shim refuses it otherwise), and the token is the one
 * the bot and shim use to authenticate to each other — see src/health.js,
 * which validates the shim's posts against the same value.
 */
async function setVoiceWake(value, sessionKey) {
  // `auto` is the CLEAR, not a third boolean — it removes the override so the
  // shim falls back to its VOICE_ALWAYS_WAKE default.
  const mode = value === null ? 'auto' : value ? 'on' : 'off';
  try {
    const res = await fetch(`${config.baseUrl}/voice/wake`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.chatBridgeToken}`,
        'X-Voice-Wake': mode,
        'X-Session-Key': sessionKey,
      },
    });
    if (res.ok) return { ok: true };
    if (res.status === 404) return { ok: false, unsupported: true };
    return { ok: false, error: `endpoint ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.message, retryable: true };
  }
}

/** Ask the backend to forget a conversation. Backends without the route say so. */
async function resetSession(sessionKey) {
  const res = await fetch(`${config.baseUrl}/sessions/reset`, {
    method: 'POST',
    headers: {
      'X-Session-Key': sessionKey,
      Authorization: `Bearer ${config.apiKey}`,
    },
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
 * When this process has `IDENTITY` set, the guild/channel/user id is not
 * enough on its own — see `voiceKeyFor` and `textKeyFor` for why the
 * identity rides along in the key too, on EVERY surface, not just voice.
 *
 * Clearing a session is only safe because anything worth keeping is written to
 * the vault — see the shim's MEMORY_DIRECTIVE. The session is a cache; the
 * vault is the record.
 */
function sessionKeyFor(channel, userId) {
  if (channel?.isThread?.()) return textKeyFor('thread', channel.id);
  if (!channel?.guild) return textKeyFor('dm', userId);
  if (channel?.isVoiceBased?.()) return voiceKeyFor(channel.guild.id);
  return textKeyFor('channel', channel.id);
}

/**
 * The conversation spoken turns in `guildId` belong to.
 *
 * Persona and session sit on DIFFERENT axes and this key has to carry both.
 * Session (which conversation) is per (guild, identity) — two identities in
 * one guild must not collide, and one identity across two guilds must not
 * share history it should not have. Persona (which cwd/vault/launcher) is
 * per identity alone, resolved by the shim from this same key.
 *
 * With `config.identity` unset this reproduces the pre-existing
 * `voice:<guildId>` key exactly — a single-identity deployment (or any bot
 * built before `IDENTITY` existed) needs no config change. Set, it becomes
 * `voice:<guildId>:<identity>`, which is what lets the shim resolve persona
 * by IDENTITY instead of by guild — see `identity_for()` in the shim.
 */
function voiceKeyFor(guildId) {
  if (!guildId) return DEFAULT_SESSION_KEY;
  return config.identity ? `voice:${guildId}:${config.identity}` : `voice:${guildId}`;
}

/**
 * The conversation a text turn on `prefix:<id>` belongs to.
 *
 * A header was tried here first and dropped: multiple Discord identities can
 * share one guild (three bots in the same server, confirmed in production),
 * so two identities in the SAME channel/thread/DM produce the IDENTICAL
 * `thread:`/`channel:`/`dm:` key. A header fixes which persona a process
 * spawns WITH, but not which session it resumes — the shim's session store
 * is keyed by the string alone, so a header-only fix would have one identity
 * resume the conversation another was holding, then spawn it under the
 * wrong cwd. Only the key can separate the sessions AND pick the persona at
 * once, which is exactly what `voiceKeyFor` already relies on for voice —
 * this mirrors it for every surface the bot itself owns `X-Session-Key` for.
 *
 * With `config.identity` unset this reproduces the pre-existing
 * `<prefix>:<id>` key exactly — an existing single-identity deployment needs
 * no config change and keeps resuming its existing sessions. Set, it becomes
 * `<prefix>:<id>:<identity>`, a NEW session: an existing 2-segment session on
 * disk stays reachable for a bot with no `IDENTITY` set, but a bot that
 * gains `IDENTITY` starts fresh conversations rather than silently adopting
 * whatever the 2-segment key already held. That is intended, not a bug —
 * see `identity_for()` in the shim.
 */
function textKeyFor(prefix, id) {
  return config.identity ? `${prefix}:${id}:${config.identity}` : `${prefix}:${id}`;
}

module.exports = {
  chat,
  markTypedTurn,
  resetSession,
  listSessions,
  bindSession,
  bindVoiceKey,
  setVoiceSolo,
  setVoiceWake,
  availableSessions,
  sessionKeyFor,
  voiceKeyFor,
  DEFAULT_SESSION_KEY,
};
