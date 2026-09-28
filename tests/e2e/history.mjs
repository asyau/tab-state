// History page, in the real extension: seeds ~130 records shaped like a real day (8 ChatGPT tabs,
// repeat visits, lots of quick ones, a note, earlier days) and drives every interaction —
// grouping, filters, hover/keyboard/pinned details, the time bar's legend, the narrow-window sheet.
//
//   node tests/e2e/history.mjs              (part of npm run test:e2e)
//   OUT=/some/dir node tests/e2e/history.mjs   (also save screenshots)
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { dismissWelcomeTab } from './welcome-tab.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.OUT; // screenshots only when set
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const context = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  viewport: { width: 1700, height: 860 }, colorScheme: process.env.DARK ? 'dark' : 'light',
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`] });
let [sw] = context.serviceWorkers(); if (!sw) sw = await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
await dismissWelcomeTab(sw);
await sw.evaluate(async () => {
  const now = Date.now(); const S = 1000; let i = 0; const out = {};
  const add = (url, title, activeMs, extra = {}) => { i++; const t = now - i * 97 * S - (extra.dayAgo ? 86400 * S : 0);
    out[`rec:h${i}`] = { id: `h${i}`, key: url, url, title, description: '', tabId: null, windowId: 1, createdAt: t - 5000, lastActiveAt: t, activeMs, activeSince: null, lastSeen: t, views: 1, maxScrollPct: Math.min(100, activeMs / 3000), highlights: 0, copies: 0, anchor: null, selectionSnippet: '', note: '', bucket: 'x', summary: '', ai: null, closed: true, closedAt: t, closedReason: 'closed', ...extra }; };
  add('https://www.amazon.jobs/en/jobs/10554706', '2027 Software Dev Engineer Intern - Luxembourg - Job ID: 10554706 | Amazon.jobs', 5 * S);
  add('https://gemini.google.com/app/1', "Understanding the Paper's Dual Model - Google Gemini", 387 * S, { copies: 2, anchor: { heading: 'Dual model', snippet: 'The encoder and decoder share…' } });
  add('https://gemini.google.com/app/2', 'Google Gemini', 23 * S);
  add('https://gemini.google.com/app', 'Google Gemini', 0);
  add('https://www.google.com/search?q=gemini', 'gemini - Google Search', 2 * S);
  add('https://miper.ai/', 'Miper — A second brain that knows you', 13 * S, { note: 'look at their onboarding' });
  for (const [u, t, s] of [['/c/1','ChatGPT',7],['/desktop','ChatGPT Masaüstü\'nü aç',0],['/codex','ChatGPT ile Codex oturumu aç - OpenAI',3],['/inbox','Gelen kutunu kontrol et - OpenAI',19],['/c/2','ChatGPT',0],['/','ChatGPT: Chat, Work, Create & Code with AI',14],['/c/3','ChatGPT',7],['/c/4','ChatGPT',4]]) add('https://chatgpt.com' + u, t, s * S);
  for (const [u, t, s] of [['/billing','Billing | Higgsfield API',21],['/cashback','Cashback | Higgsfield API',99],['/verify','Verify business email | Higgsfield API',20],['/cashback?2','Cashback | Higgsfield API',45]]) add('https://platform.higgsfield.ai' + u, t, s * S);
  add('https://outlook.office.com/mail/1', 'Posta - Miper Ai - Outlook', 3 * S);
  add('https://outlook.office.com/mail/2', 'Posta - Miper Ai - Outlook', 23 * S);
  for (let k = 0; k < 70; k++) add(`https://site${k % 23}.example.com/p${k}`, `Some page number ${k} on site ${k % 23}`, (k % 5 === 0 ? 30 + k : k % 7) * S);
  for (let k = 0; k < 40; k++) add(`https://old${k % 9}.example.org/p${k}`, `Yesterday page ${k}`, (k % 4 === 0 ? 60 + k : 3) * S, { dayAgo: true });
  await chrome.storage.local.set(out);
});
const page = await context.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`chrome-extension://${extId}/ui/history.html`);
await page.waitForSelector('.hs-day');
const shot = (n) => (OUT ? page.screenshot({ path: path.join(OUT, n) }) : null);
await shot('h1-rest.png');
console.log('stats:', await page.textContent('#stats'), '|', await page.textContent('#hs-showing'));

// hide-quick default on: count rows; toggling reveals more
const visibleNav = () => page.$$eval('.hs-nav', (els) => els.filter((e) => e.offsetParent).length);
const before = await visibleNav();
const hiddenNote = await page.textContent('.hs-day .hs-hidden-note');
assert.match(hiddenNote, /quick visits? hidden/);
// ChatGPT grouped into one head
const heads = await page.$$eval('.hs-group-head .hs-row-title', (els) => els.map((e) => e.textContent));
console.log('groups:', heads.slice(0, 8).join(', '));
assert.ok(heads.includes('chatgpt.com') && heads.includes('platform.higgsfield.ai'));
// group order: gemini first (most time)
const firstItem = await page.$eval('.hs-day .hs-groups > *', (e) => e.textContent);
assert.match(firstItem, /Gemini|gemini/, 'most-read site first');

// hover a row -> panel shows it
await page.hover('.hs-row:visible >> nth=0'); await sleep(250);
assert.equal(await page.isVisible('#hs-panel-body'), true);
const t1 = await page.textContent('#detail-title');
await shot('h2-hover.png');
// expand chatgpt group
assert.match(await page.textContent('.hs-group-head:has-text("chatgpt.com") .hs-visits'), /of 8 tabs/, 'group counts every visit, not just the shown ones');
await page.click('.hs-group-head:has-text("chatgpt.com")');
assert.equal(await page.getAttribute('.hs-group-head:has-text("chatgpt.com")', 'aria-expanded'), 'true');
await shot('h3-expanded.png');
// keyboard: focus first nav, ArrowDown twice changes selection
await page.mouse.move(5, 5);
await page.focus('.hs-nav >> nth=0'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
const focused = await page.evaluate(() => document.activeElement.className);
assert.match(focused, /is-selected/, 'keyboard focus drives the details panel');
console.log('focus after arrows:', focused, '| panel:', await page.textContent('#detail-title'), '(was', t1, ')');
// toggle quick off
await page.click('.hs-switch');
const after = await visibleNav();
console.log('nav items: hideQuick on', before, '-> off', after); assert.ok(after > before);
await page.click('.hs-switch');
// search
await page.fill('#hs-query', 'cashback'); await sleep(300);
const rows = await page.$$eval('.hs-row', (els) => els.filter((e) => e.offsetParent).map((e) => e.querySelector('.hs-row-title').textContent));
console.log('search rows:', rows); assert.ok(rows.length === 2 && rows.every((r) => /Cashback/.test(r)));
await shot('h4-search.png');
await page.fill('#hs-query', ''); await sleep(300);
// ghost chip
await page.click('.hs-chip[data-bucket="ghost"]'); await sleep(100);
const ghostRows = await page.$$eval('.hs-row', (els) => els.filter((e) => e.offsetParent).map((e) => e.querySelector('.row-stat').textContent));
console.log('ghost filter stats:', [...new Set(ghostRows)]); assert.ok(ghostRows.length > 0 && ghostRows.every((s) => s === 'unread'));
await page.click('.hs-chip[data-bucket="ghost"]');
// legend click filters to site
await page.click('.hs-legend-item:has-text("platform.higgsfield.ai")'); await sleep(200);
assert.equal(await page.inputValue('#hs-query'), 'platform.higgsfield.ai');
await page.fill('#hs-query', ''); await sleep(300);
// click pins; hover elsewhere doesn't change
await page.click('.hs-row:visible >> nth=1'); const pinned = await page.textContent('#detail-title');
await page.hover('.hs-row:visible >> nth=4'); await sleep(250);
assert.equal(await page.textContent('#detail-title'), pinned, 'click pins the panel');
await page.keyboard.press('Escape');
// narrow
await page.setViewportSize({ width: 700, height: 860 }); await sleep(200);
await shot('h5-narrow.png');
await page.click('.hs-row:visible >> nth=0'); await sleep(200);
assert.equal(await page.isVisible('#hs-panel'), true); await shot('h6-narrow-sheet.png');
await page.keyboard.press('Escape'); await sleep(100);
assert.equal(await page.isVisible('#hs-panel'), false);
assert.deepEqual(errs, [], 'no page errors');
console.log('HISTORY E2E PASSED');
await context.close();
