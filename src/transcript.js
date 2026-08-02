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
    // Sub-200ms fragments are almost always a click or a breath; transcribing
    // them produces noise lines that make the transcript harder to read.
    const ms = (pcm.length / (RATE * CHANNELS * 2)) * 1000;
    if (ms < 200) return null;

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

module.exports = { TranscriptSession };
