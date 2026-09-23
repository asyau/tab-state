import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, effectiveActiveMs } from '../../lib/classifier.js';
import { normalizeUrl, isTrackable, domainOf } from '../../lib/url.js';
import { formatDuration } from '../../lib/format.js';
import { templateSummary, templateInsight, describeAnchor, summaryFingerprint } from '../../lib/template.js';
import { buildUserPrompt, cleanOutput } from '../../ai/prompt.js';

const rec = (over = {}) => ({
  activeMs: 0, activeSince: null, lastSeen: null, maxScrollPct: 0, copies: 0, highlights: 0, ...over,
});
const S = 1000;

test('classify: spec examples land in the right bucket', () => {
  assert.equal(classify(rec()), 'ghost', 'never viewed');
  assert.equal(classify(rec({ activeMs: 1.5 * S, maxScrollPct: 12 })), 'ghost', 'under 2s');
  assert.equal(classify(rec({ activeMs: 5 * S, maxScrollPct: 8 })), 'glanced', 'clickbait recipe');
  assert.equal(classify(rec({ activeMs: 60 * S, maxScrollPct: 40 })), 'partial', 'skimmed blog post');
  assert.equal(classify(rec({ activeMs: 120 * S, maxScrollPct: 30 })), 'deep', 'long read');
  assert.equal(classify(rec({ activeMs: 40 * S, maxScrollPct: 90 })), 'deep', 'read to the end');
  assert.equal(classify(rec({ activeMs: 3 * S, highlights: 1 })), 'deep', 'highlight always counts');
  assert.equal(classify(rec({ copies: 1 })), 'deep', 'copy counts even if never timed');
});

test('classify: gaps in the spec are covered', () => {
  assert.equal(classify(rec({ activeMs: 20 * S, maxScrollPct: 5 })), 'partial', '15-30s');
  assert.equal(classify(rec({ activeMs: 8 * S, maxScrollPct: 30 })), 'partial', 'quick scroll past a quarter');
  assert.equal(classify(rec({ activeMs: 4 * S, maxScrollPct: 100 })), 'glanced', 'short page, quick look');
  assert.equal(classify(rec({ activeMs: 20 * S, maxScrollPct: 100 })), 'partial', 'short page, 20s');
});

test('effectiveActiveMs includes the running segment, capped by the heartbeat', () => {
  const now = 1_000_000;
  assert.equal(effectiveActiveMs(rec({ activeMs: 10 * S, activeSince: now - 20 * S, lastSeen: now - 5 * S }), now), 30 * S);
  // Last heartbeat an hour ago: only grace period counted.
  assert.equal(effectiveActiveMs(rec({ activeSince: now - 3600 * S, lastSeen: now - 3600 * S }), now), 45 * S);
});

test('url normalization', () => {
  assert.equal(normalizeUrl('https://a.com/x?utm_source=g&id=3#sec'), 'https://a.com/x?id=3');
  assert.equal(normalizeUrl('https://a.com/x#one'), normalizeUrl('https://a.com/x#two'));
  assert.equal(normalizeUrl('chrome://newtab/'), null);
  assert.equal(normalizeUrl('chrome-extension://abc/ui/dashboard.html'), null);
  assert.equal(normalizeUrl('not a url'), null);
  assert.ok(isTrackable('file:///tmp/a.html'));
  assert.equal(domainOf('https://www.example.com/a'), 'example.com');
});

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(59_400), '59s');
  assert.equal(formatDuration(120_000), '2m');
  assert.equal(formatDuration(130_000), '2m 10s');
  assert.equal(formatDuration(3_900_000), '1h 5m');
});

test('template summaries read naturally', () => {
  assert.equal(templateSummary(rec()), 'Opened in the background, never viewed.');
  assert.equal(templateSummary(rec({ activeMs: 5 * S, maxScrollPct: 8 })), 'Skipped after 5s, only saw the top 8%.');
  assert.equal(
    templateSummary(rec({ activeMs: 45 * S, maxScrollPct: 40, anchor: { kind: 'heading', heading: 'Installation', snippet: '' } })),
    'Skimmed 40% over 45s and stopped at the “Installation” section.');
  assert.equal(
    templateSummary(rec({ activeMs: 130 * S, maxScrollPct: 90, copies: 1, anchor: { kind: 'code', heading: 'Authentication', snippet: 'curl' } })),
    'Spent 2m 10s reading 90% of the page, copied a snippet, and stopped at a code block in “Authentication”.');
  assert.equal(templateSummary(rec({ activeMs: 100 * S, maxScrollPct: 50 })), 'Spent 1m 40s reading 50% of the page.');
});

test('templateSummary prefixes the page topic when a meta description is present', () => {
  // A ghost tab tells you nothing useful without this — "opened it for 2s" alone has no context.
  const ghost = rec({ description: 'A physics-based robotics simulator for training and testing AI models.' });
  assert.equal(
    templateSummary(ghost),
    'A physics-based robotics simulator for training and testing AI models. — Opened in the background, never viewed.',
  );
  // No description: behaves exactly as before, no dangling separator.
  assert.equal(templateSummary(rec({ activeMs: 5 * S, maxScrollPct: 8 })), 'Skipped after 5s, only saw the top 8%.');
  // Long descriptions are truncated, same as everywhere else in the app.
  const long = rec({ description: 'x'.repeat(200) });
  const summary = templateSummary(long);
  assert.ok(summary.startsWith('x'.repeat(99) + '…'), summary);
});

test('templateInsight adds the selection and note as extra sentences', () => {
  const bare = rec({ activeMs: 5 * S, maxScrollPct: 8 });
  assert.equal(templateInsight(bare), templateSummary(bare), 'no selection/note: same as the one-liner');

  const rich = rec({
    activeMs: 5 * S, maxScrollPct: 8,
    selectionSnippet: 'curl -u sk_test_123', note: 'reread before the interview',
  });
  const insight = templateInsight(rich);
  assert.ok(insight.startsWith(templateSummary(rich)), insight);
  assert.match(insight, /The last thing you selected: “curl -u sk_test_123”\./);
  assert.match(insight, /Your note: “reread before the interview”\./);
});

test('describeAnchor handles missing data', () => {
  assert.equal(describeAnchor(null), '');
  assert.equal(describeAnchor({ kind: 'text', heading: '', snippet: '' }), '');
  assert.equal(describeAnchor({ kind: 'table', heading: '', snippet: 'x' }), 'a table');
  assert.equal(describeAnchor({ kind: 'text', heading: '', snippet: 'Once upon a time' }), 'the paragraph starting “Once upon a time”');
});

test('summaryFingerprint changes only when the story changes', () => {
  const a = rec({ activeMs: 100 * S, maxScrollPct: 51 });
  assert.equal(summaryFingerprint(a), summaryFingerprint({ ...a, maxScrollPct: 55 }));
  assert.notEqual(summaryFingerprint(a), summaryFingerprint({ ...a, maxScrollPct: 71 }));
  assert.notEqual(summaryFingerprint(a), summaryFingerprint({ ...a, copies: 1 }));
});

test('prompt contains metrics but no page body, and output is cleaned', () => {
  const p = buildUserPrompt(rec({
    title: 'Auth docs', url: 'https://docs.x.com/auth', activeMs: 130 * S, maxScrollPct: 90, copies: 1,
    anchor: { kind: 'code', heading: 'Authentication', snippet: 'curl -u key' },
  }));
  assert.match(p, /Title: Auth docs/);
  assert.match(p, /Site: docs\.x\.com/);
  assert.match(p, /Active time: 2m 10s/);
  assert.match(p, /Stopped at: a code block in “Authentication”/);
  assert.equal(cleanOutput('Summary: "You read the auth section."\nExtra line'), 'You read the auth section.');
  assert.equal(cleanOutput(undefined), '');
});
