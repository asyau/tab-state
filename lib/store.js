// Record storage: one chrome.storage.local key per record ("rec:<id>"), with an in-memory
// cache for the lifetime of the service worker. Only changed records are written back.

export const RECORD_PREFIX = 'rec:';

let cache = null;
const dirty = new Set();
const removed = new Set();
let chain = Promise.resolve();

/**
 * Run tasks one at a time. Chrome fires tab/window events concurrently and every task does
 * read-modify-write on records, so without this two events could overwrite each other.
 */
export function serialize(task) {
  const result = chain.then(task);
  chain = result.catch(() => {});
  return result;
}

export async function load() {
  if (cache) return cache;
  const all = await chrome.storage.local.get(null);
  cache = new Map();
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(RECORD_PREFIX) && value && value.id) cache.set(value.id, value);
  }
  return cache;
}

export function records() {
  return cache ? [...cache.values()] : [];
}

export function getRecord(id) {
  return cache?.get(id) ?? null;
}

export function putRecord(rec) {
  cache.set(rec.id, rec);
  removed.delete(rec.id);
  dirty.add(rec.id);
}

export function deleteRecord(id) {
  cache.delete(id);
  dirty.delete(id);
  removed.add(id);
}

export async function flush() {
  if (dirty.size) {
    const out = {};
    for (const id of dirty) {
      const rec = cache.get(id);
      if (rec) out[RECORD_PREFIX + id] = rec;
    }
    dirty.clear();
    await chrome.storage.local.set(out);
  }
  if (removed.size) {
    const keys = [...removed].map((id) => RECORD_PREFIX + id);
    removed.clear();
    await chrome.storage.local.remove(keys);
  }
}

/** Drop the in-memory cache, as if the service worker had been restarted. */
export function resetCache() {
  cache = null;
  dirty.clear();
  removed.clear();
  chain = Promise.resolve();
}

export function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
