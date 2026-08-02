'use strict';

const config = require('./config');
const log = require('./log');
const { chat, sessionKeyFor } = require('./llm');

const DISCORD_LIMIT = 2000;

function chunk(text) {
  const out = [];
  let rest = text;
  while (rest.length > DISCORD_LIMIT) {
    // Prefer a line break, then a space, before hard-cutting.
    let cut = rest.lastIndexOf('\n', DISCORD_LIMIT);
    if (cut < DISCORD_LIMIT / 2) cut = rest.lastIndexOf(' ', DISCORD_LIMIT);
    if (cut < DISCORD_LIMIT / 2) cut = DISCORD_LIMIT;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** Rebuild conversation history from the channel itself — no local state to lose. */
async function history(channel, botId) {
  const fetched = await channel.messages.fetch({ limit: config.historyLimit });
  return [...fetched.values()]
    .reverse()
    .filter((m) => m.content && (m.author.id === botId || config.isAllowed(m.author.id)))
    .map((m) => ({ role: m.author.id === botId ? 'assistant' : 'user', content: m.content }));
}

/** A thread this bot started — messages in it are turns, no mention needed. */
function isOwnThread(channel, botId) {
  return Boolean(channel?.isThread?.() && channel.ownerId === botId);
}

/**
 * Where the answer goes.
 *
 * In a guild channel, the first mention opens a thread and everything after
 * lives there: the channel stays clean, follow-ups need no `@`, and history
 * fetches are naturally scoped to the conversation instead of to whatever else
 * the channel was discussing.
 *
 * DMs are returned as-is — Discord has no threads in DMs.
 */
async function conversationChannel(msg, botId) {
  if (!msg.guild) return msg.channel;
  if (isOwnThread(msg.channel, botId)) return msg.channel;
  if (!msg.channel.threads) return msg.channel; // e.g. already a forum post
  try {
    return await msg.startThread({
      name:
        msg.content
          .replace(/<@!?\d+>/g, '')
          .trim()
          .slice(0, 90) || 'assistant',
      autoArchiveDuration: 1440,
    });
  } catch (e) {
    // Missing Create Threads permission is not worth losing the answer over.
    log.warn('could not start thread, replying in channel', { error: e.message });
    return msg.channel;
  }
}

function register(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    // Answer DMs, mentions in a guild, and anything inside a thread we opened.
    const isDM = !msg.guild;
    const mentioned = msg.mentions.users.has(client.user.id);
    const inOwnThread = isOwnThread(msg.channel, client.user.id);
    if (!isDM && !mentioned && !inOwnThread) return;

    if (!config.isAllowed(msg.author.id)) {
      log.warn('text message dropped', { user: msg.author.tag, id: msg.author.id });
      return;
    }

    const content = msg.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    if (!content) return;
    log.info('text in', { user: msg.author.tag, content: content.slice(0, 80) });

    let target = msg.channel;
    try {
      target = await conversationChannel(msg, client.user.id);
      await target.sendTyping();
      const typing = setInterval(() => target.sendTyping().catch(() => {}), 8000);

      // Read history from the thread, not the parent channel — that is the
      // point of threading. A brand-new thread has none, so fall back to the
      // message itself.
      const messages = await history(target, client.user.id).catch(() => []);
      if (messages.at(-1)?.content !== content) messages.push({ role: 'user', content });

      // Key the conversation to the thread/DM/channel so separate threads get
      // separate sessions and can run at the same time.
      const sessionKey = sessionKeyFor(target, msg.author.id);

      let answer;
      try {
        answer = await chat(messages, { sessionKey });
      } finally {
        clearInterval(typing);
      }

      log.info('text out', { chars: answer.length, preview: answer.slice(0, 80) });
      for (const part of chunk(answer)) await target.send(part);
    } catch (e) {
      log.error('text error', { error: e.message });
      await target
        .send(`error talking to the endpoint: ${e.message}`.slice(0, DISCORD_LIMIT))
        .catch(() => {});
    }
  });
}

module.exports = { register, chunk };
