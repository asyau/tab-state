import { classify, effectiveActiveMs } from '../lib/classifier.js';
import { BUCKET_META } from '../lib/config.js';
import { formatDuration, truncate } from '../lib/format.js';
import { describeAnchor } from '../lib/template.js';
import { domainOf } from '../lib/url.js';

export const SYSTEM_PROMPT = [
  'You write one-line reading-state notes for a browser tab dashboard.',
  'Given a web page and how the user engaged with it, write ONE sentence (max 22 words),',
  'in second person, saying what the user was doing on the page and where they stopped.',
  'Do not summarize the whole page. Do not invent details that are not in the input.',
  'No preamble, no quotes, no markdown. Output only the sentence.',
].join(' ');

/** Only page metadata and engagement metrics go into the prompt, never the page body. */
export function buildUserPrompt(r, now = Date.now()) {
  const bucket = classify(r, now);
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
  return lines.join('\n');
}

/** Models sometimes add quotes, prefixes or extra lines; keep one clean sentence. */
export function cleanOutput(text) {
  if (typeof text !== 'string') return '';
  let s = text.trim().split('\n').map((l) => l.trim()).find(Boolean) || '';
  s = s.replace(/^(summary|note|sentence)\s*:\s*/i, '').replace(/^["'“”`]+|["'“”`]+$/g, '').trim();
  return truncate(s, 220);
}
