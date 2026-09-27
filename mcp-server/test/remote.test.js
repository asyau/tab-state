// Remote mode (for ChatGPT, which only reaches MCP servers over HTTPS): the same tools over
// Streamable HTTP, behind a secret token, on a listener that serves nothing else. And the
// multi-client case: a second copy of the server must share the sync port, not crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemoteServer, loadOrCreateToken } from '../server.mjs';
import { save } from '../store.mjs';

const MCP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'x'.repeat(20) + 'remote-test-token-0123456789';

async function withRemote(fn) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ts-remote-'));
  save({ tabs: [{ id: 'a', url: 'https://docs.stripe.com/auth', title: 'Stripe auth', bucket: 'deep' }], recap: 'r', syncedAt: 1 }, dataDir);
  const server = createRemoteServer({ token: TOKEN, dataDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); rmSync(dataDir, { recursive: true, force: true }); }
}

const rpc = (base, p, body, headers = {}) => fetch(base + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify(body),
});
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

test('remote: the right token path serves MCP; tools answer from the synced data', async () => {
  await withRemote(async (base) => {
    const init = await rpc(base, `/mcp/${TOKEN}`, INIT);
    assert.equal(init.status, 200);
    assert.equal((await init.json()).result.serverInfo.name, 'tab-state');

    const list = await rpc(base, `/mcp/${TOKEN}`, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = (await list.json()).result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['get_session_recap', 'get_tab', 'list_tabs', 'search_tabs']);

    const call = await rpc(base, `/mcp/${TOKEN}`, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_tabs', arguments: { query: 'stripe' } } });
    assert.match((await call.json()).result.content[0].text, /Stripe auth/);
  });
});

test('remote: wrong/missing token, other paths and the sync endpoint are all 404', async () => {
  await withRemote(async (base) => {
    assert.equal((await rpc(base, `/mcp/${TOKEN}x`, INIT)).status, 404);
    assert.equal((await rpc(base, '/mcp/short', INIT)).status, 404);
    assert.equal((await rpc(base, '/mcp', INIT)).status, 404, 'no token at all');
    assert.equal((await rpc(base, '/mcp', INIT, { authorization: 'Bearer nope' })).status, 404);
    assert.equal((await rpc(base, '/sync', { tabs: [] })).status, 404, 'sync is never exposed on the tunnelled port');
    assert.equal((await fetch(`${base}/health`)).status, 404);
  });
});

test('remote: a Bearer token on /mcp works too; GET is refused (stateless, no SSE stream)', async () => {
  await withRemote(async (base) => {
    assert.equal((await rpc(base, '/mcp', INIT, { authorization: `Bearer ${TOKEN}` })).status, 200);
    assert.equal((await fetch(`${base}/mcp/${TOKEN}`)).status, 405);
  });
});

test('remote: refuses to start with a short token', () => {
  assert.throws(() => createRemoteServer({ token: 'short' }), /at least 32/);
});

test('remote: the generated token is long, reused, and owner-only on disk', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ts-token-'));
  try {
    const t = loadOrCreateToken(dir);
    assert.ok(t.length >= 40);
    assert.equal(loadOrCreateToken(dir), t, 'same token on the next start, so the ChatGPT URL keeps working');
    if (process.platform !== 'win32') assert.equal(statSync(path.join(dir, 'remote-token')).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a second copy (another MCP client) shares the sync port instead of crashing', async () => {
  const port = 9400 + Math.floor(Math.random() * 400);
  const start = () => {
    const child = spawn('node', [path.join(MCP_DIR, 'server.mjs')], {
      env: { ...process.env, TAB_STATE_MCP_PORT: String(port) }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.log = '';
    child.stderr.on('data', (d) => { child.log += d; });
    child.exitCode_ = null;
    child.on('exit', (c) => { child.exitCode_ = c; });
    return child;
  };
  const first = start();
  await new Promise((r) => setTimeout(r, 800));
  const second = start();
  try {
    await new Promise((r) => setTimeout(r, 2000));
    assert.match(first.log, /sync endpoint listening/);
    assert.equal(second.exitCode_, null, `second copy should keep running (log: ${second.log})`);
    assert.match(second.log, /sharing its data/);
  } finally {
    first.kill();
    second.kill();
  }
});
