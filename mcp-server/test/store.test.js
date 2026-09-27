import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validatePayload, load, save, listTabs, searchTabs, getTab, getRecap,
} from '../store.mjs';

const tab = (over = {}) => ({
  id: 'a1', url: 'https://docs.stripe.com/auth', title: 'Auth docs', description: 'How to authenticate.',
  note: '', bucket: 'deep', summary: 'Spent 2m reading.', activeMs: 120_000, scrollPct: 90,
  copies: 1, highlights: 0, lastActiveAt: 1000, createdAt: 900, closed: false, ...over,
});

test('validatePayload accepts a well-formed payload and stamps syncedAt', () => {
  const out = validatePayload({ tabs: [tab()], recap: 'You focused on Stripe docs.' });
  assert.equal(out.tabs.length, 1);
  assert.equal(out.recap, 'You focused on Stripe docs.');
  assert.ok(Number.isFinite(out.syncedAt));
});

test('validatePayload rejects malformed input with a clear message', () => {
  assert.throws(() => validatePayload(null), /payload must be/);
  assert.throws(() => validatePayload({}), /tabs must be an array/);
  assert.throws(() => validatePayload({ tabs: [{ id: 'a1' }] }), /needs at least/);
  assert.throws(() => validatePayload({ tabs: [{ id: 1, url: 'x' }] }), /needs at least/);
  assert.throws(() => validatePayload({ tabs: Array(5001).fill(tab()) }), /implausibly large/);
  assert.throws(() => validatePayload({ tabs: [], recap: 42 }), /recap must be a string/);
});

test('load returns an empty snapshot when nothing has been synced yet, without throwing', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tsmcp-'));
  try {
    assert.deepEqual(load(dir), { tabs: [], recap: '', syncedAt: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save then load round-trips, and the on-disk file is not world-readable', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tsmcp-'));
  try {
    const data = validatePayload({ tabs: [tab()], recap: 'Recap.' });
    save(data, dir);
    const loaded = load(dir);
    assert.equal(loaded.tabs.length, 1);
    assert.equal(loaded.recap, 'Recap.');
    const mode = statSync(path.join(dir, 'data.json')).mode & 0o777;
    assert.equal(mode, 0o600, `data.json should be owner-only, got ${mode.toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listTabs filters by bucket/closed, sorts by recency, and caps the limit', () => {
  const data = {
    tabs: [
      tab({ id: 'old', bucket: 'deep', lastActiveAt: 100 }),
      tab({ id: 'new', bucket: 'deep', lastActiveAt: 500 }),
      tab({ id: 'ghost', bucket: 'ghost', lastActiveAt: 300 }),
      tab({ id: 'closed-deep', bucket: 'deep', lastActiveAt: 400, closed: true }),
    ],
  };
  assert.deepEqual(listTabs(data, { bucket: 'deep' }).map((t) => t.id), ['new', 'closed-deep', 'old']);
  assert.deepEqual(listTabs(data, { bucket: 'deep', closed: false }).map((t) => t.id), ['new', 'old']);
  assert.equal(listTabs(data, { limit: 2 }).length, 2);
  assert.equal(listTabs(data, { limit: 10_000 }).length <= 200, true, 'limit is capped even if a huge one is requested');
});

test('searchTabs matches title, description, note and url, case-insensitively', () => {
  const data = {
    tabs: [
      tab({ id: 'a', title: 'Stripe Authentication', lastActiveAt: 2 }),
      tab({ id: 'b', title: 'Recipes', description: '', note: 'reread the STRIPE webhook section', lastActiveAt: 1 }),
      tab({ id: 'c', title: 'Unrelated', description: '', note: '', url: 'https://example.com/', lastActiveAt: 3 }),
    ],
  };
  const hits = searchTabs(data, { query: 'stripe' }).map((t) => t.id);
  assert.deepEqual(hits, ['a', 'b']);
  assert.deepEqual(searchTabs(data, { query: '' }), [], 'an empty query matches nothing rather than everything');
});

test('getTab looks up by exact id, or by exact/partial url', () => {
  const data = { tabs: [tab({ id: 'a1', url: 'https://docs.stripe.com/auth' })] };
  assert.equal(getTab(data, { id: 'a1' }).id, 'a1');
  assert.equal(getTab(data, { url: 'https://docs.stripe.com/auth' }).id, 'a1');
  assert.equal(getTab(data, { url: 'stripe.com' }).id, 'a1', 'partial url match');
  assert.equal(getTab(data, { id: 'nope' }), null);
  assert.equal(getTab(data, {}), null);
});

test('getRecap summarizes counts per bucket and reports when nothing has synced', () => {
  assert.match(getRecap({ tabs: [], recap: '', syncedAt: null }).recap, /No session recap/);
  const data = { tabs: [tab({ bucket: 'deep' }), tab({ id: 'b', bucket: 'deep' }), tab({ id: 'c', bucket: 'ghost' })], recap: 'Hi.', syncedAt: 5 };
  const out = getRecap(data);
  assert.equal(out.recap, 'Hi.');
  assert.deepEqual(out.byBucket, { deep: 2, ghost: 1 });
  assert.equal(out.tabCount, 3);
});
