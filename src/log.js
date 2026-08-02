'use strict';

const config = require('./config');

// JSON lines: what log aggregators want, and what `kubectl logs | jq` can read.
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, msg, fields = {}) {
  if (LEVELS[level] > threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  // stderr for error/warn so `kubectl logs` stream separation stays useful.
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

module.exports = {
  error: (m, f) => emit('error', m, f),
  warn: (m, f) => emit('warn', m, f),
  info: (m, f) => emit('info', m, f),
  debug: (m, f) => emit('debug', m, f),
};
