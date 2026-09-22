import { classify, effectiveActiveMs } from './classifier.js';
import { formatDuration, truncate } from './format.js';

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

/** Deterministic one-line summary. Always available, used when no AI provider works. */
export function templateSummary(r, now = Date.now()) {
  const bucket = classify(r, now);
  const ms = effectiveActiveMs(r, now);
  const dur = formatDuration(ms);
  const pct = Math.round(r.maxScrollPct || 0);
  const anchor = describeAnchor(r.anchor);

  if (bucket === 'ghost') {
    return ms > 0 ? 'Barely opened (under 2s) and never read.' : 'Opened in the background, never viewed.';
  }
  if (bucket === 'glanced') {
    return pct > 0 ? `Skipped after ${dur}, only saw the top ${pct}%.` : `Skipped after ${dur}.`;
  }

  const extras = [];
  if (r.copies > 0) extras.push(r.copies > 1 ? `copied ${r.copies} snippets` : 'copied a snippet');
  if (r.highlights > 0) extras.push('highlighted text');

  let s = bucket === 'deep' ? `Spent ${dur} reading ${pct}% of the page` : `Skimmed ${pct}% over ${dur}`;
  if (extras.length) s += `, ${extras.join(' and ')}`;
  if (anchor) s += `${extras.length ? ',' : ''} and stopped at ${anchor}`;
  return `${s}.`;
}

/**
 * Changes whenever an AI summary would meaningfully change.
 * Lets the dashboard reuse a cached AI summary instead of regenerating it.
 */
export function summaryFingerprint(r, now = Date.now()) {
  const minutes = Math.floor(effectiveActiveMs(r, now) / 60_000);
  return [
    classify(r, now),
    Math.floor((r.maxScrollPct || 0) / 10),
    minutes,
    r.copies > 0 ? 1 : 0,
    r.highlights > 0 ? 1 : 0,
    r.anchor ? `${r.anchor.kind}:${r.anchor.heading || r.anchor.snippet || ''}` : '',
  ].join('|');
}
