// Settings page, in the real extension: the "Connect your AI assistant" guide (assistant tabs,
// arrow-key navigation, copy buttons, the live connection status against a real local server) and
// the page's layout at wide, medium and narrow widths.
//
//   node tests/e2e/settings.mjs              (part of npm run test:e2e)
//   OUT=/some/dir node tests/e2e/settings.mjs   (also save screenshots)
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { dismissWelcomeTab } from './welcome-tab.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.OUT; // screenshots only when set
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const context = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  viewport: { width: 1700, height: 1000 }, colorScheme: process.env.DARK ? 'dark' : 'light',
  permissions: ['clipboard-read', 'clipboard-write'],
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`] });
let [sw] = context.serviceWorkers(); if (!sw) sw = await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
await dismissWelcomeTab(sw);
const page = await context.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`chrome-extension://${extId}/ui/settings.html`);
await sleep(600);
if (OUT) await page.screenshot({ path: path.join(OUT, 's1-wide.png'), fullPage: true });
// tabs: Claude Desktop first and selected by default, with a one-click download
assert.equal(await page.isVisible('#pane-claude-desktop'), true, 'Claude Desktop is the default tab');
assert.equal(await page.getAttribute('#pane-claude-desktop .st-download', 'href'),
  'https://github.com/asyau/tab-state/releases/download/claude-desktop/tab-state.mcpb');
await page.click('#tab-codex');
assert.equal(await page.isVisible('#pane-codex'), true); assert.equal(await page.isVisible('#pane-claude-desktop'), false);
await page.keyboard.press('ArrowRight'); assert.equal(await page.isVisible('#pane-chatgpt'), true);
await page.keyboard.press('Home'); assert.equal(await page.isVisible('#pane-claude-desktop'), true);
// the Claude Code tab says its commands are for the terminal app, and links over to Claude Desktop
await page.click('#tab-claude-code');
await page.click('#pane-claude-code .st-copy >> nth=0');
const clip = await page.evaluate(() => navigator.clipboard.readText());
console.log('copied:', clip); assert.equal(clip, '/plugin marketplace add asyau/tab-state');
await page.click('#pane-claude-code [data-go-pane="claude-desktop"]');
assert.equal(await page.isVisible('#pane-claude-desktop'), true, 'callout switches to the Claude Desktop tab');
// sync on: not connected -> pill warn; then start fake server -> connected
await page.click('.st-advanced summary'); await page.fill('#mcp-port', '9955'); await page.locator('#mcp-port').dispatchEvent('change');
await page.check('#mcp-enabled'); await sleep(500);
console.log('pill:', await page.textContent('#mcp-pill'));
// A stand-in for the Tab State server on a free port (8765 may be taken by a real one).
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); r.end('{"ok":true}'); });
await new Promise((r) => srv.listen(9955, '127.0.0.1', r));
await sleep(5600);
console.log('pill after server start:', await page.textContent('#mcp-pill'));
assert.equal(await page.textContent('#mcp-pill'), 'Connected');
await page.click('#tab-chatgpt');
if (OUT) await page.screenshot({ path: path.join(OUT, 's2-connected-chatgpt.png'), fullPage: true });
await page.setViewportSize({ width: 1280, height: 900 }); await sleep(200);
await page.click('#tab-claude-code');
if (OUT) await page.screenshot({ path: path.join(OUT, 's3-1280.png'), fullPage: true });
await page.setViewportSize({ width: 700, height: 900 }); await sleep(200);
assert.equal(await page.isVisible('#pane-claude-code'), true);
if (OUT) await page.screenshot({ path: path.join(OUT, 's4-narrow.png'), fullPage: true });
srv.close();
assert.deepEqual(errs, []);
// Section menu: Summaries is highlighted at the top, not Sorting beside it.
await page.evaluate(() => window.scrollTo(0, 0)); await sleep(100);
assert.equal(await page.textContent('.st-nav-link.active'), 'Summaries');
console.log('SETTINGS E2E PASSED');
await context.close();
