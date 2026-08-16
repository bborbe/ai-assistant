'use strict';

/**
 * Read a boolean env var the way people actually write them.
 *
 * `X=true` silently doing nothing because the code only tested for `"1"` is a
 * switch that looks set and isn't — worse than no switch, because it fails
 * quietly and in the safe-looking direction. So all of 1/true/yes/on and
 * 0/false/no/off are accepted, case-insensitively.
 *
 * Surrounding quotes are stripped for the same reason `wakePhrases` strips
 * them: the Makefile's `-include local.env` parses with MAKE semantics, so
 * `export X="1"` arrives as `"1"` with the quote characters still attached.
 */
function flag(raw, fallback) {
  const v = String(raw ?? '')
    .replace(/^["']|["']$/g, '')
    .trim()
    .toLowerCase();
  if (!v) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

// Noise that may sit between the start of a sentence and the wake phrase.
// Mirrors the endpoint's `_FILLER_WORDS` (plus "hey", for a doubled "hey hey
// bot"). Kept in sync by hand; a drift costs a missed trigger, never a false
// one, because this list only ever lets NOISE precede the phrase.
const WAKE_LEAD_WORDS = [
  'ah',
  'alright',
  'eh',
  'erm',
  'hey',
  'hm',
  'hmm',
  'mhm',
  'mm',
  'mmhmm',
  'mmm',
  'oh',
  'ooh',
  'ok',
  'okay',
  'right',
  'uh',
  'um',
  'yeah',
  'yep',
  'yup',
];

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

  // Which Discord identity this process IS — not which guild it serves.
  //
  // Persona belongs to the identity, not the guild: one identity can serve
  // several guilds and wants ONE persona across all of them, and two
  // identities can share a guild and must NOT collide on the same voice
  // session key. Unset (the default) reproduces `v0.16.0` exactly — the
  // voice key stays `voice:<guildId>` and the shim resolves persona from the
  // guild id, same as before this existed. Set it to a short name
  // (`personal`, `sc`, `boss`) that also appears as a key under `identities:`
  // in config.yaml.
  identity: (process.env.IDENTITY || '').trim(),

  // Is this instance capable of voice at all?
  //
  // Default true, so an existing deployment behaves identically with nothing
  // set. Set VOICE_ENABLED=0 for a text-only instance: `join`/`leave` are not
  // registered as slash commands, no socket is opened to S2S_URL, and `status`
  // says so plainly.
  //
  // The reason this exists is deployment, not preference: speech-to-speech
  // needs a GPU and the cluster has none on any node, so text-only is the only
  // shape that can run outside a laptop.
  //
  // Distinct from SKIP_VOICE in scripts/dev.sh, which only skips LAUNCHING
  // speech-to-speech locally and says nothing about what the bot advertises.
  voiceEnabled: flag(process.env.VOICE_ENABLED, true),

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
  transcribe: flag(process.env.TRANSCRIBE, true),
  // Set TRANSCRIPT_DIR in local.env. It belongs somewhere the shim can READ —
  // Claude Code runs with cwd in the vault and no --add-dir, so a path outside
  // it cannot be read mid-call, and "what did we just discuss?" would fail.
  // Defaults to a repo-local dir so a fresh clone never writes into a vault it
  // was not told about.
  transcriptDir: process.env.TRANSCRIPT_DIR || `${__dirname}/../transcripts`,
  // How the bot labels itself in transcripts.
  botName: process.env.BOT_NAME || 'Assistant',
  // Announce in-channel on join, so recording is never silent.
  announceTranscription: flag(process.env.ANNOUNCE_TRANSCRIPTION, true),

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

  // Should speaking while the assistant is answering CANCEL that answer?
  //
  // Off by default, which reverses speech-to-speech's own default. The cancel
  // fires on the VAD's `speech_started` — pure acoustics, before any words
  // exist — so "okay" and "stop, wrong question" are indistinguishable at the
  // moment the decision is made, and there is no threshold or content filter to
  // tune. Observed live: an acknowledgement nine seconds into a lookup threw the
  // answer away silently.
  //
  // Off costs little here because spoken replies are capped at SHIM_SPOKEN_MAX
  // sentences — there is rarely more than a few seconds of audio to interrupt.
  // Set INTERRUPT_RESPONSE to 1/true/yes/on for the talk-over-it behaviour.
  interruptResponse: flag(process.env.INTERRUPT_RESPONSE, false),

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
  wakePhrases: (process.env.SHIM_WAKE_PHRASES ?? 'hey bot,hey bought,hey but,hi bot')
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

  // How long a bot facing "slot already in use" keeps retrying — at the
  // existing 2s cadence, so roughly 5 attempts by default — before giving up
  // and leaving loudly.
  //
  // v0.19.0 shipped last-joiner-wins handover (ask the previous holder to
  // yield) AND "leave on the first refusal" in the same release, and they
  // raced: the loser's very first slot-in-use error can arrive while the
  // handover it triggered is still in flight, so it walked away from a slot
  // that was about to free. A bounded retry covers a yield round-trip
  // comfortably while a genuinely occupied slot still fails fast and visibly
  // — the infinite-retry bug this deadline's sibling behaviour fixed must not
  // come back, so this is a deadline, never unset.
  voiceSlotRetryDeadlineMs: parseInt(process.env.VOICE_SLOT_RETRY_DEADLINE_MS || '10000', 10),

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
  // Sentence-anchored, not utterance-anchored: speech-to-speech accumulates a
  // turn across progressive finals, so the phrase routinely lands mid-string
  // ("…disk space? Hey bot, can you check…"). Still anchored — the phrase must
  // OPEN a sentence, so "I told him the bot was broken" stays quiet.
  // Leading disfluencies are skipped: people open on a hesitation, not on the
  // wake phrase ("Uh hey bot, …"). Mirrors the endpoint's list; only noise may
  // precede the phrase, never a real word — "so, hey bot" still does not count.
  const t = String(text || '').toLowerCase();
  return config.wakePhrases.some((p) =>
    new RegExp(
      `(?:^|[.!?]\\s+|\\n)\\W*(?:(?:${WAKE_LEAD_WORDS.join('|')})[\\s,.!?-]+){0,3}` +
        `${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
    ).test(t),
  );
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
