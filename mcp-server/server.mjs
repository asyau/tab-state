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
//   node server.mjs --remote        (for ChatGPT: see "Remote mode" below and the README)
//
// Several MCP clients (Claude Desktop, Claude Code, Codex...) may each start their own copy. Only
// one can own the sync port; the others notice a Tab State server already has it and just serve
// tools, reading the same data file the first one writes. So any number of clients can coexist.

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod';
import {
  validatePayload, load, save, listTabs, searchTabs, getTab, getRecap, DEFAULT_DATA_DIR,
} from './store.mjs';

const PORT = Number(process.env.TAB_STATE_MCP_PORT) || 8765;
const REMOTE_PORT = Number(process.env.TAB_STATE_MCP_REMOTE_PORT) || 8766;
const HOST = '127.0.0.1'; // never 0.0.0.0: this must not be reachable from the network

// --- Sync endpoint: the extension POSTs its snapshot here -------------------------------------
//
// Binding to 127.0.0.1 keeps other machines out, but not web pages: any site open in your browser
// can send requests to 127.0.0.1. A page that could POST /sync could overwrite what your assistant
// reads with text of its choosing — a prompt-injection path. So, before reading a byte of body:
//  - An Origin header, if present, must be a browser extension's. Browsers always attach the
//    page's own Origin to cross-origin POSTs and pages can't forge it; local tools (curl, tests)
//    send none — they already have your files anyway.
//  - The Host header must be 127.0.0.1/localhost: blocks DNS-rebinding, where a site re-points its
//    own hostname at 127.0.0.1 to look same-origin.
//  - Writes must be Content-Type: application/json, which a page can't send cross-origin without a
//    CORS preflight — and the preflight is refused for anything but an extension origin.

const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\/[a-z0-9.-]+$/i;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isAllowedLocalRequest(req) {
  const origin = req.headers.origin;
  if (origin != null && !EXTENSION_ORIGIN.test(origin)) return false;
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return LOCAL_HOSTS.has(host);
}

export function createSyncServer({ onSync, dataDir } = {}) {
  return http.createServer((req, res) => {
    const origin = req.headers.origin;
    const send = (status, body) => {
      const headers = { 'content-type': 'application/json' };
      if (origin && EXTENSION_ORIGIN.test(origin)) {
        headers['access-control-allow-origin'] = origin; // never '*'
        headers.vary = 'Origin';
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    if (!isAllowedLocalRequest(req)) { send(403, { error: 'forbidden' }); return; }
    if (req.method === 'OPTIONS') { // preflight from the extension (a different origin)
      res.writeHead(204, {
        'access-control-allow-origin': origin || '',
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type',
        vary: 'Origin',
      });
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/health') { send(200, { ok: true }); return; }
    if (req.method !== 'POST' || req.url !== '/sync') { send(404, { error: 'not found' }); return; }
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      send(415, { error: 'content-type must be application/json' });
      return;
    }

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

// --- Remote mode (ChatGPT) ---------------------------------------------------------------------
//
// ChatGPT only talks to MCP servers over HTTPS on the public internet — it can't launch a local
// process the way Claude or Codex do. Remote mode serves the same tools over MCP's Streamable
// HTTP transport so a tunnel (cloudflared, ngrok, OpenAI's Secure MCP Tunnel) can expose them.
//
// This is your browsing history, so it's locked down:
//  - A separate listener (default 127.0.0.1:8766) that serves ONLY the MCP endpoint — the sync
//    port is never what you tunnel, so nobody on the internet can overwrite your data.
//  - The endpoint path embeds a random 256-bit token: /mcp/<token>. Every other path is a 404,
//    and the token is compared in constant time. `Authorization: Bearer <token>` on /mcp works
//    too, for clients that support a token field.
//  - Read-only tools; still bound to 127.0.0.1 — only the tunnel you run can reach it.

export function loadOrCreateToken(dir = DEFAULT_DATA_DIR) {
  const file = path.join(dir, 'remote-token');
  try {
    const t = readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch { /* create below */ }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const t = randomBytes(32).toString('base64url');
  writeFileSync(file, `${t}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return t;
}

function tokenMatches(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createRemoteServer({ token, dataDir } = {}) {
  if (!token || token.length < 32) throw new Error('remote mode needs a token of at least 32 characters');
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
    const pathToken = url.pathname.startsWith('/mcp/') ? url.pathname.slice(5) : null;
    const authorized = (pathToken != null && tokenMatches(pathToken, token))
      || (url.pathname === '/mcp' && bearer != null && tokenMatches(bearer, token));
    if (!authorized) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    if (req.method !== 'POST') { // stateless server: no SSE stream to resume, no session to delete
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
      return;
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_000_000) { res.writeHead(413).end(); return; }
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }
    // Stateless: a fresh server + transport per request, so there's no session state to leak
    // or pile up between requests.
    const mcp = createMcpServer({ dataDir });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end();
      console.error('tab-state-mcp: remote request failed', err);
    }
  });
}

/** Resolves true if a Tab State server already answers on this port (another client's copy). */
async function isTabStateServer(port) {
  try {
    const res = await fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok && (await res.json())?.ok === true;
  } catch {
    return false;
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolve);
  });
}

// --- Entry point ---------------------------------------------------------------------------

async function main() {
  const remote = process.argv.includes('--remote') || process.env.TAB_STATE_MCP_REMOTE === '1';

  const syncServer = createSyncServer();
  let ownsSync = true;
  try {
    await listen(syncServer, PORT);
    console.error(`tab-state-mcp: sync endpoint listening on http://${HOST}:${PORT} (data: ${DEFAULT_DATA_DIR})`);
  } catch (err) {
    if (err.code === 'EADDRINUSE' && await isTabStateServer(PORT)) {
      ownsSync = false; // another client's copy receives syncs; we read the same data file
      console.error(`tab-state-mcp: another Tab State server already owns port ${PORT} — sharing its data (${DEFAULT_DATA_DIR})`);
      // If that copy's client quits, take the port over so syncs keep landing somewhere.
      const retry = setInterval(async () => {
        try {
          await listen(syncServer, PORT);
          ownsSync = true;
          clearInterval(retry);
          console.error(`tab-state-mcp: took over the sync endpoint on port ${PORT}`);
        } catch { /* still owned by another copy */ }
      }, 30_000);
      retry.unref();
    } else {
      console.error(`tab-state-mcp: could not listen on ${HOST}:${PORT} (${err.code === 'EADDRINUSE' ? 'already in use by something else — set TAB_STATE_MCP_PORT to another port' : err.message})`);
      process.exit(1);
    }
  }

  let remoteServer = null;
  if (remote) {
    const token = process.env.TAB_STATE_MCP_TOKEN || loadOrCreateToken();
    remoteServer = createRemoteServer({ token });
    try {
      await listen(remoteServer, REMOTE_PORT);
    } catch (err) {
      console.error(`tab-state-mcp: could not start remote mode on ${HOST}:${REMOTE_PORT} (${err.message}) — set TAB_STATE_MCP_REMOTE_PORT`);
      process.exit(1);
    }
    console.error([
      '',
      'tab-state-mcp: remote mode (for ChatGPT) is on.',
      `  Local endpoint:  http://${HOST}:${REMOTE_PORT}/mcp/${token}`,
      `  1. Expose ONLY this port over HTTPS, e.g.:  cloudflared tunnel --url http://${HOST}:${REMOTE_PORT}`,
      `  2. In ChatGPT (developer mode) add an app with URL  https://<your-tunnel-host>/mcp/${token}`,
      '     and authentication "No Authentication" — the token in the path is the secret; don\'t share it.',
      '  Stop this process (Ctrl+C) to take it offline. Delete ~/.tab-state-mcp/remote-token to rotate the token.',
      '',
    ].join('\n'));
  } else {
    const mcp = createMcpServer();
    await mcp.connect(new StdioServerTransport());
    console.error('tab-state-mcp: MCP server connected over stdio');
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (ownsSync) syncServer.close();
      remoteServer?.close();
      process.exit(0);
    });
  }
}

// Compared via realpathSync on both sides (not a URL string comparison) because a symlinked
// ancestor directory breaks that too: import.meta.url resolves through the symlink (Node
// canonicalizes it), but process.argv[1] keeps whatever path the caller actually typed — on
// macOS, /tmp is itself a symlink to /private/tmp, so a plain `node /tmp/x/server.mjs` produces
// import.meta.url = file:///private/tmp/x/server.mjs but argv[1] = /tmp/x/server.mjs, which
// never matched. That's a real path this file gets invoked from once packaged as an .mcpb.
// realpathSync resolves both sides to the same canonical filesystem path first, sidestepping
// symlinks *and* the separate percent-encoding mismatch an earlier version of this check had.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => { console.error('tab-state-mcp: fatal', err); process.exit(1); });
}
