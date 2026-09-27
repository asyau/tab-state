#!/usr/bin/env node
// Tab State MCP server: runs entirely on your machine. Two halves in one process:
//
//  1. A local HTTP endpoint (127.0.0.1 only) that the Tab State extension POSTs its tracked
//     tabs to, when you turn on "MCP sync" in the extension's Settings. Nothing reaches this
//     process unless you opt in on the extension side too.
//  2. An MCP server (stdio transport) exposing that data to Claude or any other MCP client as
//     tools: list_tabs, search_tabs, get_tab, get_session_recap.
//
// The synced data is written to ~/.tab-state-mcp/data.json (owner-only permissions) and never
// leaves your machine through this process — there is no outbound network call here at all.
//
//   node server.mjs                 (default sync port 8765)
//   TAB_STATE_MCP_PORT=9000 node server.mjs

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import {
  validatePayload, load, save, listTabs, searchTabs, getTab, getRecap, DEFAULT_DATA_DIR,
} from './store.mjs';

const PORT = Number(process.env.TAB_STATE_MCP_PORT) || 8765;
const HOST = '127.0.0.1'; // never 0.0.0.0: this must not be reachable from the network

// --- Sync endpoint: the extension POSTs its snapshot here -------------------------------------

export function createSyncServer({ onSync, dataDir } = {}) {
  return http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') { send(204, {}); return; } // extension pages are a different origin
    if (req.method === 'GET' && req.url === '/health') { send(200, { ok: true }); return; }
    if (req.method !== 'POST' || req.url !== '/sync') { send(404, { error: 'not found' }); return; }

    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) { tooBig = true; req.destroy(); } // ~2MB is generous for this payload
    });
    req.on('end', () => {
      if (tooBig) return;
      try {
        const data = validatePayload(JSON.parse(body));
        save(data, dataDir);
        onSync?.(data);
        send(200, { ok: true, tabs: data.tabs.length });
      } catch (err) {
        send(400, { error: err.message });
      }
    });
    req.on('error', () => {});
  });
}

// --- MCP tools ---------------------------------------------------------------------------------

const bucketEnum = z.enum(['glanced', 'partial', 'deep', 'ghost']);

function formatTab(t) {
  const lines = [`${t.title || t.url}`, `  ${t.url}`, `  [${t.bucket}] ${t.summary || ''}`.trimEnd()];
  if (t.note) lines.push(`  note: ${t.note}`);
  return lines.join('\n');
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

export function createMcpServer({ dataDir } = {}) {
  const mcp = new McpServer({ name: 'tab-state', version: '1.0.0' });

  mcp.registerTool('list_tabs', {
    title: 'List tracked tabs',
    description: 'List tabs Tab State has tracked, most recently active first. Optionally filter by engagement bucket (glanced/partial/deep/ghost) and whether the tab is currently open.',
    inputSchema: {
      bucket: bucketEnum.optional().describe('Only tabs in this engagement bucket'),
      closed: z.boolean().optional().describe('true for closed tabs only, false for open tabs only, omit for both'),
      limit: z.number().int().positive().max(200).optional().describe('Max results (default 50, max 200)'),
    },
  }, async ({ bucket, closed, limit }) => {
    const results = listTabs(load(dataDir), { bucket, closed, limit });
    if (!results.length) return textResult('No tabs match. Nothing has synced yet, or no tabs match the filter — check that "MCP sync" is on in the extension\'s Settings.');
    return textResult(results.map(formatTab).join('\n\n'));
  });

  mcp.registerTool('search_tabs', {
    title: 'Search tracked tabs',
    description: 'Full-text search over tracked tabs\' titles, descriptions, notes and URLs (e.g. "what was I reading about X").',
    inputSchema: {
      query: z.string().min(1).describe('Search text'),
      limit: z.number().int().positive().max(100).optional(),
    },
  }, async ({ query, limit }) => {
    const results = searchTabs(load(dataDir), { query, limit });
    if (!results.length) return textResult(`No tracked tabs match "${query}".`);
    return textResult(results.map(formatTab).join('\n\n'));
  });

  mcp.registerTool('get_tab', {
    title: 'Get one tab\'s full detail',
    description: 'Full detail for one tracked tab by its Tab State id or by URL (exact or substring match).',
    inputSchema: {
      id: z.string().optional(),
      url: z.string().optional(),
    },
  }, async ({ id, url }) => {
    if (!id && !url) return textResult('Provide either id or url.');
    const t = getTab(load(dataDir), { id, url });
    if (!t) return textResult('No matching tab found.');
    return textResult(JSON.stringify(t, null, 2));
  });

  mcp.registerTool('get_session_recap', {
    title: 'Get the session recap',
    description: 'The current one-line session recap Tab State generated, plus a count of tracked tabs per engagement bucket.',
    inputSchema: {},
  }, async () => textResult(JSON.stringify(getRecap(load(dataDir)), null, 2)));

  return mcp;
}

// --- Entry point ---------------------------------------------------------------------------

async function main() {
  const syncServer = createSyncServer();
  await new Promise((resolve, reject) => {
    syncServer.once('error', reject);
    syncServer.listen(PORT, HOST, resolve);
  }).catch((err) => {
    console.error(`tab-state-mcp: could not listen on ${HOST}:${PORT} (${err.code === 'EADDRINUSE' ? 'already in use — set TAB_STATE_MCP_PORT to another port' : err.message})`);
    process.exit(1);
  });
  console.error(`tab-state-mcp: sync endpoint listening on http://${HOST}:${PORT} (data: ${DEFAULT_DATA_DIR})`);

  const mcp = createMcpServer();
  await mcp.connect(new StdioServerTransport());
  console.error('tab-state-mcp: MCP server connected over stdio');

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { syncServer.close(); process.exit(0); });
  }
}

// Compared via pathToFileURL (not a manual `file://${...}` string) because a raw string doesn't
// percent-encode the path the way import.meta.url does — this repo's own path contains a space
// ("Application Support"), which silently broke a naive comparison: main() was never called,
// the process printed nothing and exited 0, and it looked exactly like a successful no-op.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('tab-state-mcp: fatal', err); process.exit(1); });
}
