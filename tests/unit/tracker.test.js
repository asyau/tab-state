import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome } from './fake-chrome.js';
import { effectiveActiveMs } from '../../lib/classifier.js';

let env;
globalThis.chrome = {}; // replaced per test; modules only touch it at call time
const store = await import('../../lib/store.js');
const tracker = await import('../../lib/tracker.js');
const S = 1000;

beforeEach(() => {
  env = createFakeChrome();
  globalThis.chrome = env.chrome;
  Date.now = () => env.now;
  store.resetCache();
  tracker.resetWorkerState();
});

async function allRecords() {
  const data = await env.chrome.storage.local.get(null);
  return Object.entries(data).filter(([k]) => k.startsWith('rec:')).map(([, v]) => v);
}
async function recordFor(url) {
  return (await allRecords()).find((r) => r.url === url && !r.closed);
}
function simulateWorkerRestart() {
  store.resetCache();
  tracker.resetWorkerState();
}

/** Stay on a tab for `ms`, with the content script's 15s heartbeat like a real page. */
async function readFor(tab, ms) {
  let left = ms;
  while (left > 0) {
    const step = Math.min(15 * S, left);
    env.advance(step);
    left -= step;
    await tracker.onContentMessage({ type: 'ts:ping', url: tab.url }, env.tab(tab.id));
  }
}

/** Focus a tab the way Chrome would report it: activate, then fire onActivated. */
async function focusTab(id) {
  env.activate(id);
  await tracker.onFocusMaybeChanged();
}

test('counts active time only while a tab is focused', async () => {
  const a = env.openTab({ url: 'https://a.com/' });
  const b = env.openTab({ url: 'https://b.com/' });
  await tracker.onTabCreated(a);
  await tracker.onTabCreated(b);

  await focusTab(a.id);
  env.advance(20 * S);
  await tracker.onTick();
  env.advance(20 * S);
  await focusTab(b.id); // a: 40s
  env.advance(5 * S);
  await tracker.onFocusMaybeChanged();

  const ra = await recordFor('https://a.com/');
  assert.equal(ra.activeMs, 40 * S);
  assert.equal(ra.activeSince, null);
  assert.equal(ra.bucket, 'partial');
  const rb = await recordFor('https://b.com/');
  assert.equal(rb.activeSince, env.now - 5 * S, 'b is running');
});

test('pauses when the browser loses focus or the user goes idle', async () => {
  const a = env.openTab({ url: 'https://a.com/', active: true });
  await tracker.onFocusMaybeChanged();
  env.advance(10 * S);
  env.browserFocused = false; // switched to another app
  await tracker.onFocusMaybeChanged();
  env.advance(600 * S);
  env.browserFocused = true;
  await tracker.onFocusMaybeChanged();
  env.advance(10 * S);
  env.idle = 'locked';
  await tracker.onFocusMaybeChanged();
  env.advance(600 * S);
  await tracker.onTick();

  const r = await recordFor('https://a.com/');
  assert.equal(r.activeMs, 20 * S);
  assert.equal(r.views, 2);
  assert.ok(a);
});

test('plain "idle" (no mouse/keyboard) does not pause tracking, only "locked" does', async () => {
  // A reader who doesn't touch the mouse for a while must still be counted as deep focus.
  env.openTab({ url: 'https://a.com/', active: true });
  await tracker.onFocusMaybeChanged();
  env.idle = 'idle';
  await readFor(env.tab(1), 100 * S);
  const r1 = await recordFor('https://a.com/');
  assert.equal(r1.activeSince, env.now - 100 * S, 'segment never paused, still running');
  assert.equal(effectiveActiveMs(r1, env.now), 100 * S, 'idle-but-not-locked still counts');
  assert.equal(r1.bucket, 'deep');

  env.idle = 'locked';
  await tracker.onFocusMaybeChanged();
  env.advance(50 * S);
  await tracker.onTick();
  const r2 = await recordFor('https://a.com/');
  assert.equal(r2.activeSince, null, 'locked stops the segment');
  assert.equal(r2.activeMs, 100 * S, 'locked pauses tracking');
});

test('a missed end event is capped at the last heartbeat plus grace', async () => {
  env.openTab({ url: 'https://a.com/', active: true });
  await tracker.onFocusMaybeChanged();
  env.advance(10 * S);
  // Worker dies, laptop lid closed, no events at all for 8 hours...
  simulateWorkerRestart();
  env.advance(8 * 3600 * S);
  // ...then the first thing that happens is a tick while the same tab is still focused.
  await tracker.onTick();
  const r = await recordFor('https://a.com/');
  assert.equal(r.activeMs, 45 * S, 'counted 45s grace, not 8 hours');
  assert.equal(r.activeSince, env.now, 'a fresh segment started on wake');
});

test('ghost tabs: opened in the background, never focused', async () => {
  const bg = env.openTab({ url: 'https://ghost.com/' });
  await tracker.onTabCreated(bg);
  const r = await recordFor('https://ghost.com/');
  assert.equal(r.bucket, 'ghost');
  assert.equal(r.summary, 'Opened in the background, never viewed.');
});

test('content telemetry: scroll, highlight and copy', async () => {
  const t = env.openTab({ url: 'https://docs.com/api', active: true });
  await tracker.onFocusMaybeChanged();
  env.advance(8 * S);
  const anchor = { kind: 'code', heading: 'Authentication', snippet: 'curl -u sk_test' };
  await tracker.onContentMessage({ type: 'ts:scroll', url: t.url, pct: 64, anchor }, env.tab(t.id));
  await tracker.onContentMessage({ type: 'ts:scroll', url: t.url, pct: 40 }, env.tab(t.id));
  await tracker.onContentMessage({ type: 'ts:interaction', url: t.url, kind: 'copy', snippet: 'curl' }, env.tab(t.id));
  await tracker.onContentMessage({ type: 'ts:meta', url: t.url, description: 'API docs' }, env.tab(t.id));
  const r = await recordFor('https://docs.com/api');
  assert.equal(r.maxScrollPct, 64, 'max scroll never goes down');
  assert.equal(r.copies, 1);
  assert.deepEqual(r.anchor, anchor);
  assert.equal(r.description, 'API docs');
  assert.equal(r.bucket, 'deep');
  assert.match(r.summary, /copied a snippet, and stopped at a code block in “Authentication”/);
});

test('content messages about a page the tab already left are ignored', async () => {
  const t = env.openTab({ url: 'https://new.com/', active: true });
  await tracker.onFocusMaybeChanged();
  await tracker.onContentMessage({ type: 'ts:interaction', url: 'https://old.com/', kind: 'copy' }, env.tab(t.id));
  const r = await recordFor('https://new.com/');
  assert.equal(r.copies, 0);
  assert.equal((await allRecords()).length, 1);
});

test('navigating a tab closes the old page record and starts a new one', async () => {
  const t = env.openTab({ url: 'https://search.com/?q=x', active: true });
  await tracker.onFocusMaybeChanged();
  env.advance(4 * S);
  const nav = env.navigate(t.id, 'https://result.com/');
  await tracker.onTabUpdated(t.id, { url: nav.url }, nav);
  env.advance(30 * S);
  await tracker.onTick();

  const all = await allRecords();
  const old = all.find((r) => r.url === 'https://search.com/?q=x');
  assert.equal(old.closed, true);
  assert.equal(old.closedReason, 'navigated');
  assert.equal(old.activeMs, 4 * S);
  const cur = await recordFor('https://result.com/');
  assert.equal(cur.tabId, t.id);
  assert.equal(cur.activeSince, env.now - 30 * S);
});

test('hash changes do not create a new record', async () => {
  const t = env.openTab({ url: 'https://docs.com/page', active: true });
  await tracker.onFocusMaybeChanged();
  const nav = env.navigate(t.id, 'https://docs.com/page#section-2');
  await tracker.onTabUpdated(t.id, { url: nav.url }, nav);
  assert.equal((await allRecords()).length, 1);
});

test('state survives a service worker restart', async () => {
  const t = env.openTab({ url: 'https://a.com/', active: true });
  await tracker.onFocusMaybeChanged();
  env.advance(15 * S);
  await tracker.onContentMessage({ type: 'ts:ping', url: t.url }, env.tab(t.id));
  simulateWorkerRestart();
  env.advance(15 * S);
  await tracker.onContentMessage({ type: 'ts:ping', url: t.url }, env.tab(t.id));
  env.advance(10 * S);
  env.browserFocused = false;
  await tracker.onFocusMaybeChanged();
  const r = await recordFor('https://a.com/');
  assert.equal(r.activeMs, 40 * S);
  assert.equal(r.tabId, t.id, 'no re-linking on a mere worker restart');
});

test('browser restart: records re-link to restored tabs by URL', async () => {
  const a = env.openTab({ url: 'https://deep.com/article', active: true });
  const b = env.openTab({ url: 'https://gone.com/' });
  await tracker.onTabCreated(b);
  await tracker.onFocusMaybeChanged();
  await readFor(a, 105 * S);

  // Quit and relaunch: new tab ids, only one tab restored.
  simulateWorkerRestart();
  env.advance(12 * 3600 * S);
  const [restored] = env.restartBrowser(['https://deep.com/article']);
  await tracker.onFocusMaybeChanged();

  const all = await allRecords();
  const deep = all.find((r) => r.url === 'https://deep.com/article');
  assert.equal(deep.tabId, restored.id);
  assert.equal(deep.closed, false);
  // Quitting fires no "focus lost" event, so up to the 45s grace is counted, never the night.
  assert.ok(deep.activeMs >= 105 * S && deep.activeMs <= 150 * S, `kept history (${deep.activeMs})`);
  assert.equal(deep.bucket, 'deep');
  const gone = all.find((r) => r.url === 'https://gone.com/');
  assert.equal(gone.closed, true);
  assert.equal(gone.closedReason, 'session-ended');
});

test('a restored tab that loads late still re-links', async () => {
  env.openTab({ url: 'https://late.com/', active: true });
  await tracker.onFocusMaybeChanged();
  await readFor(env.tab(1), 50 * S);
  simulateWorkerRestart();
  const [blank] = env.restartBrowser(['chrome://newtab/']);
  await tracker.onFocusMaybeChanged(); // session starts; late.com has no tab yet
  env.advance(3 * S);
  const loaded = env.navigate(blank.id, 'https://late.com/');
  await tracker.onTabUpdated(blank.id, { url: loaded.url }, loaded);
  const r = await recordFor('https://late.com/');
  assert.ok(r, 'revived');
  assert.equal(r.tabId, blank.id);
  assert.ok(r.activeMs >= 50 * S);
  assert.equal((await allRecords()).length, 1);
});

test('closing a tab keeps its record as closed', async () => {
  const t = env.openTab({ url: 'https://a.com/', active: true });
  await tracker.onFocusMaybeChanged();
  await readFor(t, 100 * S);
  env.tabs.delete(t.id);
  await tracker.onTabRemoved(t.id);
  const [r] = await allRecords();
  assert.equal(r.closed, true);
  assert.equal(r.closedReason, 'closed');
  assert.equal(r.activeMs, 100 * S);
});

test('purge closes tabs and undo restores them with their history', async () => {
  const focus = env.openTab({ url: 'https://work.com/', active: true });
  const g1 = env.openTab({ url: 'https://g1.com/' });
  const g2 = env.openTab({ url: 'https://g2.com/' });
  for (const t of [g1, g2]) await tracker.onTabCreated(t);
  await tracker.onFocusMaybeChanged();
  await readFor(focus, 30 * S);
  const ids = (await allRecords()).filter((r) => r.bucket === 'ghost').map((r) => r.id);
  assert.equal(ids.length, 2);

  const { closed } = await tracker.purge(ids);
  assert.equal(closed, 2);
  assert.equal(env.tabs.size, 1, 'only the focused tab is left');
  for (const r of await allRecords()) if (ids.includes(r.id)) assert.equal(r.closedReason, 'purged');
  await tracker.onTabRemoved(g1.id); // Chrome's event arrives after; must be harmless

  const { opened } = await tracker.restore(ids);
  assert.equal(opened, 2);
  assert.equal(env.tabs.size, 3);
  // New tabs start blank with a pendingUrl, then commit. Must stay linked to the same records.
  for (const tab of [...env.tabs.values()].filter((t) => t.pendingUrl)) {
    await tracker.onTabUpdated(tab.id, { status: 'loading' }, env.tab(tab.id));
    const committed = env.commit(tab.id);
    await tracker.onTabUpdated(tab.id, { url: committed.url }, committed);
  }
  const all = await allRecords();
  assert.equal(all.length, 3, 'no duplicate records');
  for (const r of all) assert.equal(r.closed, false);
  assert.ok(focus);
});

test('a straggling tab event during purge does not resurrect a duplicate record', async () => {
  // Real Chrome: tabs.remove() is async. An onUpdated for the dying tab (title/favicon settling,
  // a final redirect) can still be in flight when purge() has already cleared the record's tabId.
  // Without the pending-removal guard that event looks like a brand-new tab.
  const g1 = env.openTab({ url: 'https://g1.com/' });
  await tracker.onTabCreated(g1);
  const [rec] = await allRecords();
  const staleTab = env.tab(g1.id); // snapshot before the tab is actually gone

  await tracker.purge([rec.id]);
  assert.equal(env.tabs.size, 0);

  // The straggler arrives before Chrome's onRemoved does.
  await tracker.onTabUpdated(staleTab.id, { status: 'complete' }, staleTab);
  let all = await allRecords();
  assert.equal(all.length, 1, 'no duplicate created by the straggling update');
  assert.equal(all[0].closedReason, 'purged', 'original record untouched');

  // onRemoved finally arrives; must stay a no-op (already closed) and clear the guard.
  await tracker.onTabRemoved(staleTab.id);
  all = await allRecords();
  assert.equal(all.length, 1);
  assert.equal(all[0].closedReason, 'purged');

  // A later, genuinely new tab for the same URL must work normally again, not be silently
  // swallowed forever by a guard that outlived its purpose.
  const fresh = env.openTab({ url: 'https://g1.com/' });
  await tracker.onTabCreated(fresh);
  all = await allRecords();
  assert.equal(all.filter((r) => !r.closed).length, 1, 'tracking resumes for a new tab');
});

test('prune drops old low-value closed records but keeps deep ones for a week', async () => {
  const t1 = env.openTab({ url: 'https://low.com/', active: true });
  await tracker.onFocusMaybeChanged();
  env.advance(5 * S);
  const t2 = env.openTab({ url: 'https://deep.com/' });
  await focusTab(t2.id);
  await readFor(t2, 120 * S);
  await focusTab(t1.id);
  for (const t of [t1, t2]) { env.tabs.delete(t.id); await tracker.onTabRemoved(t.id); }

  env.advance(2 * 3600 * S);
  await tracker.onTick();
  let urls = (await allRecords()).map((r) => r.url);
  assert.deepEqual(urls, ['https://deep.com/']);

  env.advance(8 * 24 * 3600 * S);
  await tracker.onTick();
  assert.equal((await allRecords()).length, 0);
});

test('non-web pages are not tracked', async () => {
  const t = env.openTab({ url: 'chrome://settings/', active: true });
  await tracker.onTabCreated(t);
  await tracker.onFocusMaybeChanged();
  assert.equal((await allRecords()).length, 0);
});

// --- Follow-up notes ------------------------------------------------------------------------

test('setNote flags a tab as follow-up, and purge refuses it even if asked directly', async () => {
  const g = env.openTab({ url: 'https://isaac-sim.example.com/', active: false });
  await tracker.onTabCreated(g);
  const [rec] = await allRecords();
  assert.equal(rec.bucket, 'ghost', 'never focused, would normally be purge-eligible');

  await tracker.setNote({ id: rec.id, note: 'want to read and learn this sometime' });
  const noted = await recordFor('https://isaac-sim.example.com/');
  assert.equal(noted.note, 'want to read and learn this sometime');

  const { closed } = await tracker.purge([rec.id]); // explicitly asked to purge it anyway
  assert.equal(closed, 0, 'purge refuses a noted record');
  const stillOpen = await recordFor('https://isaac-sim.example.com/');
  assert.ok(stillOpen, 'record was not closed');

  await tracker.setNote({ id: rec.id, note: '' }); // clearing the note lifts the protection
  const { closed: closedAfterClear } = await tracker.purge([rec.id]);
  assert.equal(closedAfterClear, 1);
});

// --- Editable thresholds ---------------------------------------------------------------------

test('a custom threshold saved in settings changes how the tracker classifies', async () => {
  await env.chrome.storage.local.set({ settings: { thresholds: { glancedMaxMs: 3000 } } });
  const t = env.openTab({ url: 'https://a.com/', active: true });
  await tracker.onFocusMaybeChanged();
  await tracker.onContentMessage({ type: 'ts:ping', url: t.url }, env.tab(t.id)); // ~0s elapsed yet
  env.advance(4 * S);
  await tracker.onContentMessage({ type: 'ts:ping', url: t.url }, env.tab(t.id));
  const r = await recordFor('https://a.com/');
  // Default glancedMaxMs (15s) would still call 4s "glanced"; the 3s override makes it "partial".
  assert.equal(r.bucket, 'partial', 'custom threshold applied, not the hardcoded default');
});

// --- Daily check-list -------------------------------------------------------------------------

test('watchlist add/remove/list', async () => {
  assert.deepEqual((await tracker.getWatchlist()), []);
  const { watchlist } = await tracker.addWatch({ domain: 'Gmail.com', label: 'Gmail' });
  assert.deepEqual(watchlist, [{ domain: 'gmail.com', label: 'Gmail', addedAt: env.now }]);
  await tracker.addWatch({ domain: 'gmail.com', label: 'duplicate, ignored' });
  assert.equal((await tracker.getWatchlist()).length, 1, 'adding the same domain twice is a no-op');
  const { watchlist: afterRemove } = await tracker.removeWatch({ domain: 'gmail.com' });
  assert.deepEqual(afterRemove, []);
});

test('isCheckedToday reflects real activity on that domain since local midnight', async () => {
  const t = env.openTab({ url: 'https://mail.example.com/inbox', active: true });
  assert.equal(tracker.isCheckedToday('mail.example.com', env.now), false);
  await tracker.onFocusMaybeChanged();
  env.advance(5 * S);
  await tracker.onContentMessage({ type: 'ts:ping', url: t.url }, env.tab(t.id));
  assert.equal(tracker.isCheckedToday('mail.example.com', env.now), true);
  assert.equal(tracker.isCheckedToday('other.example.com', env.now), false);
});
