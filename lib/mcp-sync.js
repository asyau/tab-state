// Builds and sends the snapshot for the optional local MCP server (mcp-server/). Off by default;
// only runs when settings.mcpSync.enabled is true. Posts to 127.0.0.1 only — this is a sync
// between two processes on the same machine, not a network call, and it only happens because the
// user turned it on in Settings.

import { classify } from './classifier.js';
import { templateSessionSummary } from './template.js';
import { truncate } from './format.js';

/** The record fields the MCP server's tools actually use — not the full internal record shape. */
export function toSyncTab(rec, now, thresholds) {
  return {
    id: rec.id,
    url: rec.url,
    title: truncate(rec.title, 200),
    description: truncate(rec.description, 300),
    note: truncate(rec.note, 500),
    bucket: classify(rec, now, thresholds),
    summary: rec.summary,
    activeMs: rec.activeMs || 0,
    scrollPct: rec.maxScrollPct || 0,
    lastActiveAt: rec.lastActiveAt,
    createdAt: rec.createdAt,
    closed: !!rec.closed,
  };
}

export function buildSyncPayload(records, now, thresholds) {
  return {
    tabs: records.map((r) => toSyncTab(r, now, thresholds)),
    recap: templateSessionSummary(records.filter((r) => !r.closed), now, thresholds),
  };
}

// --- Finding the local server ------------------------------------------------------------------
//
// The server (mcp-server/server.mjs, SYNC_PORTS — keep in sync) takes the first free port of this
// list rather than one fixed number, since popular defaults collide (AnkiConnect uses 8765, this
// server's old default). An extension can't read a file to learn the port, so it probes the list
// for a /health that says `service: "tab-state"`, and remembers what it found. 8765 goes last, for
// servers installed before the change.
export const MCP_PORTS = [47651, 47652, 47653, 47654, 47655];
export const LEGACY_PORT = 8765;
const PROBE_TIMEOUT_MS = 800;

let knownPort = null; // last port a Tab State server answered on (per service-worker lifetime)

/** For tests. */
export function resetMcpDiscovery() { knownPort = null; }

/** Does a Tab State server answer on this port? `pinned`: the user typed this port in Settings, so
 *  an older server's plain {ok:true} counts too; elsewhere only a server that names itself does,
 *  so tab data never goes to some other app that happens to have a /health. */
export async function probeMcpPort(port, { pinned = false } = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return false;
    const body = await res.json();
    if (body?.service === 'tab-state') return true;
    const legacy = body?.ok === true && Object.keys(body).length === 1;
    return legacy && (pinned || port === LEGACY_PORT);
  } catch {
    return false;
  }
}

/** The port of a running Tab State server, or null. `port` in settings pins it (no searching). */
export async function findMcpServer({ port } = {}) {
  if (port) return (await probeMcpPort(port, { pinned: true })) ? port : null;
  const order = [...new Set([knownPort, ...MCP_PORTS, LEGACY_PORT].filter(Boolean))];
  for (const p of order) {
    if (await probeMcpPort(p)) {
      knownPort = p;
      return p;
    }
  }
  knownPort = null;
  return null;
}

async function post(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(3000),
  });
  return { sent: res.ok, status: res.status, port };
}

/** Never throws: a missing/unreachable local server must never surface as a user-facing error. */
export async function syncToMcpServer(records, now, thresholds, { enabled, port } = {}) {
  if (!enabled) return { sent: false };
  const body = JSON.stringify(buildSyncPayload(records, now, thresholds));
  try {
    if (port) return await post(port, body); // pinned in Settings: exactly that port
    if (knownPort) {
      try {
        const out = await post(knownPort, body);
        if (out.sent) return out;
      } catch { /* moved or gone: search again below */ }
    }
    const found = await findMcpServer();
    if (!found) return { sent: false, error: 'No Tab State server found — is your AI assistant (with the Tab State plugin) running?' };
    return await post(found, body);
  } catch (err) {
    return { sent: false, error: String(err?.message || err) };
  }
}
