'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const log = require('./log');

const RATE = 48000;
const CHANNELS = 2;

/**
 * Writes one WAV per utterance, per speaker.
 *
 * Deliberately decoupled from the voice loop: this only touches disk, and the
 * transcriber is a separate process watching the directory. If STT is slow,
 * crashes, or is not running at all, the conversation is unaffected and the
 * audio is still on disk to transcribe later.
 *
 * Per-speaker separation is free here — Discord gives one stream per SSRC — and
 * it is the expensive half of any diarization pipeline. Mixing first would
 * throw it away.
 */
function wavHeader(dataLen, rate = RATE, channels = CHANNELS, bits = 16) {
  const b = Buffer.alloc(44);
  const byteRate = (rate * channels * bits) / 8;
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE((channels * bits) / 8, 32);
  b.writeUInt16LE(bits, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataLen, 40);
  return b;
}

/** Filesystem-safe, and short enough to stay readable in a directory listing. */
function slug(name) {
  return (name || 'unknown')
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

class TranscriptSession {
  constructor(guildName, channelName) {
    // UTC throughout — folder date and the timestamps inside must agree, or a
    // session just after local midnight lands in a folder dated the previous
    // day. UTC is also stable across DST and travel, which local time is not.
    const day = new Date().toISOString().slice(0, 10);
    this.dir = path.join(config.transcriptDir, `${slug(guildName)}-${slug(channelName)}-${day}`);
    this.segments = path.join(this.dir, 'segments');
    fs.mkdirSync(this.segments, { recursive: true });

    // A stable id per join, so two sessions on the same day in the same channel
    // do not interleave in the transcript.
    this.startedAt = Date.now();
    fs.appendFileSync(
      path.join(this.dir, 'transcript.md'),
      `\n## session ${new Date(this.startedAt).toISOString()}\n\n`,
    );
    log.info('transcript session started', { dir: this.dir });
  }

  /**
   * Flush one speaker's utterance. `pcm` is 48 kHz stereo — written as captured,
   * with no resampling, so the archived audio stays the highest fidelity
   * available and the transcriber decides what it needs.
   */
  write(userId, displayName, pcm) {
    if (!pcm?.length) return null;
    // Sub-400ms fragments are almost always a click, a breath, or a backchannel
    // grunt. Transcribing them fills the transcript with "Yeah." lines that
    // make it harder to read than if they were dropped.
    const ms = (pcm.length / (RATE * CHANNELS * 2)) * 1000;
    if (ms < 400) return null;

    const file = path.join(this.segments, `${Date.now()}-${slug(displayName)}-${userId}.wav`);
    try {
      fs.writeFileSync(file, Buffer.concat([wavHeader(pcm.length), pcm]));
      return file;
    } catch (e) {
      log.error('transcript segment write failed', { error: e.message });
      return null;
    }
  }
}

/**
 * Record something already known as text — the bot's own replies.
 *
 * Written as a timestamped sidecar rather than appended straight to
 * transcript.md, so the transcriber merges it by the same filename-sort as the
 * audio segments. Appending directly would race: STT lags a couple of seconds,
 * so the reply would often land *above* the question that prompted it.
 *
 * No STT involved — speech-to-speech hands us the exact text it synthesised, so
 * the bot's half of the transcript is verbatim rather than re-recognised.
 */
TranscriptSession.prototype.writeText = function writeText(speaker, text) {
  if (!text?.trim()) return null;
  // The counter is not decoration. The name was `${Date.now()}-<speaker>-000000`,
  // and two writes in the same millisecond produced ONE file — the second
  // silently overwriting the first, losing a line with nothing logged. That is
  // not rare here: a holding line and the first sentence of the answer arrive
  // together, which is exactly when the record matters most. Proven by writing
  // twice with a fixed timestamp: one file, second content.
  //
  // It also fixes ordering. Same-millisecond names sorted equal, so the reader's
  // order was arbitrary; the counter makes it insertion order.
  const seq = String((this.textSeq = (this.textSeq ?? 0) + 1)).padStart(6, '0');
  const file = path.join(this.segments, `${Date.now()}-${slug(speaker)}-${seq}.txt`);
  try {
    fs.writeFileSync(file, text.trim());
    return file;
  } catch (e) {
    log.error('transcript text write failed', { error: e.message });
    return null;
  }
};

module.exports = { TranscriptSession };
