// The Claude Code / Codex / ChatGPT plugin in ../plugins/tab-state ships a bundled copy of this
// server. These checks keep it honest: manifests point at files that exist, the bundle was built
// from the current sources, and it actually starts and answers MCP with no node_modules around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT, sourceHash } from '../scripts/build-plugin.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN = path.join(REPO, 'plugins/tab-state');
const json = (p) => JSON.parse(readFileSync(path.join(REPO, p), 'utf8'));

test('plugin manifests agree on name/version and match the server package', () => {
  const pkg = json('mcp-server/package.json');
  const claude = json('plugins/tab-state/.claude-plugin/plugin.json');
  const agents = json('plugins/tab-state/plugin.json');
  for (const m of [claude, agents]) {
    assert.equal(m.name, 'tab-state');
    assert.equal(m.version, pkg.version, 'bump plugin versions with mcp-server/package.json');
  }
});

test('both marketplaces point at the plugin folder', () => {
  const claudeMkt = json('.claude-plugin/marketplace.json');
  assert.equal(claudeMkt.plugins[0].source, './plugins/tab-state');
  const agentsMkt = json('.agents/plugins/marketplace.json');
  assert.equal(agentsMkt.plugins[0].source.path, './plugins/tab-state');
  assert.ok(existsSync(PLUGIN));
});

test('MCP configs launch the bundled server', () => {
  const claudeMcp = json('plugins/tab-state/.mcp.json').mcpServers['tab-state'];
  assert.deepEqual(claudeMcp.args, ['${CLAUDE_PLUGIN_ROOT}/server/tab-state-mcp.mjs']);
  const agentsMcp = json('plugins/tab-state/mcp.json').mcpServers['tab-state'];
  assert.equal(agentsMcp.type, 'stdio');
  assert.equal(agentsMcp.cwd, '${PLUGIN_ROOT}/server');
  assert.ok(existsSync(path.join(PLUGIN, 'server', agentsMcp.args[0])));
  assert.ok(existsSync(path.join(PLUGIN, 'skills/tab-history/SKILL.md')));
});

test('the bundled server is up to date with mcp-server sources (else: npm run build:plugin)', () => {
  const header = readFileSync(OUT, 'utf8').slice(0, 400);
  assert.match(header, new RegExp(`source hash ${sourceHash()}`), 'plugins/tab-state/server/tab-state-mcp.mjs is stale — run `npm run build:plugin` in mcp-server/');
});

test('the bundle runs standalone (no node_modules) and answers MCP over stdio', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ts-plugin-'));
  const copy = path.join(dir, 'tab-state-mcp.mjs');
  copyFileSync(OUT, copy);
  const port = 9800 + Math.floor(Math.random() * 150);
  const child = spawn('node', [copy], { cwd: dir, env: { ...process.env, TAB_STATE_MCP_PORT: String(port) } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    const deadline = Date.now() + 5000;
    while (!out.includes('"id":2') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const msgs = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(msgs.find((m) => m.id === 1).result.serverInfo.name, 'tab-state');
    assert.equal(msgs.find((m) => m.id === 2).result.tools.length, 4);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
