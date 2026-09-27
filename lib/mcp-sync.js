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

/** Never throws: a missing/unreachable local server must never surface as a user-facing error. */
export async function syncToMcpServer(records, now, thresholds, { enabled, port } = {}) {
  if (!enabled) return { sent: false };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildSyncPayload(records, now, thresholds)),
      signal: AbortSignal.timeout(3000),
    });
    return { sent: res.ok, status: res.status };
  } catch (err) {
    return { sent: false, error: String(err?.message || err) };
  }
}
