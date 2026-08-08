'use strict';

const DISCORD_LIMIT = 2000;

/**
 * Split text into Discord-message-sized pieces.
 *
 * Shared by the text surface (thread replies) and the voice surface (the
 * shim's chat-bridge posts) — both send arbitrary-length model output into a
 * channel with the same 2000-char cap, so the split logic has exactly one
 * home rather than one per surface silently drifting apart.
 */
function chunk(text) {
  const out = [];
  let rest = text;
  while (rest.length > DISCORD_LIMIT) {
    // Prefer a line break, then a space, before hard-cutting.
    let cut = rest.lastIndexOf('\n', DISCORD_LIMIT);
    if (cut < DISCORD_LIMIT / 2) cut = rest.lastIndexOf(' ', DISCORD_LIMIT);
    if (cut < DISCORD_LIMIT / 2) cut = DISCORD_LIMIT;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

module.exports = { chunk, DISCORD_LIMIT };
