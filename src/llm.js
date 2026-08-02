'use strict';

const config = require('./config');

/**
 * Minimal OpenAI chat-completions client.
 *
 * Deliberately assumes NOTHING about server statefulness: it sends the full
 * message array as the spec requires. A stateless backend (MiniMax) uses that
 * history; a stateful one (the Claude Code shim) discards all but the newest
 * user message. Keeping the bot ignorant of which is what lets the backend be
 * swapped with only a base-URL change.
 */
async function chat(messages, { signal } = {}) {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model: config.model, messages, stream: false }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`endpoint ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`no content in response: ${JSON.stringify(data).slice(0, 200)}`);
  return text.trim();
}

module.exports = { chat };
