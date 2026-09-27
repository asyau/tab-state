// Persists the latest snapshot the extension has POSTed, and answers the queries the MCP tools
// need. Pure query functions (no I/O) so they're cheap to unit-test; load/save are the only
// functions that touch disk.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.tab-state-mcp');
export const DATA_FILE_NAME = 'data.json';

export function dataPath(dir = DEFAULT_DATA_DIR) {
  return path.join(dir, DATA_FILE_NAME);
}

const EMPTY = { tabs: [], recap: '', syncedAt: null };

/** Validate a sync payload from the extension; throws with a clear message if it's not one. */
export function validatePayload(body) {
  if (!body || typeof body !== 'object') throw new Error('payload must be a JSON object');
  if (!Array.isArray(body.tabs)) throw new Error('payload.tabs must be an array');
  if (body.tabs.length > 5000) throw new Error('payload.tabs is implausibly large (>5000)');
  for (const t of body.tabs) {
    if (typeof t?.id !== 'string' || typeof t?.url !== 'string') {
      throw new Error('each tab needs at least {id, url} as strings');
    }
  }
  if (body.recap != null && typeof body.recap !== 'string') throw new Error('payload.recap must be a string');
  return {
    tabs: body.tabs,
    recap: body.recap || '',
    syncedAt: Date.now(),
  };
}

export function load(dir = DEFAULT_DATA_DIR) {
  try {
    const raw = readFileSync(dataPath(dir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.tabs)) return { ...EMPTY };
    return parsed;
  } catch {
    return { ...EMPTY };
  }
}

export function save(data, dir = DEFAULT_DATA_DIR) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(dataPath(dir), JSON.stringify(data, null, 2), { mode: 0o600 });
}

// --- Queries (pure: take the loaded data, never touch disk themselves) ------------------------

function sortByRecency(tabs) {
  return [...tabs].sort((a, b) => (b.lastActiveAt || b.createdAt || 0) - (a.lastActiveAt || a.createdAt || 0));
}

export function listTabs(data, { bucket, closed, limit = 50 } = {}) {
  let tabs = data.tabs;
  if (bucket) tabs = tabs.filter((t) => t.bucket === bucket);
  if (closed != null) tabs = tabs.filter((t) => !!t.closed === closed);
  return sortByRecency(tabs).slice(0, Math.max(1, Math.min(limit, 200)));
}

export function searchTabs(data, { query, limit = 20 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const hit = (t) => [t.title, t.description, t.note, t.url].some((f) => String(f || '').toLowerCase().includes(q));
  return sortByRecency(data.tabs.filter(hit)).slice(0, Math.max(1, Math.min(limit, 100)));
}

export function getTab(data, { id, url } = {}) {
  if (id) return data.tabs.find((t) => t.id === id) || null;
  if (url) return data.tabs.find((t) => t.url === url || t.url.includes(url)) || null;
  return null;
}

export function getRecap(data) {
  return {
    recap: data.recap || 'No session recap synced yet.',
    syncedAt: data.syncedAt,
    tabCount: data.tabs.length,
    byBucket: data.tabs.reduce((acc, t) => { acc[t.bucket] = (acc[t.bucket] || 0) + 1; return acc; }, {}),
  };
}
