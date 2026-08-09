'use strict';

const config = require('./config');
const log = require('./log');
const { chat, sessionKeyFor } = require('./llm');
const voice = require('./voice');
const { chunk, DISCORD_LIMIT } = require('./discord-chunk');

/** Rebuild conversation history from the channel itself — no local state to lose. */
async function history(channel, botId) {
  const fetched = await channel.messages.fetch({ limit: config.historyLimit });
  return [...fetched.values()]
    .reverse()
    .filter((m) => m.content && (m.author.id === botId || config.isAllowed(m.author.id)))
    .map((m) => ({ role: m.author.id === botId ? 'assistant' : 'user', content: m.content }));
}

/**
 * Which voice channel is this user in, anywhere the bot can see?
 *
 * A DM carries no guild, so `msg.member` is null and the voice state has to be
 * looked up across guilds. The cache is usually warm from GuildVoiceStates;
 * the fetch is the fallback for a member the bot has not seen speak yet.
 */
async function voiceChannelOf(client, userId) {
  for (const [, guild] of client.guilds.cache) {
    const member =
      guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
    if (member?.voice?.channel) return member.voice.channel;
  }
  return null;
}

/** `join` / `leave` typed as a message — same effect as the slash command. */
async function handleVoiceCommand(msg, client, cmd) {
  const voice = require('./voice');
  if (cmd === 'leave') {
    const guildId = msg.guild?.id ?? [...client.guilds.cache.keys()][0];
    const left = guildId ? voice.leave(guildId) : false;
    log.info('voice command via text', { cmd, ok: left });
    return msg.reply(left ? 'Left the voice channel.' : 'I am not in a voice channel.');
  }

  const channel = msg.member?.voice?.channel ?? (await voiceChannelOf(client, msg.author.id));
  if (!channel) {
    return msg.reply('Join a voice channel first, then say join.');
  }
  try {
    const session = await voice.join(channel);
    log.info('voice command via text', { cmd, channel: channel.name });
    await msg.reply(`Listening in ${channel.name}.`);
    if (session?.transcript && config.announceTranscription) {
      await channel
        .send(`🎙️ Transcribing **${channel.name}** — every speaker is written down.`)
        .catch(() => {});
    }
  } catch (e) {
    log.error('voice join via text failed', { error: e.message });
    await msg.reply(`Could not join: ${e.message}`);
  }
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

/**
 * Keep Discord's "…is typing" dots alive in the channel while a typed turn is
 * being answered aloud.
 *
 * The spoken path gives its own progress signal — a filler within a second,
 * and the bot's speaking ring — but someone WATCHING THE CHAT sees nothing at
 * all until the written copy lands, which reads as "my message was ignored".
 * The text path has always shown the dots; routing into voice silently dropped
 * them, and the inconsistency is the complaint, not the wait.
 *
 * Self-terminating three ways, because an indicator nobody clears is worse
 * than none: the call's own `inResponse` going false (the normal end), the
 * chat-bridge post arriving (Discord clears the dots when a message is sent),
 * and a hard cap for a response that never reports finishing. Fire-and-forget
 * — the caller must not await this, or a typed turn would block until the
 * answer completes.
 */
const TYPING_TICK_MS = 8000; // Discord's indicator lapses after ~10s
const TYPING_MAX_MS = 5 * 60 * 1000;

function showTypingWhileAnswering(target, session) {
  target.sendTyping().catch(() => {});
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (!session.inResponse || session.closed || Date.now() - startedAt > TYPING_MAX_MS) {
      clearInterval(timer);
      return;
    }
    target.sendTyping().catch(() => {});
  }, TYPING_TICK_MS);
  // Never hold the process open for a cosmetic indicator.
  timer.unref?.();
  return timer;
}

function register(client) {
  client.on('messageCreate', async (msg) => {
    // Logged before any filtering, as a liveness probe for the gateway itself:
    // when slash commands hang with nothing arriving, the question is whether
    // ANY event is being delivered or only interactions are broken. Without
    // this, a message that gets filtered out looks identical to a dead socket.
    log.debug('message seen', {
      dm: !msg.guild,
      author: msg.author?.tag ?? null,
      bot: Boolean(msg.author?.bot),
    });

    // Anything written in a voice channel's own text chat goes into that
    // channel's transcript, alongside what was said aloud. One record for the
    // conversation rather than two half-records — which is what makes "have a
    // look at the link I just posted" answerable: the link is in the file the
    // session already reads, in chronological place among the speech.
    //
    // Everyone is captured, matching the audio side: who may DRIVE the bot is
    // the allowlist's business, who gets WRITTEN DOWN is the transcript's.
    if (!msg.author.bot && msg.content) {
      const transcript = voice.transcriptFor(msg.guild?.id, msg.channel?.id);
      if (transcript) {
        // Marked, because the two have different reliability: a spoken line is
        // STT output and can be wrong — real speech once became "when they have
        // something that's the young job" — while a typed line is exact. A
        // reader deciding whether to act on a pasted path or URL needs to know
        // which it is holding.
        transcript.writeText(
          msg.member?.displayName ?? msg.author.username,
          `(typed) ${msg.content}`,
        );
        log.debug('transcript: text captured', { author: msg.author.tag });
      }
    }

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

    // Voice control over text as well as slash commands. Slash commands are
    // delivered as INTERACTIONS, a separate Discord subsystem from messages —
    // during an API outage on 2026-08-04 the gateway stayed up and messages flowed
    // normally while every interaction was silently dropped, so `/join` hung with
    // no way to start voice at all. Two transports for the same action removes
    // that single point of failure, and typing "join" is no worse than the slash
    // command anyway.
    // The reply stays in the channel rather than opening a thread, so the key is
    // the one this channel/DM already answers on — not a new one.
    const hereKey = sessionKeyFor(msg.channel, msg.author.id);

    const cmd = content.match(/^\/?\s*(join|leave|status|selfcheck|new|sessions)\s*$/i);
    if (cmd) {
      const name = cmd[1].toLowerCase();
      if (name === 'status' || name === 'selfcheck') {
        const { report } = require('./status');
        return msg.reply(await report(client, hereKey));
      }
      if (name === 'new' || name === 'sessions') {
        const { newSession, sessionsList } = require('./commands');
        return msg.reply(name === 'new' ? await newSession(hereKey) : await sessionsList(hereKey));
      }
      return handleVoiceCommand(msg, client, name);
    }

    // `switch <id>` takes an argument, so it cannot join the bare-word set. The
    // id shape is required in the pattern: "switch to the other approach" is a
    // sentence for Claude, not a command.
    const sw = content.match(/^\/?\s*switch\s+`?([0-9a-f-]{8,36})`?\s*$/i);
    if (sw) {
      const { switchSession } = require('./commands');
      return msg.reply(await switchSession(hereKey, sw[1]));
    }

    let target = msg.channel;
    try {
      target = await conversationChannel(msg, client.user.id);

      // A typed turn landing in the text chat of a channel with a LIVE call
      // is answered ALOUD, not in text: push it into the s2s socket the call
      // already holds and let the existing playback path speak the reply.
      // The rule is deliberately simple and content-blind — "this channel is
      // a live call right now" — so the medium never depends on how the
      // question was phrased (see the "predictable" success criterion on
      // [[Typed messages cannot be answered aloud]]). Everywhere else (DM,
      // thread, guild channel with no live call) keeps answering in text,
      // exactly as before.
      const liveCall = voice.liveSessionFor(msg.guild?.id, target.id);
      if (liveCall) {
        const result = await liveCall.speak(content);
        if (result.ok) {
          log.info('text: typed turn routed into live call for a spoken reply', {
            channel: target.id,
          });
          showTypingWhileAnswering(target, liveCall);
          return;
        }
        log.warn('text: could not speak typed turn, answering nothing', {
          channel: target.id,
          reason: result.reason,
        });
        // Recorded so a reader of the transcript sees why a typed line has no
        // answer following it, rather than assuming it was ignored.
        liveCall.transcript?.writeText(config.botName, `(voice reply failed: ${result.reason})`);
        await target
          .send(`Could not speak that right now (${result.reason}). Try again in a moment.`)
          .catch(() => {});
        return;
      }

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

      // A message typed during a live call is answered in the channel, but
      // that reply was never recorded — only the QUESTION side is captured
      // above, so the transcript of a call read one-sided. `target` is the
      // voice channel itself when this is voice's text chat (it has no
      // threads, see conversationChannel), so its id matches the live
      // session's channelId.
      const replyTranscript = voice.transcriptFor(msg.guild?.id, target.id);
      if (replyTranscript) replyTranscript.writeText(config.botName, answer);
    } catch (e) {
      log.error('text error', { error: e.message });
      await target
        .send(`error talking to the endpoint: ${e.message}`.slice(0, DISCORD_LIMIT))
        .catch(() => {});
    }
  });
}

// showTypingWhileAnswering is exported for its unit test: it is a timer over a
// session flag, with no Discord or audio dependency, so a fake channel and a
// fake session exercise it fully.
module.exports = { register, chunk, showTypingWhileAnswering };
