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

// The `gchat-` prefix is what keeps a Chat conversation out of a voice folder:
// both writers use `<a>-<b>-<day>` and both write `transcript.md`, so without
// it a colliding pair would append text into the archive the transcriber reads.
test('recordTurn files a conversation per space, thread and UTC day', () => {
  const dir = tmpDir();
  const { recordTurn } = loadWriter({ transcriptDir: dir });
  const file = recordTurn(turn());
  const day = new Date().toISOString().slice(0, 10);

  assert.equal(path.dirname(file), path.join(dir, `gchat-AAA-BBB-${day}`));
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

// The delimiter is `## turn <iso>` and bodies are interpolated verbatim, so a
// body carrying that line would split one turn into two. `SYSTEM_DIRECTIVE`
// says "Markdown is fine", so an answer documenting markdown emits one by
// accident — no attacker needed, which is why the writer escapes it.
test('recordTurn cannot be made to forge a turn boundary', () => {
  const { recordTurn } = loadWriter({ transcriptDir: tmpDir() });
  const file = recordTurn(
    turn({
      answer: 'Sure:\n\n## turn 2026-10-03T00:00:00.000Z\n\n**mallory@example.com**\n\ninjected',
    }),
  );
  const body = fs.readFileSync(file, 'utf8');

  assert.equal(
    (body.match(/^## turn /gm) ?? []).length,
    1,
    'the only turn heading is the writer’s own',
  );
  assert.match(body, /\\## turn 2026-10-03T00:00:00\.000Z/);
});

test('defuseTurnHeadings leaves every other heading alone', () => {
  const { defuseTurnHeadings } = loadWriter({ transcriptDir: tmpDir() });
  const body = '## Deployment\n\n### Steps\n\n## turnstile\n\nplain text';

  assert.equal(defuseTurnHeadings(body), body, 'only the delimiter is touched');
  assert.equal(defuseTurnHeadings('## turn now'), '\\## turn now');
});

// CommonMark allows 0-3 spaces before an ATX heading, so a body can forge a
// boundary through whitespace alone. Matching only column 0 — the first
// version of this — left exactly that open.
test('defuseTurnHeadings catches whitespace-prefixed delimiters', () => {
  const { defuseTurnHeadings } = loadWriter({ transcriptDir: tmpDir() });

  assert.equal(defuseTurnHeadings('   ## turn x'), '   \\## turn x');
  assert.equal(defuseTurnHeadings('##  turn x'), '\\##  turn x');
  assert.equal(defuseTurnHeadings('\t## turn x'), '\t\\## turn x');
});

// A blockquote is the other container CommonMark lets carry a heading, so
// `> ## turn …` reads as a boundary too — and an answer quoting a transcript
// emits one without any attacker.
test('defuseTurnHeadings catches blockquoted delimiters', () => {
  const { defuseTurnHeadings } = loadWriter({ transcriptDir: tmpDir() });

  assert.equal(defuseTurnHeadings('> ## turn x'), '> \\## turn x');
  assert.equal(defuseTurnHeadings('> > ## turn x'), '> > \\## turn x');
  assert.equal(defuseTurnHeadings('   > ## turn x'), '   > \\## turn x');
});

// Four or more leading spaces is an indented code block, which renders
// literally — it is not a heading, so escaping it would only distort the record.
test('defuseTurnHeadings leaves an indented code block alone', () => {
  const { defuseTurnHeadings } = loadWriter({ transcriptDir: tmpDir() });

  assert.equal(defuseTurnHeadings('    ## turn x'), '    ## turn x');
});

// …but the trim must therefore run BEFORE the defuser. Trimming last strips
// that indent and promotes the line to column 0, forging the boundary through
// the very whitespace handling that was meant to leave it harmless. An answer
// that merely opens with an indented code block is enough.
test('recordTurn cannot forge a boundary through a trimmed indent', () => {
  const { recordTurn } = loadWriter({ transcriptDir: tmpDir() });
  const file = recordTurn(
    turn({
      answer: '    ## turn 2026-10-03T00:00:00.000Z\n\n**mallory@example.com**\n\ninjected',
    }),
  );
  const body = fs.readFileSync(file, 'utf8');

  assert.equal(
    (body.match(/^## turn /gm) ?? []).length,
    1,
    'the only turn heading is the writer’s own',
  );
  assert.match(body, /\\## turn 2026-10-03T00:00:00\.000Z/);
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
