import { classify, effectiveActiveMs } from '../lib/classifier.js';
import { BUCKET_META } from '../lib/config.js';
import { formatDuration, truncate } from '../lib/format.js';
import { describeAnchor } from '../lib/template.js';
import { domainOf } from '../lib/url.js';

export const SYSTEM_PROMPT = [
  'You write one-line reading-state notes for a browser tab dashboard.',
  'Given a web page and how the user engaged with it, write ONE sentence (max 24 words),',
  'in second person, saying what the user was doing on the page and where they stopped.',
  'Briefly name what the page is actually about (a few words, from its title/description) so the',
  'sentence gives context even for a tab the user barely looked at — this matters most for low',
  'engagement, since "you opened it for 2 seconds" alone says nothing about what the tab was.',
  'If the user left their own note about why the page matters, weave its intent in naturally',
  'instead of quoting it verbatim.',
  "Do not summarize the page's full content or argument. Do not invent details not in the input.",
  'No preamble, no quotes, no markdown. Output only the sentence.',
].join(' ');

/** Only page metadata and engagement metrics go into the prompt, never the page body. */
export function buildUserPrompt(r, now = Date.now(), thresholds) {
  const bucket = classify(r, now, thresholds);
  const lines = [
    `Title: ${truncate(r.title, 150)}`,
    `Site: ${domainOf(r.url)}`,
  ];
  if (r.description) lines.push(`Description: ${truncate(r.description, 200)}`);
  lines.push(
    `Engagement: ${BUCKET_META[bucket].label}`,
    `Active time: ${formatDuration(effectiveActiveMs(r, now))}`,
    `Scrolled: ${Math.round(r.maxScrollPct || 0)}% of the page`,
  );
  if (r.copies) lines.push(`Copied text: ${r.copies} time(s)`);
  if (r.highlights) lines.push(`Highlighted text: ${r.highlights} time(s)`);
  if (r.selectionSnippet) lines.push(`Last selected text: "${truncate(r.selectionSnippet, 120)}"`);
  const anchor = describeAnchor(r.anchor);
  if (anchor) lines.push(`Stopped at: ${anchor}`);
  if (r.anchor?.snippet && r.anchor.kind !== 'heading') lines.push(`Text there: "${truncate(r.anchor.snippet, 100)}"`);
  if (r.note) lines.push(`User's own note: "${truncate(r.note, 200)}"`);
  return lines.join('\n');
}

/** Models sometimes add quotes, prefixes or extra lines; keep one clean sentence. */
export function cleanOutput(text) {
  if (typeof text !== 'string') return '';
  let s = text.trim().split('\n').map((l) => l.trim()).find(Boolean) || '';
  s = s.replace(/^(summary|note|sentence)\s*:\s*/i, '').replace(/^["'“”`]+|["'“”`]+$/g, '').trim();
  return truncate(s, 220);
}

// --- Session recap ------------------------------------------------------------------

export const SESSION_SYSTEM_PROMPT = [
  'You write a one-sentence recap of a browsing session for a tab dashboard.',
  'Given a list of tabs and how the user engaged with each, write ONE sentence (max 28 words),',
  'in second person, naming the main topic(s) they focused on and what they skipped or missed.',
  'Do not list every tab. Do not invent topics not present in the titles/domains given.',
  'No preamble, no quotes, no markdown. Output only the sentence.',
].join(' ');

/** Summarizes the whole tracked session (not one tab) for the dashboard's recap line. */
export function buildSessionPrompt(records, now = Date.now(), thresholds) {
  const withBucket = records.map((r) => ({ r, bucket: classify(r, now, thresholds) }));
  const line = ({ r, bucket }) => {
    const parts = [truncate(r.title || domainOf(r.url), 80), `(${BUCKET_META[bucket].label}`];
    if (r.copies || r.highlights) parts[1] += ', saved something';
    parts[1] += ')';
    return parts.join(' ');
  };
  const deep = withBucket.filter((x) => x.bucket === 'deep');
  const partial = withBucket.filter((x) => x.bucket === 'partial');
  const missed = withBucket.filter((x) => x.bucket === 'ghost' || x.bucket === 'glanced');

  const lines = [`Tabs tracked this session: ${withBucket.length}`];
  if (deep.length) lines.push(`Deep focus:\n${deep.map(line).join('\n')}`);
  if (partial.length) lines.push(`Partially read:\n${partial.map(line).join('\n')}`);
  if (missed.length) lines.push(`Glanced or never opened (${missed.length}): ${missed.slice(0, 8).map((x) => truncate(x.r.title || domainOf(x.r.url), 40)).join(', ')}`);
  return lines.join('\n\n');
}

// --- AI-assisted tab grouping ---------------------------------------------------------

export const GROUPING_SYSTEM_PROMPT = [
  'You group browser tabs by topic for a tab manager.',
  'Given a numbered list of open tabs (title + domain), propose 2-5 groups of CLEARLY related',
  'tabs. Leave unrelated or single tabs out of any group rather than forcing a weak grouping.',
  'Respond with ONLY a JSON array, no markdown fence, no prose, in this exact shape:',
  '[{"name": "short group name (max 4 words)", "indexes": [1, 3, 7]}]',
  'indexes must be numbers from the input list. A tab may appear in at most one group.',
].join(' ');

/** Numbered tab list for the grouping prompt; returns the prompt text and an index->id map. */
export function buildGroupingPrompt(records) {
  const map = new Map();
  const lines = records.map((r, i) => {
    const idx = i + 1;
    map.set(idx, r.id);
    return `${idx}. ${truncate(r.title || r.url, 90)} — ${domainOf(r.url)}`;
  });
  return { prompt: lines.join('\n'), indexToId: map };
}
