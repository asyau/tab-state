// Loads an extension folder in real Chromium and checks it starts cleanly: service worker up,
// dashboard and settings render, no console errors. Point EXT_DIR at an UNZIPPED store package to
// verify exactly what will be uploaded (npm run test:smoke does this).
//
//   EXT_DIR=/path/to/unzipped node tests/e2e/smoke.mjs

import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = process.env.EXT_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext('', {
  headless: !process.env.HEADED,
  channel: 'chromium',
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
const problems = [];
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
sw.on('console', (m) => { if (m.type() === 'error') problems.push(`sw: ${m.text()}`); });
const extId = new URL(sw.url()).host;
const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
console.log(`loaded ${manifest.name} ${manifest.version} from ${ROOT}`);

async function visit(name, file, expectSelectors) {
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${name}: ${e.message}`));
  await page.goto(`chrome-extension://${extId}/ui/${file}`);
  await sleep(1200);
  for (const sel of expectSelectors) assert.ok(await page.locator(sel).count() > 0, `${name}: missing ${sel}`);
  return page;
}

await visit('dashboard', 'dashboard.html', ['#board', '.col[data-bucket="deep"]', '#purge', '#detail-modal']);
await visit('settings', 'settings.html', ['#form', '#thresholds-form', '#grouping-enabled', '#watchlist']);

const web = await context.newPage();
await web.goto('data:text/html,<title>smoke</title><h1>hello</h1>');
await sleep(500);

assert.deepEqual(problems, [], `console/page errors: ${problems.join(' | ')}`);
await context.close();
console.log('SMOKE PASSED');
