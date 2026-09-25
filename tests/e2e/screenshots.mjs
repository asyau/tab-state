// Generates Chrome Web Store listing screenshots (1280x800) from the real extension in real
// Chromium — not mockups. Separate from run.mjs (which asserts correctness); this only captures.
//
//   node tests/e2e/screenshots.mjs
//   HEADED=1 node tests/e2e/screenshots.mjs   (to watch it)

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.E2E_OUT || path.join(ROOT, 'docs/screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIZE = { width: 1280, height: 800 };

const para = (n) => Array.from({ length: n }, (_, i) =>
  `<p>Paragraph ${i + 1}. ${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6)}</p>`).join('\n');

const PAGES = {
  '/docs': `<title>Authentication — Stripe API Reference</title><meta name="description" content="How to authenticate API requests.">
    <h1>API Reference</h1>${para(6)}<h2>Installation</h2>${para(8)}
    <h2>Authentication</h2>${para(4)}<pre><code>curl https://api.example.com/v1/charges -u sk_test_123:</code></pre>${para(10)}`,
  '/rust': `<title>Why Rust Async Is Hard — a deep dive</title><meta name="description" content="Pinning, executors and why futures feel harder than threads."><h1>Why Rust async is hard</h1>${para(5)}
    <h2>Pinning</h2>${para(10)}<h2>Executors</h2>${para(10)}`,
  '/isaac': `<title>NVIDIA Isaac Sim — Getting Started</title><meta name="description" content="A robotics simulator for training and testing AI-driven robots."><h1>Isaac Sim</h1>${para(20)}`,
  '/recipe': `<title>10 Clickbait Pasta Recipes You Won't Believe</title><meta name="description" content="A listicle of pasta recipes, mostly ads."><h1>Recipes</h1>${para(40)}`,
  '/thread': `<title>Random forum thread about keyboards</title><meta name="description" content="Users argue about switch types and keycap profiles."><h1>Thread</h1><p>Hello</p>`,
  '/newsletter': `<title>Weekly Dev Newsletter #142</title><meta name="description" content="This week: a new bundler, Postgres tips and an API design essay."><h1>Newsletter</h1><p>Hello</p>`,
  '/gmail': `<title>Inbox — Gmail</title><meta name="description" content="Your email, organized."><h1>Inbox</h1>${para(3)}`,
};

const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const body = PAGES[p];
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body ? `<!doctype html><html><body style="font:16px/1.6 sans-serif;max-width:700px;margin:auto">${body}</body></html>` : 'nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext('', {
  headless: !process.env.HEADED,
  channel: 'chromium',
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  viewport: SIZE,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const DASH = `chrome-extension://${extId}/ui/dashboard.html`;
const bg = (fn, arg) => sw.evaluate(fn, arg);

async function open(p, { ms = 400 } = {}) {
  const page = await context.newPage();
  await page.setViewportSize(SIZE);
  await page.goto(BASE + p);
  await page.bringToFront();
  await sleep(ms);
  return page;
}

// Deep focus: read to the code block, copy it, highlight a paragraph.
const docs = await open('/docs');
await docs.evaluate(() => document.querySelector('pre').scrollIntoView({ block: 'center' }));
await sleep(1400);
await docs.evaluate(() => {
  const range = document.createRange();
  range.selectNodeContents(document.querySelector('pre code'));
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  document.execCommand('copy');
});
await sleep(300);

// Ghost, but noted: opened Isaac Sim, barely looked, don't want to lose it (mirrors the exact
// "I have Isaac Sim open, want to learn it later" scenario this feature is built for).
const isaac = await open('/isaac');
await sleep(1200);

// Partially read: needs to clear glancedMaxMs (15s) to land here, not just a quick scroll.
const rust = await open('/rust');
await rust.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.35));
await sleep(19_000);

// Just glanced.
await open('/recipe', { ms: 4000 });

// Ghosts, opened in the background, never focused at all.
await bg(async (base) => {
  await chrome.tabs.create({ url: `${base}/thread`, active: false });
  await chrome.tabs.create({ url: `${base}/newsletter`, active: false });
}, BASE);
await sleep(1200);

// Gmail: a real (if brief) look — enough to clear "ghost" — then watched daily.
const gmail = await open('/gmail', { ms: 4000 });

const dash = await context.newPage();
await dash.setViewportSize(SIZE);
await dash.goto(DASH);
await dash.bringToFront();
await sleep(1500);

// Add a note to the Isaac Sim card so the Follow Up section and note UI show in the screenshot.
const isaacCard = dash.locator('.card', { hasText: 'NVIDIA Isaac Sim' }).first();
await isaacCard.locator('.note-toggle').click();
await isaacCard.locator('.note-input').fill("Want to actually learn this — don't lose it");
await dash.locator('#stats').click();
await sleep(800);

// Watch Gmail daily.
await dash.locator('.card', { hasText: 'Inbox — Gmail' }).first().locator('.watch-toggle').click();
await sleep(1000);

await dash.screenshot({ path: path.join(OUT, '1-dashboard.png') });
console.log('saved 1-dashboard.png');

await dash.click('#purge');
await sleep(300);
await dash.screenshot({ path: path.join(OUT, '3-purge-confirm.png') });
console.log('saved 3-purge-confirm.png');
await dash.click('#purge-cancel');
await sleep(300);

// Card detail view: click-to-expand, AI insight, and the (non-screenshot) preview.
await dash.locator('.col[data-bucket="deep"] .card', { hasText: 'Authentication' }).locator('.favicon').click();
await sleep(500);
await dash.screenshot({ path: path.join(OUT, '2-detail.png') });
console.log('saved 2-detail.png');
await dash.keyboard.press('Escape');
await sleep(300);

const settings = await context.newPage();
await settings.setViewportSize(SIZE);
await settings.goto(`chrome-extension://${extId}/ui/settings.html`);
await settings.bringToFront();
await sleep(800);
await settings.screenshot({ path: path.join(OUT, '4-settings.png') });
console.log('saved 4-settings.png');

await context.close();
server.close();
console.log(`\nDone. Screenshots in ${OUT}`);
