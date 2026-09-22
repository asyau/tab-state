import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, providerChain, sendsDataOffDevice, nanoAvailability } from '../../ai/providers.js';
import { mergeSettings } from '../../ai/settings.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.LanguageModel;
});

const record = {
  title: 'Guide', url: 'https://x.com/guide', activeMs: 120_000, activeSince: null,
  maxScrollPct: 80, copies: 0, highlights: 0, anchor: null,
};

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(url, init);
  };
  return calls;
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('chain always ends in the template', () => {
  assert.deepEqual(providerChain(mergeSettings({})), ['nano', 'template']);
  assert.deepEqual(providerChain(mergeSettings({ provider: 'openai' })), ['openai', 'template']);
  assert.deepEqual(providerChain(mergeSettings({ provider: 'template' })), ['template']);
  assert.deepEqual(providerChain(mergeSettings({ provider: 'bogus' })), ['template']);
});

test('auto falls back to the template when there is no on-device model', async () => {
  assert.equal(await nanoAvailability(), 'unsupported');
  const out = await summarize(record, mergeSettings({}));
  assert.equal(out.source, 'template');
  assert.match(out.text, /^Spent 2m reading 80%/);
  assert.match(out.errors[0], /nano: On-device model is unsupported/);
});

test('OpenAI-compatible request shape (works for Ollama with no key)', async () => {
  const calls = mockFetch(() => json(200, { choices: [{ message: { content: '"You finished most of the guide."' } }] }));
  const settings = mergeSettings({ provider: 'openai', openai: { baseUrl: 'http://localhost:11434/v1/', model: 'llama3.2' } });
  const out = await summarize(record, settings);
  assert.deepEqual(out, { text: 'You finished most of the guide.', source: 'openai', errors: [] });
  assert.equal(calls[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.equal(calls[0].body.model, 'llama3.2');
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.match(calls[0].body.messages[1].content, /Scrolled: 80%/);
});

test('OpenAI-compatible sends the key and surfaces errors, then falls back', async () => {
  const calls = mockFetch(() => json(401, { error: { message: 'Incorrect API key' } }));
  const settings = mergeSettings({ provider: 'openai', openai: { apiKey: 'sk-test', model: 'm' } });
  const out = await summarize(record, settings);
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');
  assert.equal(out.source, 'template');
  assert.match(out.errors[0], /HTTP 401: Incorrect API key/);
});

test('missing model is reported without a network call', async () => {
  const calls = mockFetch(() => json(200, {}));
  const out = await summarize(record, mergeSettings({ provider: 'openai' }));
  assert.equal(calls.length, 0);
  assert.match(out.errors[0], /Set a model name/);
});

test('Anthropic request shape', async () => {
  const calls = mockFetch(() => json(200, { content: [{ type: 'text', text: 'You read most of the guide.' }] }));
  const settings = mergeSettings({ provider: 'anthropic', anthropic: { apiKey: 'sk-ant' } });
  const out = await summarize(record, settings);
  assert.equal(out.source, 'anthropic');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-ant');
  assert.equal(calls[0].init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(calls[0].body.model, 'claude-haiku-4-5-20251001');
  assert.equal(typeof calls[0].body.system, 'string');
});

test('Gemini Nano via the Prompt API', async () => {
  let prompted = '';
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => ({
      clone: async () => ({ prompt: async (p) => { prompted = p; return 'You stopped near the end.'; }, destroy() {} }),
    }),
  };
  const out = await summarize(record, mergeSettings({}));
  assert.deepEqual(out, { text: 'You stopped near the end.', source: 'nano', errors: [] });
  assert.match(prompted, /Title: Guide/);
});

test('privacy flag only for cloud providers', () => {
  assert.equal(sendsDataOffDevice(mergeSettings({})), false);
  assert.equal(sendsDataOffDevice(mergeSettings({ provider: 'openai' })), true);
  assert.equal(sendsDataOffDevice(mergeSettings({ provider: 'anthropic' })), true);
});
