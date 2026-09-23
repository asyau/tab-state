import { classify, effectiveActiveMs } from './classifier.js';
import { formatDuration, truncate } from './format.js';
import { domainOf } from './url.js';

/** Human phrase for where the reader stopped, e.g. `a code block in "Authentication"`. */
export function describeAnchor(anchor) {
  if (!anchor) return '';
  const heading = truncate(anchor.heading, 50);
  const snippet = truncate(anchor.snippet, 40);
  const where = heading ? ` in “${heading}”` : '';
  switch (anchor.kind) {
    case 'code': return `a code block${where}`;
    case 'table': return `a table${where}`;
    case 'heading': return heading ? `the “${heading}” section` : '';
    case 'text':
      if (heading) return `the “${heading}” section`;
      return snippet ? `the paragraph starting “${snippet}”` : '';
    default: return '';
  }
}

/**
 * Deterministic one-line summary. Always available, used when no AI provider works.
 * Prefixed with the page's own topic (its meta description, when the page has one) so even a
 * tab you never really looked at reads as more than "opened it for 2 seconds" — that line alone
 * tells you nothing about what the tab actually was.
 */
export function templateSummary(r, now = Date.now(), thresholds) {
  const bucket = classify(r, now, thresholds);
  const ms = effectiveActiveMs(r, now);
  const dur = formatDuration(ms);
  const pct = Math.round(r.maxScrollPct || 0);
  const anchor = describeAnchor(r.anchor);
  const topic = r.description ? truncate(r.description, 100) : '';

  let behavior;
  if (bucket === 'ghost') {
    behavior = ms > 0 ? 'Barely opened (under 2s) and never read.' : 'Opened in the background, never viewed.';
  } else if (bucket === 'glanced') {
    behavior = pct > 0 ? `Skipped after ${dur}, only saw the top ${pct}%.` : `Skipped after ${dur}.`;
  } else {
    const extras = [];
    if (r.copies > 0) extras.push(r.copies > 1 ? `copied ${r.copies} snippets` : 'copied a snippet');
    if (r.highlights > 0) extras.push('highlighted text');

    let s = bucket === 'deep' ? `Spent ${dur} reading ${pct}% of the page` : `Skimmed ${pct}% over ${dur}`;
    if (extras.length) s += `, ${extras.join(' and ')}`;
    if (anchor) s += `${extras.length ? ',' : ''} and stopped at ${anchor}`;
    behavior = `${s}.`;
  }
  return topic ? `${topic} — ${behavior}` : behavior;
}

/**
 * Changes whenever an AI summary would meaningfully change.
 * Lets the dashboard reuse a cached AI summary instead of regenerating it.
 */
export function summaryFingerprint(r, now = Date.now(), thresholds) {
  const minutes = Math.floor(effectiveActiveMs(r, now) / 60_000);
  return [
    classify(r, now, thresholds),
    Math.floor((r.maxScrollPct || 0) / 10),
    minutes,
    r.copies > 0 ? 1 : 0,
    r.highlights > 0 ? 1 : 0,
    r.anchor ? `${r.anchor.kind}:${r.anchor.heading || r.anchor.snippet || ''}` : '',
    r.note || '',
  ].join('|');
}

/** Deterministic "how the session went" line — the AI-free fallback for the recap banner. */
export function templateSessionSummary(records, now = Date.now(), thresholds) {
  if (!records.length) return 'Nothing tracked yet. Browse normally and check back.';
  const withBucket = records.map((r) => ({ r, bucket: classify(r, now, thresholds) }));
  const deep = withBucket.filter((x) => x.bucket === 'deep').length;
  const partial = withBucket.filter((x) => x.bucket === 'partial').length;
  const missed = withBucket.filter((x) => x.bucket === 'ghost' || x.bucket === 'glanced').length;

  const timeByDomain = new Map();
  for (const { r } of withBucket) {
    const d = domainOf(r.url);
    timeByDomain.set(d, (timeByDomain.get(d) || 0) + effectiveActiveMs(r, now));
  }
  const [topDomain] = [...timeByDomain.entries()].sort((a, b) => b[1] - a[1])[0] || [];

  const parts = [`Tracked ${records.length} tab${records.length === 1 ? '' : 's'}`];
  const focus = [];
  if (deep) focus.push(`${deep} deep focus`);
  if (partial) focus.push(`${partial} partially read`);
  if (focus.length) parts.push(`, ${focus.join(' and ')}`);
  if (missed) parts.push(`, ${missed} skipped or never opened`);
  if (topDomain) parts.push(` — most time on ${topDomain}`);
  return `${parts.join('')}.`;
}
