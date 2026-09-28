import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarize, summarizeSession, getInsight, providerChain, sendsDataOffDevice, nanoAvailability,
  proposeGroups, parseGroupsJson, resetNanoSessions, hostedUser, openHostedCheckout,
} from '../../ai/providers.js';
import { mergeSettings } from '../../lib/settings.js';
import { __setExtPayForTests } from '../../lib/extpay.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.LanguageModel;
  resetNanoSessions();
  __setExtPayForTests(null);
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
  assert.match(out.errors[0], /nano: this browser has no built-in on-device AI/);
});

test('nano surfaces an actionable message, not the raw state, when a download is needed', async () => {
  globalThis.LanguageModel = { availability: async () => 'downloadable' };
  const out = await summarize(record, mergeSettings({}));
  assert.equal(out.source, 'template');
  assert.match(out.errors[0], /nano: on-device AI needs a one-time download — enable it in Settings/);
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
  assert.match(out.errors[0], /replied in an unexpected format/);
});

// Regression: grouping used to go through the one-line-summary cleanup (first line only, 220 chars,
// quotes stripped), so any realistically formatted reply was destroyed before parsing and the user
// saw "The model's response could not be parsed into valid groups."
const PRETTY = `[
  {
    "name": "Stripe Docs",
    "indexes": [1, 2]
  },
  {
    "name": "Cooking",
    "indexes": [3, 4]
  }
]`;
const four = [...groupable, { id: 'r4', title: 'Soup', url: 'https://food.com/soup' }];
const wantTwo = [{ name: 'Stripe Docs', tabIds: ['r1', 'r2'] }, { name: 'Cooking', tabIds: ['r3', 'r4'] }];

for (const [label, content] of [
  ['multi-line (pretty-printed) JSON', PRETTY],
  ['a ```json fenced block with prose around it', `Here are the groups:\n\`\`\`json\n${PRETTY}\n\`\`\`\nHope that helps!`],
  ['an object wrapper {"groups": [...]}', `{"groups": ${PRETTY}}`],
  ['"indices" instead of "indexes"', PRETTY.replaceAll('indexes', 'indices')],
]) {
  test(`proposeGroups understands ${label}`, async () => {
    const settings = mergeSettings({ provider: 'openai', openai: { apiKey: 'k', model: 'm' } });
    mockFetch(() => json(200, { choices: [{ message: { content } }] }));
    const out = await proposeGroups(four, settings);
    assert.deepEqual(out.errors, []);
    assert.deepEqual(out.groups, wantTwo);
  });
}

test('proposeGroups keeps the complete groups from a reply cut off mid-way (output token limit)', async () => {
  const settings = mergeSettings({ provider: 'openai', openai: { apiKey: 'k', model: 'm' } });
  const cut = PRETTY.slice(0, PRETTY.indexOf('"Cooking"') + 20); // second group truncated
  mockFetch(() => json(200, { choices: [{ message: { content: cut } }] }));
  const out = await proposeGroups(four, settings);
  assert.deepEqual(out.groups, [wantTwo[0]]);
});

test('proposeGroups asks Anthropic for enough output tokens for a long group list', async () => {
  const settings = mergeSettings({ provider: 'anthropic', anthropic: { apiKey: 'k', model: 'm' } });
  let body;
  mockFetch((url, init) => { body = JSON.parse(init.body); return json(200, { content: [{ type: 'text', text: PRETTY }] }); });
  const out = await proposeGroups(four, settings);
  assert.equal(out.groups.length, 2);
  assert.ok(body.max_tokens >= 1000, `max_tokens ${body.max_tokens}`);
});

// Regression: newer OpenAI models (gpt-5, o-series) reject `max_tokens` with HTTP 400 ("use
// 'max_completion_tokens' instead"), and for those reasoning models a completion cap also eats
// into hidden reasoning, while other OpenAI-compatible servers don't all accept the new name. So no
// output limit is sent to OpenAI-compatible APIs at all — for grouping or summaries.
test('OpenAI-compatible requests never send an output-token parameter', async () => {
  const settings = mergeSettings({ provider: 'openai', openai: { apiKey: 'k', model: 'gpt-5' } });
  const bodies = [];
  mockFetch((url, init) => { bodies.push(JSON.parse(init.body)); return json(200, { choices: [{ message: { content: PRETTY } }] }); });
  const out = await proposeGroups(four, settings);
  assert.equal(out.groups.length, 2);
  for (const b of bodies) {
    assert.equal('max_tokens' in b, false, 'max_tokens is rejected by newer OpenAI models');
    assert.equal('max_completion_tokens' in b, false, 'not every OpenAI-compatible server supports it');
  }
});

test('proposeGroups only sends a bounded number of tabs (most recently used first)', async () => {
  const settings = mergeSettings({ provider: 'openai', openai: { apiKey: 'k', model: 'm' } });
  const many = Array.from({ length: 150 }, (_, i) => ({ id: `m${i}`, title: `Tab ${i}`, url: `https://s${i}.com/`, lastActiveAt: i }));
  let prompt;
  mockFetch((url, init) => { prompt = JSON.parse(init.body).messages[1].content; return json(200, { choices: [{ message: { content: '[]' } }] }); });
  await proposeGroups(many, settings);
  const lines = prompt.split('\n').filter((l) => /^\d+\. /.test(l));
  assert.ok(lines.length <= 80, `sent ${lines.length} tabs`);
  assert.match(lines[0], /Tab 149/, 'most recently used first');
});

// --- Hosted Pro tier (see ai/providers.js hostedRun / lib/extpay.js) --------------------------
// The real ExtPay client needs a real chrome.runtime.id (see lib/extpay.js's comment), so these
// use __setExtPayForTests to inject a fake instead of touching the vendored client at all.

test('hosted provider falls back to the template with a clear error when no Worker URL is set', async () => {
  const settings = mergeSettings({ provider: 'hosted' });
  const out = await summarize(record, settings);
  assert.equal(out.source, 'template');
  assert.match(out.errors[0], /pro-proxy Worker URL/);
});

test('hosted provider falls back to the template when the user has not paid', async () => {
  __setExtPayForTests({ getUser: async () => ({ paid: false }) });
  const settings = mergeSettings({ provider: 'hosted', hosted: { workerUrl: 'https://worker.example' } });
  const out = await summarize(record, settings);
  assert.equal(out.source, 'template');
  assert.match(out.errors[0], /Upgrade to Tab State Pro/);
});

test('hosted provider posts to the configured Worker with the paid user\'s id once paid', async () => {
  __setExtPayForTests({ getUser: async () => ({ paid: true, email: 'reader@example.com' }) });
  const calls = mockFetch(() => json(200, { text: 'Spent 2m reading.' }));
  const settings = mergeSettings({ provider: 'hosted', hosted: { workerUrl: 'https://worker.example/' } });
  const out = await summarize(record, settings);
  assert.equal(out.source, 'hosted');
  assert.equal(out.text, 'Spent 2m reading.');
  assert.equal(calls[0].url, 'https://worker.example/summarize');
  assert.equal(calls[0].body.userId, 'reader@example.com');
});

test('hosted provider falls back to the template when the Worker itself errors', async () => {
  __setExtPayForTests({ getUser: async () => ({ paid: true, email: 'reader@example.com' }) });
  mockFetch(() => json(429, { error: 'Daily request limit reached' }));
  const settings = mergeSettings({ provider: 'hosted', hosted: { workerUrl: 'https://worker.example' } });
  const out = await summarize(record, settings);
  assert.equal(out.source, 'template');
  assert.match(out.errors[0], /429/);
});

test('hostedUser() and openHostedCheckout() pass straight through to the injected ExtPay instance', async () => {
  let openedPlan;
  __setExtPayForTests({
    getUser: async () => ({ paid: true, email: 'reader@example.com' }),
    openPaymentPage: (plan) => { openedPlan = plan; },
  });
  assert.deepEqual(await hostedUser(), { paid: true, email: 'reader@example.com' });
  await openHostedCheckout('yearly');
  assert.equal(openedPlan, 'yearly');
});
