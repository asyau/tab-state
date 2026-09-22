// End-to-end test: loads the unpacked extension into Chromium with Playwright, browses a few
// local pages the way a person would, then checks the dashboard, purge and undo.
//
//   npm i -D playwright && npx playwright install chromium
//   node tests/e2e/run.mjs            (HEADED=1 to watch it)

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.E2E_OUT || path.join(ROOT, 'tests/e2e/output');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Local test site -------------------------------------------------------------

const para = (n) => Array.from({ length: n }, (_, i) =>
  `<p>Paragraph ${i + 1}. ${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6)}</p>`).join('\n');

const PAGES = {
  '/docs': `<title>Auth API Reference</title><meta name="description" content="How to authenticate API requests.">
    <h1>API Reference</h1>${para(6)}<h2>Installation</h2>${para(8)}
    <h2>Authentication</h2>${para(4)}<pre><code>curl https://api.example.com/v1/charges -u sk_test_123:</code></pre>${para(10)}
    <h2>Errors</h2>${para(10)}`,
  '/blog': `<title>Why Rust Async Is Hard</title><h1>Why Rust async is hard</h1>${para(5)}
    <h2>Pinning</h2>${para(10)}<h2>Executors</h2>${para(10)}<h2>Conclusion</h2>${para(10)}`,
  '/recipe': `<title>10 Clickbait Recipes</title><h1>Recipes</h1>${para(40)}`,
  '/ghost1': '<title>Forum thread</title><h1>Thread</h1><p>Hello</p>',
  '/ghost2': '<title>Unopened resource</title><h1>Resource</h1><p>Hello</p>',
};

const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  // Chrome auto-requests this for every page; a 404 for it is just console noise, not a bug.
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const body = PAGES[path];
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body ? `<!doctype html><html><body style="font:16px/1.6 sans-serif;max-width:700px;margin:auto">${body}</body></html>` : 'nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// --- Launch ------------------------------------------------------------------------

const context = await chromium.launchPersistentContext('', {
  headless: !process.env.HEADED,
  channel: 'chromium',
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  viewport: { width: 1360, height: 900 },
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
const errors = [];
context.on('weberror', (e) => errors.push(`page error: ${e.error().message}`));

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
sw.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`sw ${m.type()}: ${m.text()}`); });
const extId = new URL(sw.url()).host;
const DASH = `chrome-extension://${extId}/ui/dashboard.html`;
console.log('extension', extId);

const bg = (fn, arg) => sw.evaluate(fn, arg);
const records = () => bg(async () => Object.entries(await chrome.storage.local.get(null))
  .filter(([k]) => k.startsWith('rec:')).map(([, v]) => v));
const recordFor = async (p) => (await records()).find((r) => r.url === BASE + p && !r.closed);

function watch(page) {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${page.url()}: ${m.text()}`); });
  return page;
}

async function open(p) {
  const page = watch(await context.newPage());
  await page.goto(BASE + p);
  await page.bringToFront();
  await sleep(400);
  return page;
}

// Is focus detected at all in this browser mode?
await sleep(1000);
const focusProbe = await bg(async () => ({
  idle: await chrome.idle.queryState(60),
  win: await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).then((w) => ({ focused: w.focused })).catch((e) => String(e)),
}));
console.log('focus probe', focusProbe);

// --- Browse like a person -----------------------------------------------------------------

// 1. Docs: read to the code block, copy it, highlight a paragraph -> Deep Focus
const docs = await open('/docs');
await docs.evaluate(() => document.querySelector('pre').scrollIntoView({ block: 'center' }));
await sleep(1200);
await docs.evaluate(() => {
  const range = document.createRange();
  range.selectNodeContents(document.querySelector('pre code'));
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  document.execCommand('copy');
});
await docs.locator('p').nth(20).click({ clickCount: 3 }); // triple-click selects a paragraph
await sleep(1500);

// 2. Blog: skim 40% over ~17s -> Partially Read
const blog = await open('/blog');
await blog.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.3));
await sleep(17_000);

// 3. Recipe: 4 seconds, no scroll -> Just Glanced
await open('/recipe');
await sleep(4000);

// 4. Ghosts: opened in the background, never looked at
await bg(async (base) => {
  await chrome.tabs.create({ url: `${base}/ghost1`, active: false });
  await chrome.tabs.create({ url: `${base}/ghost2`, active: false });
}, BASE);
await sleep(1500);

// --- Check the engine ------------------------------------------------------------------------

const dash = watch(await context.newPage());
await dash.goto(DASH);
await dash.bringToFront();
await sleep(1500);

const rDocs = await recordFor('/docs');
const rBlog = await recordFor('/blog');
const rRecipe = await recordFor('/recipe');
const rGhost = await recordFor('/ghost1');
console.log('docs', { ms: rDocs.activeMs, scroll: rDocs.maxScrollPct, copies: rDocs.copies, highlights: rDocs.highlights, anchor: rDocs.anchor, bucket: rDocs.bucket });
console.log('blog', { ms: rBlog.activeMs, scroll: rBlog.maxScrollPct, bucket: rBlog.bucket, anchor: rBlog.anchor });
console.log('recipe', { ms: rRecipe.activeMs, scroll: rRecipe.maxScrollPct, bucket: rRecipe.bucket });
console.log('ghost', { ms: rGhost.activeMs, bucket: rGhost.bucket });

assert.equal(rDocs.copies, 1, 'copy detected');
assert.ok(rDocs.highlights >= 1, 'highlight detected');
assert.equal(rDocs.anchor?.kind === 'code' || rDocs.anchor?.heading === 'Authentication' || !!rDocs.anchor, true, 'anchor captured');
assert.equal(rDocs.description, 'How to authenticate API requests.');
assert.equal(rDocs.bucket, 'deep');
assert.ok(rBlog.activeMs >= 15_000 && rBlog.activeMs < 25_000, `blog time ${rBlog.activeMs}`);
assert.ok(rBlog.maxScrollPct >= 30 && rBlog.maxScrollPct <= 60, `blog scroll ${rBlog.maxScrollPct}`);
assert.equal(rBlog.bucket, 'partial');
assert.ok(rRecipe.activeMs >= 3000 && rRecipe.activeMs < 8000, `recipe time ${rRecipe.activeMs}`);
assert.equal(rRecipe.bucket, 'glanced');
assert.equal(rGhost.bucket, 'ghost');
assert.equal(rGhost.activeMs, 0);

// --- Check the dashboard ---------------------------------------------------------------------

const columns = await dash.evaluate(() => Object.fromEntries([...document.querySelectorAll('.col')].map((c) => [
  c.dataset.bucket,
  [...c.querySelectorAll('.card')].map((card) => ({
    title: card.querySelector('.title').textContent,
    summary: card.querySelector('.summary-text').textContent,
    badges: [...card.querySelectorAll('.badge')].map((b) => b.textContent).join(' '),
  })),
])));
console.log(JSON.stringify(columns, null, 2));
assert.deepEqual(columns.deep.map((c) => c.title), ['Auth API Reference']);
assert.deepEqual(columns.partial.map((c) => c.title), ['Why Rust Async Is Hard']);
assert.deepEqual(columns.glanced.map((c) => c.title), ['10 Clickbait Recipes']);
assert.deepEqual(columns.ghost.map((c) => c.title).sort(), ['Forum thread', 'Unopened resource']);
assert.match(columns.deep[0].summary, /copied a snippet/);
await dash.screenshot({ path: path.join(OUT, 'dashboard.png'), fullPage: true });

// --- Purge + undo ----------------------------------------------------------------------------

const tabCount = () => bg(async () => (await chrome.tabs.query({})).length);
const before = await tabCount();
assert.equal(await dash.locator('#purge').textContent(), 'Purge Ghost & Glanced (3)');
await dash.click('#purge');
await dash.screenshot({ path: path.join(OUT, 'purge-confirm.png') });
await dash.click('#purge-go');
await sleep(1200);
assert.equal(await tabCount(), before - 3, 'three tabs closed');
assert.match(await dash.locator('#toast-text').textContent(), /Closed 3 tabs/);
assert.equal(await dash.locator('.col[data-bucket="ghost"] .card').count(), 0);
await dash.screenshot({ path: path.join(OUT, 'after-purge.png') });

await dash.click('#toast-undo');
await sleep(2500);
assert.equal(await tabCount(), before, 'undo reopened them');
const afterUndo = await records();
const reopened = afterUndo.filter((r) => ['/recipe', '/ghost1', '/ghost2'].some((p) => r.url === BASE + p));
assert.equal(reopened.length, 3, 'no duplicate records after undo');

assert.ok(reopened.every((r) => !r.closed && r.tabId != null), 'records re-linked');
assert.ok(reopened.find((r) => r.url.endsWith('/recipe')).activeMs >= 3000, 'history kept');
assert.equal(await dash.locator('.col[data-bucket="ghost"] .card').count(), 2);

// --- Closing a deep tab shows it under "Recently closed" ------------------------------------------

await docs.close();
await sleep(1200);
assert.equal(await dash.locator('#closed .card').count(), 1);
assert.equal(await dash.locator('#closed .card .title').textContent(), 'Auth API Reference');
await dash.locator('#closed .card .jump').click(); // Reopen
await sleep(1500);
assert.equal(await dash.locator('.col[data-bucket="deep"] .card').count(), 1, 'reopened into Deep Focus');
await dash.bringToFront();

// --- Coming back to a tab adds to its time, no duplicate records ------------------------------------

const countBefore = (await records()).length;
await blog.bringToFront();
await sleep(3000);
await dash.bringToFront();
await sleep(1000);
const blog2 = await recordFor('/blog');
assert.ok(blog2.activeMs > rBlog.activeMs, 'time keeps accumulating across visits');
assert.equal((await records()).length, countBefore);

// --- Settings page -------------------------------------------------------------------------------

const settings = watch(await context.newPage());
await settings.goto(`chrome-extension://${extId}/ui/settings.html`);
await settings.click('#test');
await settings.waitForFunction(() => !document.querySelector('#test-result').textContent.startsWith('Testing'));
const testResult = await settings.locator('#test-result').textContent();
console.log('settings test:', testResult);
assert.match(testResult, /Result \(template\): Spent 2m 14s reading 88% of the page, copied a snippet, and stopped at a code block in “Authentication”\./);
await settings.check('input[value="openai"]');
assert.equal(await settings.locator('#openai-fields').isVisible(), true);
assert.equal(await settings.locator('#privacy').isVisible(), true);
await settings.selectOption('#openai-preset', { label: 'Ollama (local)' });
await settings.fill('#openai-model', 'llama3.2');
await settings.click('button[type="submit"]');
await sleep(300);
const saved = await bg(async () => (await chrome.storage.local.get('settings')).settings);
assert.equal(saved.provider, 'openai');
assert.equal(saved.openai.baseUrl, 'http://localhost:11434/v1');
await settings.screenshot({ path: path.join(OUT, 'settings.png'), fullPage: true });

// Dashboard reacts to the provider change; with no Ollama running it falls back and flags the error.
await dash.bringToFront();
await sleep(2500);
const pill = await dash.locator('#ai-status').textContent();
console.log('ai pill:', pill);
assert.match(pill, /your API/);

// Mobile width: no horizontal scroll.
await dash.setViewportSize({ width: 390, height: 844 });
await sleep(300);
const overflow = await dash.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
await dash.screenshot({ path: path.join(OUT, 'dashboard-mobile.png'), fullPage: true });

// --- Done --------------------------------------------------------------------------------------

const relevant = errors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED|11434/.test(e));
console.log('errors:', relevant.length ? relevant : 'none');
assert.equal(relevant.length, 0, 'no console errors');
await context.close();
server.close();
console.log('\nE2E PASSED');
