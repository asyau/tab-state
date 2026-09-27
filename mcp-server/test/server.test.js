// Integration tests: a real MCP Client (the same SDK a real MCP host uses) talks to our real
// McpServer in-process, and a real HTTP POST hits the real sync server — not mocks of either.
// Every test passes an explicit temp dataDir; none of this ever touches a real ~/.tab-state-mcp.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSyncServer, createMcpServer } from '../server.mjs';

let dataDir;
beforeEach(() => { dataDir = mkdtempSync(path.join(os.tmpdir(), 'tsmcp-data-')); });
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

async function withMcpClient(fn) {
  const server = createMcpServer({ dataDir });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

function textOf(result) {
  return result.content.map((c) => c.text).join('\n');
}

test('the sync HTTP server accepts a real POST and rejects a malformed one', async () => {
  const server = createSyncServer({ dataDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/sync`, {
      method: 'POST',
      body: JSON.stringify({ tabs: [{ id: 'a1', url: 'https://x.com', title: 'X', bucket: 'deep' }], recap: 'Recap.' }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, tabs: 1 });

    const bad = await fetch(`http://127.0.0.1:${port}/sync`, { method: 'POST', body: JSON.stringify({ tabs: 'nope' }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /must be an array/);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
  } finally {
    server.close();
  }
});

test('a real MCP client can call list_tabs, search_tabs, get_tab and get_session_recap', async () => {
  // Seed data the way the extension would: POST it to the real sync server.
  const sync = createSyncServer({ dataDir });
  await new Promise((r) => sync.listen(0, '127.0.0.1', r));
  const { port } = sync.address();
  const posted = await fetch(`http://127.0.0.1:${port}/sync`, {
    method: 'POST',
    body: JSON.stringify({
      recap: 'You focused on Stripe auth docs and skimmed a Rust post.',
      tabs: [
        { id: 'deep1', url: 'https://docs.stripe.com/auth', title: 'Stripe Auth', description: 'API keys.', note: '', bucket: 'deep', summary: 'Spent 3m reading.', lastActiveAt: 200, createdAt: 100, closed: false },
        { id: 'ghost1', url: 'https://example.com', title: 'Example', description: '', note: 'check later', bucket: 'ghost', summary: 'Never viewed.', lastActiveAt: 50, createdAt: 50, closed: false },
      ],
    }),
  });
  assert.equal(posted.status, 200);
  sync.close();

  await withMcpClient(async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['get_session_recap', 'get_tab', 'list_tabs', 'search_tabs']);

    const all = await client.callTool({ name: 'list_tabs', arguments: {} });
    assert.match(textOf(all), /Stripe Auth/);
    assert.match(textOf(all), /Example/);

    const deepOnly = await client.callTool({ name: 'list_tabs', arguments: { bucket: 'deep' } });
    assert.match(textOf(deepOnly), /Stripe Auth/);
    assert.doesNotMatch(textOf(deepOnly), /Example/);

    const found = await client.callTool({ name: 'search_tabs', arguments: { query: 'stripe' } });
    assert.match(textOf(found), /Stripe Auth/);

    const notFound = await client.callTool({ name: 'search_tabs', arguments: { query: 'nonexistent-xyz' } });
    assert.match(textOf(notFound), /No tracked tabs match/);

    const detail = await client.callTool({ name: 'get_tab', arguments: { id: 'ghost1' } });
    const parsed = JSON.parse(textOf(detail));
    assert.equal(parsed.note, 'check later');

    const recap = await client.callTool({ name: 'get_session_recap', arguments: {} });
    const recapParsed = JSON.parse(textOf(recap));
    assert.match(recapParsed.recap, /Stripe auth docs/);
    assert.deepEqual(recapParsed.byBucket, { deep: 1, ghost: 1 });
  });
});

test('list_tabs is honest when nothing has synced yet', async () => {
  await withMcpClient(async (client) => {
    const out = await client.callTool({ name: 'list_tabs', arguments: {} });
    assert.match(textOf(out), /MCP sync.*Settings/);
  });
});

test('rejects an oversized request body instead of buffering it unbounded', async () => {
  const server = createSyncServer({ dataDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const huge = JSON.stringify({ tabs: [{ id: 'a', url: 'https://x.com', title: 'x'.repeat(3_000_000) }] });
    await assert.rejects(fetch(`http://127.0.0.1:${port}/sync`, { method: 'POST', body: huge }));
  } finally {
    server.close();
  }
});
