import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { checkRateLimit, callAnthropic } from '../src/worker.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** A tiny in-memory stand-in for a Workers KV namespace binding. */
function fakeKv() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    _store: store,
  };
}

function req(path, { method = 'POST', body, origin = 'chrome-extension://abcdefghijklmnop' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  return new Request(`https://worker.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('GET /health responds ok without touching the rate limiter or Anthropic', async () => {
  const env = { RATE_LIMIT: fakeKv(), ANTHROPIC_API_KEY: '' };
  const res = await worker.fetch(req('/health', { method: 'GET' }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('OPTIONS preflight only reflects a chrome-extension:// origin', async () => {
  const env = { RATE_LIMIT: fakeKv() };
  const good = await worker.fetch(req('/summarize', { method: 'OPTIONS', origin: 'chrome-extension://abc' }), env);
  assert.equal(good.headers.get('access-control-allow-origin'), 'chrome-extension://abc');
  const bad = await worker.fetch(req('/summarize', { method: 'OPTIONS', origin: 'https://evil.example' }), env);
  assert.equal(bad.headers.get('access-control-allow-origin'), 'null');
});

test('unknown routes 404', async () => {
  const env = { RATE_LIMIT: fakeKv() };
  const res = await worker.fetch(req('/nope', { method: 'GET' }), env);
  assert.equal(res.status, 404);
});

test('POST /summarize rejects a malformed body', async () => {
  const env = { RATE_LIMIT: fakeKv() };
  const res = await worker.fetch(new Request('https://worker.example/summarize', { method: 'POST', body: '{not json' }), env);
  assert.equal(res.status, 400);
});

test('POST /summarize requires non-empty systemPrompt and userPrompt strings', async () => {
  const env = { RATE_LIMIT: fakeKv() };
  const res = await worker.fetch(req('/summarize', { body: { systemPrompt: '', userPrompt: 'hi' } }), env);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /required/);
});

test('POST /summarize calls Anthropic with the Worker\'s own key and returns the text', async () => {
  let sentUrl, sentInit;
  globalThis.fetch = async (url, init) => {
    sentUrl = url; sentInit = init;
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Spent 2m reading.' }] }) };
  };
  const env = { RATE_LIMIT: fakeKv(), ANTHROPIC_API_KEY: 'sk-ant-test' };
  const res = await worker.fetch(req('/summarize', { body: { systemPrompt: 'sys', userPrompt: 'usr', userId: 'user@example.com' } }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: 'Spent 2m reading.' });
  assert.equal(sentUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(sentInit.headers['x-api-key'], 'sk-ant-test');
  const body = JSON.parse(sentInit.body);
  assert.equal(body.system, 'sys');
  assert.equal(body.messages[0].content, 'usr');
});

test('POST /summarize surfaces an Anthropic error as a clear 502, not a crash', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) });
  const env = { RATE_LIMIT: fakeKv(), ANTHROPIC_API_KEY: 'bad-key' };
  const res = await worker.fetch(req('/summarize', { body: { systemPrompt: 'sys', userPrompt: 'usr' } }), env);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /invalid x-api-key/);
});

test('callAnthropic throws a clear, specific error when the Worker has no key configured', async () => {
  await assert.rejects(() => callAnthropic({ RATE_LIMIT: fakeKv() }, 'sys', 'usr'), /ANTHROPIC_API_KEY/);
});

test('checkRateLimit allows requests under the cap and blocks once it is reached', async () => {
  const env = { RATE_LIMIT: fakeKv() };
  const now = Date.parse('2026-01-15T12:00:00Z');
  for (let i = 0; i < 200; i += 1) {
    const r = await checkRateLimit(env, 'user@example.com', now);
    assert.equal(r.allowed, true, `request ${i + 1} should be allowed`);
  }
  const blocked = await checkRateLimit(env, 'user@example.com', now);
  assert.equal(blocked.allowed, false);
});

test('checkRateLimit tracks separate users independently', async () => {
  const env = { RATE_LIMIT: fakeKv() };
  const now = Date.parse('2026-01-15T12:00:00Z');
  await checkRateLimit(env, 'a@example.com', now);
  const b = await checkRateLimit(env, 'b@example.com', now);
  assert.equal(b.allowed, true);
  assert.equal(b.count, 1, 'a different userId starts its own fresh count');
});

test('POST /summarize enforces the same per-user cap end to end', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) });
  const env = { RATE_LIMIT: fakeKv(), ANTHROPIC_API_KEY: 'k' };
  const body = { systemPrompt: 'sys', userPrompt: 'usr', userId: 'capped@example.com' };
  for (let i = 0; i < 200; i += 1) {
    const res = await worker.fetch(req('/summarize', { body }), env);
    assert.equal(res.status, 200, `request ${i + 1}`);
  }
  const res = await worker.fetch(req('/summarize', { body }), env);
  assert.equal(res.status, 429);
});
