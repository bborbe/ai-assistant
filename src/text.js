'use strict';

const config = require('./config');
const log = require('./log');
const { chat } = require('./llm');

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

function register(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    // Answer DMs, and mentions in a guild — not every message in a channel.
    const isDM = !msg.guild;
    const mentioned = msg.mentions.users.has(client.user.id);
    if (!isDM && !mentioned) return;

    if (!config.isAllowed(msg.author.id)) {
      log.info(`  text: DROPPED ${msg.author.tag} (${msg.author.id}) — not allowlisted`);
      return;
    }

    const content = msg.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    if (!content) return;
    log.info(`  text <- ${msg.author.tag}: ${content.slice(0, 80)}`);

    try {
      await msg.channel.sendTyping();
      const typing = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);

      const messages = await history(msg.channel, client.user.id).catch(() => []);
      // The fetch above already includes this message; only append if it didn't.
      if (messages.at(-1)?.content !== content) messages.push({ role: 'user', content });

      let answer;
      try {
        answer = await chat(messages);
      } finally {
        clearInterval(typing);
      }

      log.info(`  text -> ${answer.slice(0, 80)}`);
      for (const part of chunk(answer)) await msg.reply(part);
    } catch (e) {
      log.error('  text error:', e.message);
      await msg
        .reply(`error talking to the endpoint: ${e.message}`.slice(0, DISCORD_LIMIT))
        .catch(() => {});
    }
  });
}

module.exports = { register, chunk };
