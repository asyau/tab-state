import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarize, summarizeSession, getInsight, providerChain, sendsDataOffDevice, nanoAvailability,
  proposeGroups, parseGroupsJson, resetNanoSessions,
} from '../../ai/providers.js';
import { mergeSettings } from '../../lib/settings.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.LanguageModel;
  resetNanoSessions();
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

// --- Privacy: no raw page text to cloud providers ------------------------------------------

const withText = {
  ...record,
  selectionSnippet: 'SECRET-SELECTION-TEXT',
  anchor: { kind: 'text', heading: 'Setup', snippet: 'SECRET-NEARBY-PARAGRAPH' },
};

test('cloud providers never receive selected or nearby page text', async () => {
  const calls = mockFetch(() => json(200, { choices: [{ message: { content: 'ok.' } }] }));
  const settings = mergeSettings({ provider: 'openai', openai: { apiKey: 'k', model: 'm' } });
  await summarize(withText, settings);
  await getInsight(withText, settings);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    const sent = JSON.stringify(c.body);
    assert.ok(!sent.includes('SECRET-SELECTION-TEXT'), 'selected text must not be sent');
    assert.ok(!sent.includes('SECRET-NEARBY-PARAGRAPH'), 'nearby paragraph text must not be sent');
    assert.ok(sent.includes('Setup'), 'the heading (metadata) is still sent');
  }
});

test('on-device AI still gets the text, since nothing leaves the machine', async () => {
  let prompted = '';
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => ({ clone: async () => ({ prompt: async (p) => { prompted = p; return 'ok.'; }, destroy() {} }) }),
  };
  await summarize(withText, mergeSettings({}));
  assert.match(prompted, /SECRET-SELECTION-TEXT/);
  assert.match(prompted, /SECRET-NEARBY-PARAGRAPH/);
});

// --- Session recap -------------------------------------------------------------------------

const sessionRecords = [
  { ...record, id: 'a', title: 'Deep one', activeMs: 120_000, maxScrollPct: 90 },
  { ...record, id: 'b', title: 'Ghost one', url: 'https://y.com/g', activeMs: 0, maxScrollPct: 0 },
];

test('summarizeSession falls back to the template recap with no AI configured', async () => {
  const out = await summarizeSession(sessionRecords, mergeSettings({}));
  assert.equal(out.source, 'template');
  assert.match(out.text, /Tracked 2 tabs, 1 deep focus, 1 skipped or never opened/);
});

test('summarizeSession uses the configured provider and a distinct prompt from per-tab', async () => {
  const calls = mockFetch(() => json(200, { choices: [{ message: { content: 'You focused on Deep one and skipped the rest.' } }] }));
  const settings = mergeSettings({ provider: 'openai', openai: { apiKey: 'k', model: 'm' } });
  const out = await summarizeSession(sessionRecords, settings);
  assert.equal(out.source, 'openai');
  assert.match(calls[0].body.messages[0].content, /recap of a browsing session/);
  assert.match(calls[0].body.messages[1].content, /Deep one \(Deep Focus/);
});

// --- Card detail view: deeper AI insight ---------------------------------------------------

test('getInsight falls back to the multi-sentence template with no AI configured', async () => {
  const out = await getInsight(record, mergeSettings({}));
  assert.equal(out.source, 'template');
  assert.match(out.text, /^Spent 2m reading 80%/);
});

test('getInsight is not truncated at the short one-line summary length', async () => {
  const longInsight = 'You explored the Stripe authentication guide in real depth, spending well over two minutes on the page. '
    + 'You scrolled almost to the end and copied a code sample, suggesting you meant to use it directly in your own project soon.';
  mockFetch(() => json(200, { choices: [{ message: { content: longInsight } }] }));
  const settings = mergeSettings({ provider: 'openai', openai: { apiKey: 'k', model: 'm' } });
  const out = await getInsight(record, settings);
  assert.equal(out.source, 'openai');
  assert.equal(out.text, longInsight, 'a >220-char insight is not cut short like a per-tab summary');
});

// --- AI grouping ---------------------------------------------------------------------------

test('parseGroupsJson handles plain JSON, a fenced block, and garbage', () => {
  assert.deepEqual(parseGroupsJson('[{"name":"Docs","indexes":[1,2]}]'), [{ name: 'Docs', indexes: [1, 2] }]);
  assert.deepEqual(
    parseGroupsJson('Sure, here you go:\n```json\n[{"name":"Docs","indexes":[1,2]}]\n```'),
    [{ name: 'Docs', indexes: [1, 2] }],
  );
  assert.deepEqual(parseGroupsJson('not json at all'), []);
  assert.deepEqual(parseGroupsJson('{"name":"not an array"}'), []);
  assert.deepEqual(parseGroupsJson(undefined), []);
});

const groupable = [
  { id: 'r1', title: 'Auth docs', url: 'https://docs.stripe.com/auth' },
  { id: 'r2', title: 'Webhooks docs', url: 'https://docs.stripe.com/webhooks' },
  { id: 'r3', title: 'Recipe', url: 'https://food.com/pasta' },
];

test('proposeGroups maps model indexes back to record ids and drops singleton/invalid groups', async () => {
  const settings = mergeSettings({ provider: 'openai', openai: { apiKey: 'k', model: 'm' } });
  mockFetch(() => json(200, { choices: [{ message: {
    // group 3 references index 3 twice and an out-of-range index 9; group 2 is a lone tab.
    content: '[{"name":"Stripe Docs","indexes":[1,2]},{"name":"Lonely","indexes":[3,9,3]}]',
  } }] }));
  const out = await proposeGroups(groupable, settings);
  assert.equal(out.groups.length, 1);
  assert.deepEqual(out.groups[0], { name: 'Stripe Docs', tabIds: ['r1', 'r2'] });
});

test('proposeGroups refuses to run with only the template available', async () => {
  const out = await proposeGroups(groupable, mergeSettings({ provider: 'template' }));
  assert.deepEqual(out.groups, []);
  assert.match(out.errors[0], /No AI provider configured/);
});

test('proposeGroups reports a clean error when the model output cannot be parsed', async () => {
  const settings = mergeSettings({ provider: 'openai', openai: { apiKey: 'k', model: 'm' } });
  mockFetch(() => json(200, { choices: [{ message: { content: 'I cannot help with that.' } }] }));
  const out = await proposeGroups(groupable, settings);
  assert.deepEqual(out.groups, []);
  assert.match(out.errors[0], /could not be parsed/);
});
