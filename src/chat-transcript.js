'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const log = require('./log');
const { slug } = require('./transcript');

/**
 * The transcript of a Google Chat conversation, written as it happens.
 *
 * The voice writer (`transcript.js`) exists to archive AUDIO and hand it to a
 * separate transcriber process, which is why it writes one WAV per utterance
 * and merges by filename. A Chat turn has no audio and no lag: both sides
 * arrive as text, in order, in the same call. So this writer appends one block
 * per turn and needs none of that machinery — but it keeps the voice writer's
 * on-disk shape, so a reader who knows one knows the other, and so the shim's
 * `TRANSCRIPT_DIRECTIVE` ("one folder per channel per day … in `transcript.md`")
 * describes a Chat conversation truthfully as well.
 *
 * Until this existed the Chat surface recorded NOTHING: `transcript.js` is
 * instantiated only inside a voice session (`voice.js`), and `gchat.js` touched
 * no filesystem at all. A Chat turn left its answer in the thread and nowhere
 * else, so evidence of a conversation had to be copied out by hand.
 */

/**
 * The `transcript.md` for one Chat conversation on one day.
 *
 * UTC throughout, for the same reason the voice writer is: folder date and the
 * timestamps inside must agree, or a turn just after local midnight lands in a
 * folder dated the previous day.
 */
function transcriptFile(spaceId, threadId) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(config.transcriptDir, `${slug(spaceId)}-${slug(threadId)}-${day}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'transcript.md');
}

/**
 * Append one turn — who asked, and what they got back.
 *
 * Speaker-then-text rather than a one-line `speaker: text` entry: a Chat answer
 * is markdown and routinely several paragraphs, and flattening it would either
 * lose the structure or make the entry unreadable. The next `## turn` heading
 * delimits it, so no indentation scheme is needed.
 *
 * Never throws. The answer is already in the thread by the time this runs, and
 * losing the record of a turn is not worth failing one that succeeded — the
 * same posture the voice writer takes on a failed segment write.
 *
 * Returns the file written, or null when nothing was written.
 */
function recordTurn({ spaceId, threadId, sender, question, answer }) {
  // `TRANSCRIBE` is the consent switch, not a formatting one — it decides who
  // gets WRITTEN DOWN, and it is deliberately separate from the allowlist that
  // decides who may DRIVE the bot. A Chat transcript is the same kind of
  // recording, so it answers to the same switch.
  if (!config.transcribe) return null;
  if (!String(answer ?? '').trim()) return null;

  try {
    const file = transcriptFile(spaceId, threadId);
    const at = new Date().toISOString();
    const block =
      `\n## turn ${at}\n\n` +
      `**${sender || 'unknown'}**\n\n${String(question ?? '').trim()}\n\n` +
      `**${config.assistantLabel}**\n\n${String(answer).trim()}\n`;
    fs.appendFileSync(file, block);
    log.info('chat transcript turn recorded', { file, sender });
    return file;
  } catch (e) {
    log.error('chat transcript write failed', { error: e.message });
    return null;
  }
}

module.exports = { recordTurn, transcriptFile };
