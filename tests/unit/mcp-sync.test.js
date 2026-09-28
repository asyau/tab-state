import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { toSyncTab, buildSyncPayload, syncToMcpServer, findMcpServer, resetMcpDiscovery, MCP_PORTS } from '../../lib/mcp-sync.js';
import { mergeSettings } from '../../lib/settings.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; resetMcpDiscovery(); });

const rec = (over = {}) => ({
  id: 'r1', url: 'https://docs.stripe.com/auth', title: 'Auth', description: 'API keys.',
  note: '', summary: 'Spent 2m reading.', activeMs: 120_000, activeSince: null, lastSeen: null,
  maxScrollPct: 90, copies: 1, highlights: 0, lastActiveAt: 500, createdAt: 100, closed: false, ...over,
});

test('toSyncTab exposes only what the MCP server needs, with the bucket computed fresh', () => {
  const t = toSyncTab(rec(), 1000);
  assert.deepEqual(Object.keys(t).sort(), [
    'activeMs', 'bucket', 'closed', 'createdAt', 'description', 'id', 'lastActiveAt', 'note', 'scrollPct', 'summary', 'title', 'url',
  ].sort());
  assert.equal(t.bucket, 'deep');
  assert.equal(t.id, 'r1');
});

test('toSyncTab truncates long fields the same way the rest of the app does', () => {
  const t = toSyncTab(rec({ title: 'x'.repeat(500), note: 'y'.repeat(900) }), 1000);
  assert.ok(t.title.length <= 200);
  assert.ok(t.note.length <= 500);
});

test('buildSyncPayload includes a deterministic recap built from open tabs only', () => {
  const open = rec({ id: 'open', closed: false });
  const closed = rec({ id: 'closed', closed: true });
  const payload = buildSyncPayload([open, closed], 1000);
  assert.equal(payload.tabs.length, 2, 'both open and closed tabs are still synced for history');
  assert.match(payload.recap, /Tracked 1 tab/, 'recap counts only the open tab');
});

test('syncToMcpServer is a complete no-op when disabled — no network call at all', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; };
  const out = await syncToMcpServer([rec()], 1000, undefined, { enabled: false, port: 8765 });
  assert.deepEqual(out, { sent: false });
  assert.equal(called, false);
});

test('syncToMcpServer POSTs the payload to 127.0.0.1:<port>/sync when enabled', async () => {
  let call;
  globalThis.fetch = async (url, init) => { call = { url, init }; return { ok: true, status: 200 }; };
  const out = await syncToMcpServer([rec()], 1000, undefined, { enabled: true, port: 9999 });
  assert.equal(out.sent, true);
  assert.equal(call.url, 'http://127.0.0.1:9999/sync');
  assert.equal(call.init.method, 'POST');
  const body = JSON.parse(call.init.body);
  assert.equal(body.tabs[0].id, 'r1');
  assert.match(body.recap, /Tracked 1 tab/);
});

test('syncToMcpServer never throws when the local server is unreachable', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const out = await syncToMcpServer([rec()], 1000, undefined, { enabled: true, port: 8765 });
  assert.equal(out.sent, false);
  assert.match(out.error, /ECONNREFUSED/);
});

// --- Automatic port discovery ------------------------------------------------------------------
// A fake "localhost": which ports answer /health with what, and a log of every request.
function fakeLocalhost(ports) {
  const log = [];
  globalThis.fetch = async (url, init = {}) => {
    const { port, pathname } = new URL(url);
    log.push(`${init.method || 'GET'} ${port}${pathname}`);
    const app = ports[port];
    if (!app) throw new Error('ECONNREFUSED');
    if (pathname === '/health') {
      return { ok: true, status: 200, json: async () => { if (app === 'anki') throw new SyntaxError('not JSON'); return app; } };
    }
    return { ok: app?.service === 'tab-state' || app?.ok === true, status: 200 };
  };
  return log;
}

test('automatic: skips another app on the first port and syncs to the Tab State server it finds', async () => {
  const log = fakeLocalhost({ [MCP_PORTS[0]]: 'anki', [MCP_PORTS[1]]: { ok: true, service: 'tab-state' } });
  const out = await syncToMcpServer([rec()], 1000, undefined, { enabled: true, port: null });
  assert.equal(out.sent, true);
  assert.equal(out.port, MCP_PORTS[1]);
  assert.ok(!log.some((l) => l === `POST ${MCP_PORTS[0]}/sync`), 'never sends tab data to the other app');
});

test('automatic: a lookalike {ok:true} on a candidate port is not trusted; on the old 8765 it is', async () => {
  fakeLocalhost({ [MCP_PORTS[0]]: { ok: true } });
  assert.equal(await findMcpServer(), null);
  resetMcpDiscovery();
  fakeLocalhost({ 8765: { ok: true } });
  assert.equal(await findMcpServer(), 8765, 'servers installed before the change still work');
});

test('automatic: remembers the port (no re-probing each sync) and searches again if the server moved', async () => {
  let log = fakeLocalhost({ [MCP_PORTS[2]]: { ok: true, service: 'tab-state' } });
  await syncToMcpServer([rec()], 1000, undefined, { enabled: true });
  log.length = 0;
  await syncToMcpServer([rec()], 1000, undefined, { enabled: true });
  assert.deepEqual(log, [`POST ${MCP_PORTS[2]}/sync`], 'straight to the known port');
  log = fakeLocalhost({ [MCP_PORTS[0]]: { ok: true, service: 'tab-state' } }); // restarted elsewhere
  const out = await syncToMcpServer([rec()], 1000, undefined, { enabled: true });
  assert.equal(out.port, MCP_PORTS[0]);
});

test('automatic: nothing running is a quiet no-op with a helpful reason', async () => {
  fakeLocalhost({});
  const out = await syncToMcpServer([rec()], 1000, undefined, { enabled: true });
  assert.equal(out.sent, false);
  assert.match(out.error, /No Tab State server found/);
});

test('settings: the old saved default 8765 means automatic; a port the user chose is kept', () => {
  assert.equal(mergeSettings({ mcpSync: { enabled: true, port: 8765 } }).mcpSync.port, null);
  assert.equal(mergeSettings({ mcpSync: { enabled: true, port: 9000 } }).mcpSync.port, 9000);
  assert.equal(mergeSettings({}).mcpSync.port, null);
  assert.equal(mergeSettings({ mcpSync: { port: 'abc' } }).mcpSync.port, null);
});
