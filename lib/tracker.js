// The telemetry engine. Every public function runs through `run()`, which serializes work,
// makes sure the browser-session bookkeeping is done, and flushes changed records.
//
// Time is never counted by a running timer (MV3 service workers are killed at will).
// A focused tab stores `activeSince`; when focus leaves, the elapsed time is added to
// `activeMs`. `lastSeen` is a heartbeat (content-script ping or alarm tick) that caps a
// segment if the ending event never arrived (sleep, crash, force-quit).

import { classify } from './classifier.js';
import { THRESHOLDS, TIMING } from './config.js';
import {
  serialize, load, records, getRecord, putRecord, deleteRecord, flush, newId,
} from './store.js';
import { loadSettings } from './settings.js';
import { templateSummary } from './template.js';
import { normalizeUrl, isTrackable, domainOf } from './url.js';

const SESSION_KEY = 'sessionStartedAt';
const REVIVE_WINDOW_MS = 15 * 60 * 1000;
let sessionChecked = false;

// The active user's sort thresholds, refreshed at the top of every run() so a change made in
// Settings takes effect on the very next event. Safe as a module-level variable (not passed
// as a param through every nested call) because serialize() guarantees only one run() task
// executes at a time.
let currentThresholds = THRESHOLDS;

// Tab ids we've asked Chrome to remove (e.g. via purge), mapped to when that guard expires.
// Removing a tab is async: an onUpdated/onCreated event for it can still be in flight and would
// otherwise look like a brand-new tab once its record is finalized (tabId cleared). While a tabId
// is in here, tab events for it are ignored instead of minting a duplicate record. Entries are
// cleared as soon as Chrome confirms the removal (onTabRemoved) or expire on their own so a
// reused tab id can never stay blocked.
const pendingRemoval = new Map();
const PENDING_REMOVAL_TTL_MS = 15_000;

function markPendingRemoval(tabId, now) {
  pendingRemoval.set(tabId, now + PENDING_REMOVAL_TTL_MS);
}

function isPendingRemoval(tabId, now) {
  const expiry = pendingRemoval.get(tabId);
  if (expiry == null) return false;
  if (expiry < now) {
    pendingRemoval.delete(tabId);
    return false;
  }
  return true;
}

export function run(task) {
  return serialize(async () => {
    await load();
    await ensureSession(Date.now());
    currentThresholds = (await loadSettings()).thresholds;
    const out = await task();
    await flush();
    return out;
  });
}

/** For tests: forget per-worker state, like a service worker restart. */
export function resetWorkerState() {
  sessionChecked = false;
  pendingRemoval.clear();
  currentThresholds = THRESHOLDS;
}

// ---------------------------------------------------------------------------
// Browser session handling

async function ensureSession(now) {
  if (sessionChecked) return;
  sessionChecked = true;
  const got = await chrome.storage.session.get(SESSION_KEY);
  if (got[SESSION_KEY]) return;
  await startNewSession(now);
  await chrome.storage.session.set({ [SESSION_KEY]: now });
}

/**
 * storage.session is empty: the browser (or the extension) just started. Tab ids from the
 * previous session mean nothing any more, so detach every record and re-link by URL.
 */
async function startNewSession(now) {
  for (const rec of records()) {
    if (rec.activeSince != null) stopSegment(rec, now);
    if (!rec.closed) {
      rec.tabId = null;
      putRecord(rec);
    }
  }
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) ensureRecordForTab(tab, now);
  for (const rec of records()) {
    if (!rec.closed && rec.tabId == null) finalize(rec, now, 'session-ended');
  }
  prune(now);
}

// ---------------------------------------------------------------------------
// Record helpers

function openRecordForTab(tabId) {
  return records().find((r) => !r.closed && r.tabId === tabId) ?? null;
}

function tabUrl(tab) {
  if (tab.pendingUrl && (!tab.url || tab.url === 'about:blank')) return tab.pendingUrl;
  return tab.url || tab.pendingUrl || '';
}

function createRecord(tab, key, url, now) {
  return {
    id: newId(),
    key,
    url,
    title: tab.title || url,
    description: '',
    tabId: null,
    windowId: tab.windowId ?? null,
    createdAt: now,
    lastActiveAt: null,
    activeMs: 0,
    activeSince: null,
    lastSeen: null,
    views: 0,
    maxScrollPct: 0,
    highlights: 0,
    copies: 0,
    linkClicks: 0,
    anchor: null,
    selectionSnippet: '',
    note: '',
    bucket: 'ghost',
    summary: '',
    ai: null,
    closed: false,
    closedAt: null,
    closedReason: null,
  };
}

/** Find or create the record for the page a tab is showing. Returns null for untrackable pages. */
export function ensureRecordForTab(tab, now) {
  // We already asked Chrome to remove this tab; ignore any straggling event for it so it
  // doesn't get mistaken for a new tab while the removal is still in flight.
  if (isPendingRemoval(tab.id, now)) return null;
  const url = tabUrl(tab);
  const key = normalizeUrl(url);
  let rec = openRecordForTab(tab.id);

  if (rec) {
    // Still loading or on a blank page: keep the current link.
    if (!url || url === 'about:blank') return rec;
    if (rec.key === key) {
      refreshMeta(rec, tab, url);
      return rec;
    }
    finalize(rec, now, 'navigated');
  }
  if (!key) return null;

  rec =
    // An open record left without a tab by a browser restart.
    records().find((r) => !r.closed && r.tabId == null && r.key === key) ??
    // A record closed at session start whose tab showed up late (restored tabs load lazily).
    records().find((r) => r.closed && r.closedReason === 'session-ended' && r.key === key &&
      now - r.closedAt < REVIVE_WINDOW_MS) ??
    createRecord(tab, key, url, now);

  rec.tabId = tab.id;
  rec.windowId = tab.windowId ?? rec.windowId;
  rec.closed = false;
  rec.closedAt = null;
  rec.closedReason = null;
  refreshMeta(rec, tab, url);
  return rec;
}

function refreshMeta(rec, tab, url) {
  if (url && isTrackable(url)) rec.url = url;
  if (tab.title && tab.title !== url) rec.title = tab.title;
  if (tab.windowId != null) rec.windowId = tab.windowId;
  updateDerived(rec, Date.now());
}

function updateDerived(rec, now) {
  rec.bucket = classify(rec, now, currentThresholds);
  rec.summary = templateSummary(rec, now, currentThresholds);
  putRecord(rec);
}

function startSegment(rec, now) {
  rec.activeSince = now;
  rec.lastSeen = now;
  rec.lastActiveAt = now;
  rec.views = (rec.views || 0) + 1;
  updateDerived(rec, now);
}

function stopSegment(rec, now) {
  if (rec.activeSince == null) return;
  const lastSeen = Math.max(rec.lastSeen || 0, rec.activeSince);
  const end = Math.min(now, lastSeen + TIMING.heartbeatGraceMs);
  rec.activeMs = (rec.activeMs || 0) + Math.max(0, end - rec.activeSince);
  rec.activeSince = null;
  rec.lastActiveAt = Math.max(rec.lastActiveAt || 0, end);
  updateDerived(rec, now);
}

function finalize(rec, now, reason) {
  stopSegment(rec, now);
  rec.closed = true;
  rec.closedAt = now;
  rec.closedReason = reason;
  rec.tabId = null;
  updateDerived(rec, now);
}

/** Forget closed tabs that aren't worth keeping: low-value ones after an hour, everything after a week. */
export function prune(now) {
  for (const rec of records()) {
    if (!rec.closed) continue;
    const age = now - (rec.closedAt || 0);
    const lowValue = rec.bucket === 'ghost' || rec.bucket === 'glanced';
    if (age > TIMING.closedRetentionMs || (lowValue && age > 60 * 60 * 1000 && rec.closedReason !== 'purged')) {
      deleteRecord(rec.id);
    }
    // Purged tabs are only kept for undo.
    if (rec.closedReason === 'purged' && age > 60 * 60 * 1000) deleteRecord(rec.id);
  }
}

// ---------------------------------------------------------------------------
// Focus

async function getFocusedTab() {
  try {
    // Only a locked screen counts as "away". Plain 'idle' (no mouse/keyboard for a while) is not:
    // someone reading a long article often doesn't touch the mouse for 90s+, and that is exactly
    // the deep-focus case this tool exists to catch, so it must not pause tracking.
    const state = await chrome.idle.queryState(TIMING.idleSeconds);
    if (state === 'locked') return null;
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (!win || !win.focused) return null;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    return tab ?? null;
  } catch {
    return null;
  }
}

/**
 * Bring records in line with reality: exactly the focused tab (if any) has a running segment.
 * Called on every relevant event and on each heartbeat, so a missed event self-heals.
 */
async function reconcile(now) {
  const focused = await getFocusedTab();
  for (const rec of records()) {
    if (rec.closed || rec.activeSince == null) continue;
    if (!focused || rec.tabId !== focused.id) {
      stopSegment(rec, now);
    } else if (now - Math.max(rec.lastSeen || 0, rec.activeSince) > TIMING.sleepGapMs) {
      // No heartbeat for a while (machine slept): count up to the last heartbeat, restart now.
      stopSegment(rec, now);
      startSegment(rec, now);
    }
  }
  if (!focused) return;
  const rec = ensureRecordForTab(focused, now);
  if (!rec) return;
  if (rec.activeSince == null) startSegment(rec, now);
  else {
    rec.lastSeen = now;
    putRecord(rec);
  }
}

// ---------------------------------------------------------------------------
// Event entry points (wired up in background.js)

export const onFocusMaybeChanged = () => run(() => reconcile(Date.now()));

export const onTabCreated = (tab) => run(() => {
  ensureRecordForTab(tab, Date.now());
});

export const onTabUpdated = (tabId, changeInfo, tab) => run(async () => {
  const now = Date.now();
  if (changeInfo.url || changeInfo.status === 'complete' || changeInfo.title || changeInfo.favIconUrl) {
    ensureRecordForTab(tab, now);
  }
  if (changeInfo.url || changeInfo.status === 'complete') await reconcile(now);
});

export const onTabRemoved = (tabId) => run(async () => {
  const now = Date.now();
  const rec = openRecordForTab(tabId);
  if (rec) finalize(rec, now, 'closed');
  pendingRemoval.delete(tabId);
  await reconcile(now);
});

export const onTabReplaced = (addedTabId, removedTabId) => run(() => {
  const rec = openRecordForTab(removedTabId);
  if (rec) {
    rec.tabId = addedTabId;
    putRecord(rec);
  }
});

export const onTick = () => run(async () => {
  const now = Date.now();
  await reconcile(now);
  prune(now);
});

/** Messages from content.js. `tab` is sender.tab. */
export const onContentMessage = (msg, tab) => run(async () => {
  const now = Date.now();
  if (!tab || tab.id == null) return;
  // Ignore messages that describe a page this tab has already left.
  if (normalizeUrl(msg.url) !== normalizeUrl(tabUrl(tab))) return;
  const rec = ensureRecordForTab(tab, now);
  if (!rec) return;

  switch (msg.type) {
    case 'ts:ping':
      await reconcile(now);
      return;
    case 'ts:meta':
      if (msg.description) rec.description = String(msg.description).slice(0, 300);
      if (msg.title) rec.title = String(msg.title).slice(0, 300);
      break;
    case 'ts:scroll':
      rec.maxScrollPct = Math.max(rec.maxScrollPct || 0, clampPct(msg.pct));
      if (msg.anchor) rec.anchor = sanitizeAnchor(msg.anchor);
      break;
    case 'ts:interaction':
      if (msg.kind === 'copy') rec.copies = (rec.copies || 0) + 1;
      else if (msg.kind === 'highlight') rec.highlights = (rec.highlights || 0) + 1;
      else if (msg.kind === 'link') rec.linkClicks = (rec.linkClicks || 0) + 1;
      if (msg.snippet) rec.selectionSnippet = String(msg.snippet).slice(0, 200);
      if (msg.anchor) rec.anchor = sanitizeAnchor(msg.anchor);
      break;
    default:
      return;
  }
  updateDerived(rec, now);
});

function clampPct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}

function sanitizeAnchor(a) {
  const kinds = ['code', 'table', 'heading', 'text'];
  if (!a || !kinds.includes(a.kind)) return null;
  return {
    kind: a.kind,
    heading: String(a.heading || '').slice(0, 120),
    snippet: String(a.snippet || '').slice(0, 120),
  };
}

// ---------------------------------------------------------------------------
// Dashboard actions

/** Close tabs and keep their records (marked 'purged') so the dashboard can undo. */
export const purge = (recordIds) => run(async () => {
  const now = Date.now();
  const tabIds = [];
  for (const id of recordIds) {
    const rec = getRecord(id);
    // A note means "don't lose this" — refuse to purge it even if asked, regardless of bucket.
    // The dashboard already excludes noted tabs from the purge candidate list; this is defense
    // in depth against a stale id slipping through.
    if (!rec || rec.closed || rec.note) continue;
    if (rec.tabId != null) {
      tabIds.push(rec.tabId);
      markPendingRemoval(rec.tabId, now); // finalize() below clears rec.tabId before Chrome
    } // actually removes the tab; guard against a straggling event re-creating it meanwhile.
    finalize(rec, now, 'purged');
  }
  if (tabIds.length) {
    try {
      await chrome.tabs.remove(tabIds);
    } catch {
      // Tab(s) already gone or removal failed: nothing left to guard against.
      for (const id of tabIds) pendingRemoval.delete(id);
    }
  }
  return { closed: tabIds.length };
});

/** Reopen closed records in new tabs, re-attached to their existing history. */
export const restore = (recordIds, { focus = false } = {}) => run(async () => {
  let opened = 0;
  for (const id of recordIds) {
    const rec = getRecord(id);
    if (!rec || !rec.closed) continue;
    const tab = await chrome.tabs.create({ url: rec.url, active: focus && opened === 0 });
    rec.tabId = tab.id;
    rec.windowId = tab.windowId;
    rec.closed = false;
    rec.closedAt = null;
    rec.closedReason = null;
    putRecord(rec);
    opened += 1;
  }
  return { opened };
});

export const dismiss = (recordIds) => run(() => {
  for (const id of recordIds) {
    const rec = getRecord(id);
    if (rec && rec.closed) deleteRecord(id);
  }
});

export const setAiSummary = ({ id, text, source, fingerprint }) => run(() => {
  const rec = getRecord(id);
  if (!rec || typeof text !== 'string') return;
  rec.ai = { text: text.slice(0, 300), source: String(source), fingerprint: String(fingerprint), at: Date.now() };
  putRecord(rec);
});

export const clearAll = () => run(() => {
  for (const rec of records()) deleteRecord(rec.id);
});

/** Called once per install/update: start tracking every tab that is already open. */
export const adoptExistingTabs = () => run(async () => {
  const now = Date.now();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) ensureRecordForTab(tab, now);
  await reconcile(now);
});

/** Set (or clear, with an empty string) a tab's follow-up note. Writing one exempts it from Purge. */
export const setNote = ({ id, note }) => run(() => {
  const rec = getRecord(id);
  if (!rec) return;
  rec.note = String(note || '').slice(0, 500);
  updateDerived(rec, Date.now());
});

// ---------------------------------------------------------------------------
// Daily check-list: domains the user wants a reminder to look at each day. Separate from the
// records store (a domain persists across whichever specific tab happens to be open for it),
// so it lives under its own storage key and is serialized on the same queue as everything else.

const WATCHLIST_KEY = 'watchlist';

async function readWatchlist() {
  const { [WATCHLIST_KEY]: list } = await chrome.storage.local.get(WATCHLIST_KEY);
  return Array.isArray(list) ? list : [];
}

export const getWatchlist = () => serialize(readWatchlist);

export const addWatch = ({ domain, label }) => serialize(async () => {
  const clean = String(domain || '').trim().toLowerCase();
  if (!clean) return { watchlist: await readWatchlist() };
  const list = await readWatchlist();
  if (!list.some((w) => w.domain === clean)) {
    list.push({ domain: clean, label: String(label || clean).slice(0, 100), addedAt: Date.now() });
    await chrome.storage.local.set({ [WATCHLIST_KEY]: list });
  }
  return { watchlist: list };
});

export const removeWatch = ({ domain }) => serialize(async () => {
  const clean = String(domain || '').trim().toLowerCase();
  const list = (await readWatchlist()).filter((w) => w.domain !== clean);
  await chrome.storage.local.set({ [WATCHLIST_KEY]: list });
  return { watchlist: list };
});

/** True if any record for this domain shows activity since local midnight. */
export function isCheckedToday(domain, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return records().some((r) => domainOf(r.url) === domain && (r.lastActiveAt || 0) >= start.getTime());
}
