// Remote mode (for ChatGPT, which only reaches MCP servers over HTTPS): the same tools over
// Streamable HTTP, behind a secret token, on a listener that serves nothing else. And the
// multi-client case: a second copy of the server must share the sync port, not crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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

test('the port taken by some other app: the server still starts and answers (it just can\'t receive syncs)', async () => {
  const port = 9600 + Math.floor(Math.random() * 300);
  const squatter = http.createServer((q, r) => { r.writeHead(200); r.end('not tab state'); });
  await new Promise((r) => squatter.listen(port, '127.0.0.1', r));
  const child = spawn('node', [path.join(MCP_DIR, '..', 'plugins/tab-state/server/tab-state-mcp.mjs')], {
    env: { ...process.env, TAB_STATE_MCP_PORT: String(port) }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let log = '';
  let out = '';
  let exitCode = null;
  child.stderr.on('data', (d) => { log += d; });
  child.stdout.on('data', (d) => { out += d; });
  child.on('exit', (c) => { exitCode = c; });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n`);
    const deadline = Date.now() + 5000;
    while (!out.includes('"id":1') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(exitCode, null, `must not exit (log: ${log})`);
    assert.match(log, /can't receive syncs/);
    assert.match(out, /"serverInfo":\{"name":"tab-state"/, 'still answers MCP');
  } finally {
    child.kill();
    squatter.close();
  }
});

test('automatic port: skips a port another app holds, writes the port file, says who it is on /health', async () => {
  const { SYNC_PORTS } = await import('../server.mjs');
  const home = mkdtempSync(path.join(tmpdir(), 'ts-autoport-'));
  const squatter = http.createServer((q, r) => { r.writeHead(200); r.end('AnkiConnect'); });
  let squatted = null;
  for (const p of SYNC_PORTS.slice(0, -1)) { // leave at least one candidate free
    try { await new Promise((ok, bad) => { squatter.once('error', bad); squatter.listen(p, '127.0.0.1', ok); }); squatted = p; break; } catch { /* in use: try next */ }
  }
  assert.ok(squatted, 'could occupy a candidate port for the test');
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.TAB_STATE_MCP_PORT;
  const child = spawn('node', [path.join(MCP_DIR, '..', 'plugins/tab-state/server/tab-state-mcp.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  try {
    const deadline = Date.now() + 5000;
    while (!/listening on|sharing its data/.test(log) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(log)?.[1] ?? /port (\d+)/.exec(log)?.[1]);
    assert.ok(SYNC_PORTS.includes(port) && port !== squatted, `picked ${port} (log: ${log})`);
    if (/listening on/.test(log)) {
      assert.equal(readFileSync(path.join(home, '.tab-state-mcp', 'port'), 'utf8').trim(), String(port), 'port file for people/tools');
    }
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.service, 'tab-state', 'identifies itself so the extension can find it');
  } finally {
    child.kill();
    squatter.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the server\'s port list matches the one the extension probes (lib/mcp-sync.js)', async () => {
  const { SYNC_PORTS } = await import('../server.mjs');
  const { MCP_PORTS } = await import('../../lib/mcp-sync.js');
  assert.deepEqual(SYNC_PORTS, MCP_PORTS, 'change both together, or the extension won\'t find the server');
});
