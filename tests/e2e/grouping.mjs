// "Group related tabs", end to end in the real extension, against a fake OpenAI-compatible server
// that answers the way real models do: pretty-printed JSON inside a ```json fence with chatter
// around it. Regression test for "The model's response could not be parsed into valid groups",
// which grouping used to show for any such reply (it went through the one-line summary cleanup).
//
//   node tests/e2e/grouping.mjs   (part of npm run test:e2e)
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { dismissWelcomeTab } from './welcome-tab.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastPrompt = '';
const TITLES = ['Stripe API: Authentication', 'Stripe API: Webhooks', 'Pasta recipes', 'Soup recipes', 'Random news'];
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/chat/completions')) {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const reqBody = JSON.parse(b);
      if ('max_tokens' in reqBody) { // what OpenAI's newer models answer
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }));
        return;
      }
      if (!/group browser tabs/i.test(reqBody.messages[0].content)) { // summaries, recap: one plain sentence
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'You browsed Stripe docs and some recipes.' } }] }));
        return;
      }
      lastPrompt = reqBody.messages[1].content;
      const idx = (t) => Number(lastPrompt.split('\n').find((l) => l.includes(t)).split('.')[0]);
      const content = `Sure! Here are the groups:\n\`\`\`json\n[\n  {\n    "name": "Stripe docs",\n    "indexes": [${idx('Authentication')}, ${idx('Webhooks')}]\n  },\n  {\n    "name": "Cooking",\n    "indexes": [${idx('Pasta')}, ${idx('Soup')}]\n  }\n]\n\`\`\`\nLet me know if you want changes.`;
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
    return;
  }
  const i = Number(req.url.slice(1));
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${TITLES[i]}</title><p>x</p>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`] });
let [sw] = context.serviceWorkers(); if (!sw) sw = await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
await dismissWelcomeTab(sw);
for (let i = 0; i < TITLES.length; i++) { const p = await context.newPage(); await p.goto(`${BASE}/${i}`); await sleep(300); }
await sw.evaluate(async (base) => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, provider: 'openai', openai: { baseUrl: `${base}/v1`, apiKey: '', model: 'test' }, grouping: { enabled: true } } });
}, BASE);
const dash = await context.newPage();
await dash.goto(`chrome-extension://${extId}/ui/dashboard.html`); await sleep(1500);
await dash.click('#group-tabs');
await dash.waitForSelector('#group-confirm:not([hidden])', { timeout: 15000 }).catch(async () => { console.log('toast:', await dash.textContent('#toast-text')); throw new Error('no confirm dialog'); });
console.log('proposed:', (await dash.textContent('#group-confirm-body')).replace(/\s+/g, ' ').trim());
await dash.click('#group-go'); await sleep(1500);
const groups = await sw.evaluate(async () => Promise.all((await chrome.tabGroups.query({})).map(async (g) => ({ title: g.title, tabs: (await chrome.tabs.query({ groupId: g.id })).map((t) => t.title) }))));
console.log('chrome tab groups:', JSON.stringify(groups));
assert.equal(groups.length, 2);
assert.deepEqual(groups.map((g) => g.title).sort(), ['Cooking', 'Stripe docs']);
console.log('toast:', await dash.textContent('#toast-text'));
// The dashboard shows the groups it made (they used to exist only in Chrome's tab bar, so the page
// looked unchanged after "Grouped into N groups").
await dash.waitForSelector('#tab-groups:not([hidden])', { timeout: 5000 });
const cards = await dash.$$eval('.tgroup', (els) => els.map((e) => ({
  name: e.querySelector('h3').textContent,
  tabs: [...e.querySelectorAll('.tgroup-tab-title')].map((t) => t.textContent),
})));
console.log('dashboard tab groups:', JSON.stringify(cards));
assert.deepEqual(cards.map((c) => c.name).sort(), ['Cooking', 'Stripe docs']);
assert.deepEqual(cards.find((c) => c.name === 'Cooking').tabs.sort(), ['Pasta recipes', 'Soup recipes']);
assert.ok(await dash.$$eval('#board .gdot', (els) => els.length) >= 4, 'grouped tabs carry a group dot on the board');
if (process.env.OUT) await dash.screenshot({ path: path.join(process.env.OUT, 'groups.png'), fullPage: true });

// "Go to group" switches to the group's first tab; "Ungroup" removes it, here and in Chrome.
await dash.click('.tgroup:has(h3:text("Stripe docs")) .act.primary');
await sleep(500);
const active = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.title);
assert.match(active, /Stripe API/, 'Go to group focuses a tab in that group');
await dash.bringToFront();
await dash.click('.tgroup:has(h3:text("Cooking")) .act:has-text("Ungroup")');
await sleep(1500);
assert.deepEqual(await dash.$$eval('.tgroup h3', (els) => els.map((e) => e.textContent)), ['Stripe docs']);
assert.equal((await sw.evaluate(async () => (await chrome.tabGroups.query({})).length)), 1);
console.log('GROUPING E2E PASSED');
await context.close(); server.close();
