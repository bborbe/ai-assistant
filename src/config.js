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

  // Must stay below the pod's terminationGracePeriodSeconds.
  shutdownTimeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '10000', 10),

  build: {
    version: process.env.BUILD_GIT_VERSION || 'dev',
    commit: process.env.BUILD_GIT_COMMIT || 'none',
    date: process.env.BUILD_DATE || 'unknown',
  },
};

config.isAllowed = (userId) => config.allowedUserIds.includes(userId);

config.check = () => {
  const problems = [];
  if (!config.discordToken) problems.push('DISCORD_TOKEN is not set');
  if (!config.allowedUserIds.length) {
    problems.push('ALLOWED_USER_IDS is empty — nobody could talk to the bot');
  }
  return problems;
};

module.exports = config;
