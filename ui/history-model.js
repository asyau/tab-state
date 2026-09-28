// Pure data shaping for the History page (ui/history.js): days, per-site groups, filters and
// "where your time went" shares. No DOM and no chrome.* here, so it's unit-tested directly
// (tests/unit/history.test.js).

import { effectiveActiveMs } from '../lib/classifier.js';

/** Visits shorter than this are "quick" — hidden by default unless noted or asked for by bucket. */
export const QUICK_MS = 10_000;
/** How many sites get their own color in the time bar; the rest fold into "Other". */
export const TOP_SITES = 4;

/** The site a tab belongs to: its hostname without "www.". Subdomains stay distinct on purpose —
 *  gemini.google.com, mail.google.com and google.com (search) are different things you did. */
export function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url;
  } catch {
    return url || '';
  }
}

/** The day a tab counts under: when you were last actually engaged with it, not when it opened —
 *  a tab opened Monday and read today shows under today, which is where you'd look for it. */
export function dayKeyOf(rec) {
  const d = new Date(rec.lastActiveAt || rec.createdAt || 0);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayLabel(dayKey, now) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - dayKey) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const sixMonthsAgo = new Date(now); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  return new Date(dayKey).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
    year: dayKey < sixMonthsAgo.getTime() ? 'numeric' : undefined,
  });
}

const recency = (r) => r.lastActiveAt || r.createdAt || 0;

/** Newest day first; within a day, most recently used first. */
export function groupByDay(records, now) {
  const groups = new Map();
  for (const rec of records) {
    const key = dayKeyOf(rec);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([key, list]) => ({ key, label: dayLabel(key, now), records: list.sort((a, b) => recency(b) - recency(a)) }));
}

export function matchesQuery(rec, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [rec.title, rec.url, rec.note, rec.description, siteOf(rec.url)]
    .some((field) => field && String(field).toLowerCase().includes(q));
}

/**
 * Apply the toolbar's filters. `bucketOf(rec)` classifies a record (injected so this stays pure).
 * Quick visits are hidden only when no bucket is picked explicitly — asking for "Ghost" means you
 * want the unread ones — and never when the tab has a note (you flagged it on purpose).
 */
export function filterRecords(records, { query = '', buckets = new Set(), hideQuick = false } = {}, now, bucketOf) {
  const shown = [];
  let hiddenQuick = 0;
  for (const rec of records) {
    if (!matchesQuery(rec, query)) continue;
    if (buckets.size && !buckets.has(bucketOf(rec))) continue;
    if (hideQuick && !buckets.size && !rec.note && effectiveActiveMs(rec, now) < QUICK_MS) {
      hiddenQuick += 1;
      continue;
    }
    shown.push(rec);
  }
  return { shown, hiddenQuick };
}

/** One entry per site, most reading time first (ties: most recent); visits newest first. */
export function groupBySite(records, now) {
  const bySite = new Map();
  for (const rec of records) {
    const site = siteOf(rec.url);
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push(rec);
  }
  return [...bySite.entries()]
    .map(([site, list]) => ({
      site,
      records: list.sort((a, b) => recency(b) - recency(a)),
      totalMs: list.reduce((sum, r) => sum + effectiveActiveMs(r, now), 0),
      lastAt: Math.max(...list.map(recency)),
    }))
    .sort((a, b) => b.totalMs - a.totalMs || b.lastAt - a.lastAt);
}

/** Where a day's reading time went: the top sites by time, plus everything else as "Other". */
export function timeShares(records, now, top = TOP_SITES) {
  const sites = groupBySite(records, now).filter((g) => g.totalMs > 0);
  const totalMs = sites.reduce((sum, g) => sum + g.totalMs, 0);
  const segments = sites.slice(0, top).map((g) => ({ site: g.site, ms: g.totalMs, url: g.records[0].url }));
  const otherMs = sites.slice(top).reduce((sum, g) => sum + g.totalMs, 0);
  return { totalMs, segments, otherMs, otherSites: Math.max(0, sites.length - top) };
}
