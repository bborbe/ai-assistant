'use strict';

function list(v) {
  return (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  discordToken: process.env.DISCORD_TOKEN,

  // The swappable endpoint. MiniMax today, the Claude Code shim next —
  // the bot must not care which, so nothing here is backend-specific.
  baseUrl: (process.env.OPENAI_BASE_URL || 'http://127.0.0.1:8080/v1').replace(/\/$/, ''),
  apiKey: process.env.OPENAI_API_KEY || 'not-needed',
  model: process.env.OPENAI_MODEL || 'claude-code',

  s2sUrl: process.env.S2S_URL || 'ws://127.0.0.1:8765/v1/realtime',

  // Sender-level allowlist, applied to BOTH surfaces. Empty = nobody, on
  // purpose: this bot can reach a Claude Code session with vault and repo
  // access, so failing closed is the only safe default.
  allowedUserIds: list(process.env.ALLOWED_USER_IDS),

  // How many prior messages a text thread resends. The endpoint may be
  // stateless (MiniMax uses this) or stateful (the shim discards it) — we
  // send it either way and let the server decide.
  historyLimit: parseInt(process.env.HISTORY_LIMIT || '20', 10),

  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  // Transcription of EVERY speaker in the channel, not just the allowlist.
  // Deliberately separate from the command path: the allowlist controls who can
  // *drive* the bot, this controls who gets *written down*. Recording other
  // people is a consent matter wherever that is not obviously fine.
  transcribe: process.env.TRANSCRIBE !== '0',
  // Set TRANSCRIPT_DIR in local.env. It belongs somewhere the shim can READ —
  // Claude Code runs with cwd in the vault and no --add-dir, so a path outside
  // it cannot be read mid-call, and "what did we just discuss?" would fail.
  // Defaults to a repo-local dir so a fresh clone never writes into a vault it
  // was not told about.
  transcriptDir: process.env.TRANSCRIPT_DIR || `${__dirname}/../transcripts`,
  // How the bot labels itself in transcripts.
  botName: process.env.BOT_NAME || 'Assistant',
  // Announce in-channel on join, so recording is never silent.
  announceTranscription: process.env.ANNOUNCE_TRANSCRIPTION !== '0',

  // Health/readiness endpoints, so this runs as a normal k8s workload.
  healthHost: process.env.HEALTH_HOST || '0.0.0.0',
  healthPort: parseInt(process.env.HEALTH_PORT || '8080', 10),

  // Shared secret for the shim's POST /chat back-edge (health.js). Both
  // processes read the SAME env var name — a mismatch between a bot-side and
  // shim-side name is exactly the class of bug that loses a secret silently.
  // Empty means the route refuses every request (fails closed).
  chatBridgeToken: (process.env.CHAT_BRIDGE_TOKEN || '').trim(),

  // How long a speaker must stay silent before their utterance is considered
  // finished. Discord's `speaking.end` fires on brief pauses inside a sentence,
  // so without this a single sentence arrives as several utterances.
  utteranceGapMs: parseInt(process.env.UTTERANCE_GAP_MS || '1500', 10),

  // Wake phrases, comma-separated — a COPY of the endpoint's list, used only to
  // decide whether to raise the "…is typing" indicator and to arm the busy
  // gate. The endpoint remains the authority on whether a turn is answered;
  // this side has to know too because it reacts to the utterance seconds before
  // the endpoint has ruled on it, and showing dots for speech that will never
  // be answered is exactly the bug this fixes.
  //
  // If the two lists drift the cost is cosmetic — dots without an answer, or an
  // answer that arrived without dots — never a wrong answer.
  // The surrounding-quote strip is not cosmetic: `-include local.env` in the
  // Makefile parses with MAKE semantics, so `export X="a,b"` arrives with the
  // quote characters still in the value and the first phrase becomes `"hey bot`
  // — which matches nothing anyone says. Same family as the `$HOME` and
  // secret-in-argv traps this repo has already been bitten by twice.
  wakePhrases: (process.env.SHIM_WAKE_PHRASES ?? 'hey bot,hey bought,hey but')
    .replace(/^["']|["']$/g, '')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean),

  // Must stay below the pod's terminationGracePeriodSeconds.
  shutdownTimeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '10000', 10),

  // How long Session.speak() waits for the s2s server to ack (or refuse) a
  // typed turn pushed in as conversation.item.create + response.create
  // before giving up and reporting 'timeout'.
  speakAckTimeoutMs: parseInt(process.env.SPEAK_ACK_TIMEOUT_MS || '5000', 10),

  build: {
    version: process.env.BUILD_GIT_VERSION || 'dev',
    commit: process.env.BUILD_GIT_COMMIT || 'none',
    date: process.env.BUILD_DATE || 'unknown',
  },
};

config.isAllowed = (userId) => config.allowedUserIds.includes(userId);

/**
 * Does this utterance open with a wake phrase? Mirrors the endpoint's rule —
 * prefix match, case-insensitive, leading punctuation ignored. An empty list
 * means the gate is off, so everything counts as addressed.
 */
config.isAddressed = (text) => {
  if (!config.wakePhrases.length) return true;
  const t = String(text || '')
    .replace(/^\W+/, '')
    .toLowerCase();
  return config.wakePhrases.some((p) => t.startsWith(p));
};

config.check = () => {
  const problems = [];
  if (!config.discordToken) problems.push('DISCORD_TOKEN is not set');
  if (!config.allowedUserIds.length) {
    problems.push('ALLOWED_USER_IDS is empty — nobody could talk to the bot');
  }
  return problems;
};

module.exports = config;
