'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// `config` captures its env at module load, so every case reloads it (and the
// writer that reads it) — the same dance gchat.test.js uses for its allowlist.
function loadWriter({ transcriptDir, transcribe } = {}) {
  if (transcriptDir === undefined) delete process.env.TRANSCRIPT_DIR;
  else process.env.TRANSCRIPT_DIR = transcriptDir;
  if (transcribe === undefined) delete process.env.TRANSCRIBE;
  else process.env.TRANSCRIBE = transcribe;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/transcript')];
  delete require.cache[require.resolve('../src/chat-transcript')];
  return require('../src/chat-transcript');
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chat-transcript-'));
}

function turn(overrides = {}) {
  return {
    spaceId: 'AAA',
    threadId: 'BBB',
    sender: 'alice@example.com',
    question: 'what is the deploy command?',
    answer: 'make apply BRANCH=dev',
    ...overrides,
  };
}

test('recordTurn writes the sender and the reply', () => {
  const { recordTurn } = loadWriter({ transcriptDir: tmpDir() });
  const file = recordTurn(turn());

  assert.ok(file, 'a turn carrying an answer is written');
  assert.ok(file.endsWith('transcript.md'), `expected transcript.md, got ${file}`);
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /alice@example\.com/);
  assert.match(body, /what is the deploy command\?/);
  assert.match(body, /make apply BRANCH=dev/);
});

test('recordTurn files a conversation per space, thread and UTC day', () => {
  const dir = tmpDir();
  const { recordTurn } = loadWriter({ transcriptDir: dir });
  const file = recordTurn(turn());
  const day = new Date().toISOString().slice(0, 10);

  assert.equal(path.dirname(file), path.join(dir, `AAA-BBB-${day}`));
});

test('recordTurn keeps two conversations apart', () => {
  const { recordTurn } = loadWriter({ transcriptDir: tmpDir() });
  const first = recordTurn(turn());
  const second = recordTurn(turn({ spaceId: 'CCC', threadId: 'DDD' }));

  assert.notEqual(first, second);
});

// A second turn must not overwrite the first — the whole point of the file is
// that it accumulates a conversation.
test('recordTurn appends, keeping earlier turns', () => {
  const { recordTurn } = loadWriter({ transcriptDir: tmpDir() });
  const file = recordTurn(turn({ question: 'first question', answer: 'first answer' }));
  recordTurn(turn({ question: 'second question', answer: 'second answer' }));

  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /first question/);
  assert.match(body, /first answer/);
  assert.match(body, /second question/);
  assert.match(body, /second answer/);
});

// TRANSCRIBE is the consent switch — who gets WRITTEN DOWN — and a Chat
// transcript is a recording of the same kind, so it answers to the same switch
// the voice writer does.
test('recordTurn writes nothing when TRANSCRIBE is off', () => {
  const dir = tmpDir();
  const { recordTurn } = loadWriter({ transcriptDir: dir, transcribe: '0' });

  assert.equal(recordTurn(turn()), null);
  assert.deepEqual(fs.readdirSync(dir), [], 'no conversation folder is even created');
});

test('recordTurn writes nothing for a turn with no answer', () => {
  const dir = tmpDir();
  const { recordTurn } = loadWriter({ transcriptDir: dir });

  assert.equal(recordTurn(turn({ answer: '' })), null);
  assert.equal(recordTurn(turn({ answer: undefined })), null);
  assert.deepEqual(fs.readdirSync(dir), []);
});

// The answer is already in the thread by the time this runs, so losing the
// record of a turn must never fail a turn that succeeded — the same posture the
// voice writer takes on a failed segment write.
test('recordTurn swallows an unwritable transcript dir', () => {
  const blocker = path.join(tmpDir(), 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const { recordTurn } = loadWriter({ transcriptDir: path.join(blocker, 'sub') });

  assert.doesNotThrow(() => {
    assert.equal(recordTurn(turn()), null);
  });
});

test('recordTurn labels a missing sender rather than writing "undefined"', () => {
  const { recordTurn } = loadWriter({ transcriptDir: tmpDir() });
  const body = fs.readFileSync(recordTurn(turn({ sender: '' })), 'utf8');

  assert.match(body, /\*\*unknown\*\*/);
  assert.doesNotMatch(body, /undefined/);
});
