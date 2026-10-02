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

const MAKEFILE = path.join(__dirname, '..', 'Makefile');

function render({ label, component, env = 'local.env' }) {
  return fs
    .readFileSync(TEMPLATE, 'utf8')
    .replace(/__COMPONENT__/g, component)
    .replace(/__LABEL__/g, label)
    .replace(/__LAUNCHER__/g, '/home/u/.local/bin/x-launchd')
    .replace(/__REPO__/g, '/repo')
    .replace(/__ENV__/g, env)
    .replace(/__HOME__/g, '/home/u')
    .replace(/__LOGDIR__/g, '/home/u/Library/Logs/x')
    .replace(/__PATH__/g, '/usr/bin:/bin');
}

const labelOf = (xml) => {
  const m = xml.match(/<key>Label<\/key>\s*(?:<!--[\s\S]*?-->\s*)*<string>([^<]*)<\/string>/);
  return m && m[1];
};

// EnvironmentVariables entries sit directly under their key, with no comment
// between (unlike Label), so the plain form is enough here.
const envValue = (xml, key) => {
  const m = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
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
  // Catches a placeholder added to the template but never added to render()
  // above — which is exactly how __LABEL__ would have been missed a second
  // time. Note what this does NOT cover: render() reimplements the Makefile's
  // sed pipeline, so a token present here and absent from the Makefile still
  // renders clean. The Makefile-wiring test below is the one that catches that.
  for (const component of ['shim', 's2s', 'transcriber', 'bot']) {
    const xml = render({ label: 'com.example.app', component });
    const leftover = xml.match(/__[A-Z_]+__/g);
    assert.equal(leftover, null, `unsubstituted ${leftover} in the ${component} plist`);
  }
});

test('every placeholder the template uses is wired into the Makefile', () => {
  // The two substitution lists are independent implementations, so the render()
  // tests cannot see a token the Makefile forgot. A placeholder added to the
  // template and to render() but NOT to the Makefile's sed pipeline ships
  // unsubstituted and fails at `launchctl bootstrap`, on a machine, during an
  // install — never in CI. This reads the Makefile itself.
  const wired = new Set(
    [...fs.readFileSync(MAKEFILE, 'utf8').matchAll(/-e 's\|(__[A-Z_]+__)\|/g)].map((m) => m[1]),
  );
  const used = new Set(
    [...fs.readFileSync(TEMPLATE, 'utf8').matchAll(/__[A-Z_]+__/g)].map((m) => m[0]),
  );
  const unwired = [...used].filter((token) => !wired.has(token));
  assert.deepEqual(
    unwired,
    [],
    `template placeholders absent from the Makefile sed pipeline: ${unwired.join(', ')}`,
  );
});

test('the plist names the env file, which is what lets identities share a checkout', () => {
  const xml = render({
    label: 'com.github.bborbe.sc-assistant',
    component: 'bot',
    env: '/home/u/.config/discord-assistant/sc.env',
  });
  assert.equal(envValue(xml, 'DISCORD_ASSISTANT_ENV'), '/home/u/.config/discord-assistant/sc.env');
});

test('an unset DISCORD_ASSISTANT_ENV still yields the historical local.env', () => {
  // The default path must not become mandatory: a single-instance install that
  // never heard of the variable has to keep working untouched.
  const xml = render({ label: 'com.github.bborbe.discord-assistant', component: 'bot' });
  assert.equal(envValue(xml, 'DISCORD_ASSISTANT_ENV'), 'local.env');
});
