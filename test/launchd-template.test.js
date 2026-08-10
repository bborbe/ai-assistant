'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The plist template is a deployment surface with no runtime coverage: a wrong
// value here fails at `launchctl bootstrap`, on a machine, during an install —
// never in CI. It earned a test the day a hardcoded Label meant a second
// identity's plist claimed the first identity's service name.
//
// Rendering is duplicated from the Makefile's sed pipeline rather than shelled
// out to: the point is to assert what the placeholders MEAN, so a new
// placeholder added to the template and forgotten in the Makefile shows up
// here as an unsubstituted token.

const TEMPLATE = path.join(
  __dirname,
  '..',
  'deploy',
  'launchd',
  'discord-assistant.plist.template',
);

function render({ label, component }) {
  return fs
    .readFileSync(TEMPLATE, 'utf8')
    .replace(/__COMPONENT__/g, component)
    .replace(/__LABEL__/g, label)
    .replace(/__LAUNCHER__/g, '/home/u/.local/bin/x-launchd')
    .replace(/__REPO__/g, '/repo')
    .replace(/__HOME__/g, '/home/u')
    .replace(/__LOGDIR__/g, '/home/u/Library/Logs/x')
    .replace(/__PATH__/g, '/usr/bin:/bin');
}

const labelOf = (xml) => {
  const m = xml.match(/<key>Label<\/key>\s*(?:<!--[\s\S]*?-->\s*)*<string>([^<]*)<\/string>/);
  return m && m[1];
};

test('Label follows LAUNCHD_LABEL rather than being hardcoded', () => {
  assert.equal(
    labelOf(render({ label: 'com.github.bborbe.discord-assistant', component: 'bot' })),
    'com.github.bborbe.discord-assistant-bot',
  );
  assert.equal(
    labelOf(render({ label: 'com.github.bborbe.sc-assistant', component: 'shim' })),
    'com.github.bborbe.sc-assistant-shim',
  );
});

test('two identities never share a Label', () => {
  // The actual bug: distinct plist FILENAMES, identical Label inside. launchctl
  // rejects the second as a duplicate — or, worse, accepts it while the first is
  // stopped and points that label at the wrong checkout.
  const a = labelOf(render({ label: 'com.github.bborbe.discord-assistant', component: 'bot' }));
  const b = labelOf(render({ label: 'com.github.bborbe.sc-assistant', component: 'bot' }));
  assert.notEqual(a, b);
});

test('no placeholder survives rendering', () => {
  // Catches a placeholder added to the template but never wired into the
  // Makefile's sed pipeline — which is exactly how __LABEL__ would have been
  // missed a second time.
  for (const component of ['shim', 's2s', 'transcriber', 'bot']) {
    const xml = render({ label: 'com.example.app', component });
    const leftover = xml.match(/__[A-Z_]+__/g);
    assert.equal(leftover, null, `unsubstituted ${leftover} in the ${component} plist`);
  }
});
