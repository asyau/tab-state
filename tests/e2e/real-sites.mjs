// Runs the real extension against REAL websites (needs internet) and prints what it captured:
// topic (meta description / <h1> fallback), bucket, favicon. This is the check the synthetic
// local pages in run.mjs can't give you: real markup, real favicons, real SPAs.
//
//   node tests/e2e/real-sites.mjs        (HEADED=1 to watch)
//
// Not part of CI: it depends on third-party sites being up.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.E2E_OUT || path.join(ROOT, 'tests/e2e/output');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIZE = { width: 1280, height: 800 };

const SITES = [
  // [url, seconds to "read", scroll fraction]
  ['https://en.wikipedia.org/wiki/Web_browser', 20, 0.4],
  ['https://developer.mozilla.org/en-US/docs/Web/API/Window/scrollY', 8, 0.2],
  ['https://github.com/asyau/tab-state', 5, 0],
  ['https://news.ycombinator.com/', 3, 0],
];
const BACKGROUND = ['https://example.com/', 'https://www.iana.org/domains/reserved'];

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
const errors = [];
sw.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

for (const [url, seconds, scroll] of SITES) {
  const page = await context.newPage();
  await page.setViewportSize(SIZE);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => console.log('nav problem', url, e.message));
  await page.bringToFront();
  if (scroll) await page.evaluate((f) => window.scrollTo(0, document.body.scrollHeight * f), scroll);
  await sleep(seconds * 1000);
}
for (const url of BACKGROUND) {
  await sw.evaluate((u) => chrome.tabs.create({ url: u, active: false }), url);
}
await sleep(3000);

const dash = await context.newPage();
await dash.setViewportSize(SIZE);
await dash.goto(`chrome-extension://${extId}/ui/dashboard.html`);
await dash.bringToFront();
await sleep(2500);

const cards = await dash.evaluate(() => [...document.querySelectorAll('#board .card')].map((c) => ({
  bucket: c.closest('.col').dataset.bucket,
  title: c.querySelector('.title').textContent,
  summary: c.querySelector('.summary-text').textContent,
  favicon: (() => { const i = c.querySelector('.favicon'); return i.complete && i.naturalWidth > 0 ? `${i.naturalWidth}px` : 'not loaded'; })(),
})));
for (const c of cards) {
  console.log(`\n[${c.bucket}] ${c.title}\n  ${c.summary}\n  favicon: ${c.favicon}`);
}
await dash.screenshot({ path: path.join(OUT, 'real-sites-dashboard.png') });

console.log('\nservice worker errors:', errors.length ? errors : 'none');
await context.close();
