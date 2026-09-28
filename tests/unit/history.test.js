import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  siteOf, groupByDay, filterRecords, groupBySite, timeShares, matchesQuery, QUICK_MS,
} from '../../ui/history-model.js';

const NOW = new Date('2026-09-28T15:00:00').getTime();
const S = 1000;
let n = 0;
const rec = (url, activeMs, extra = {}) => ({
  id: `r${++n}`, url, title: extra.title ?? url, activeMs, activeSince: null,
  lastActiveAt: NOW - n * 60 * S, createdAt: NOW - n * 60 * S, note: '', ...extra,
});
const bucketOf = (r) => (r.activeMs >= 90 * S ? 'deep' : r.activeMs >= 15 * S ? 'partial' : r.activeMs >= 2 * S ? 'glanced' : 'ghost');

test('siteOf: hostname without www, subdomains kept apart', () => {
  assert.equal(siteOf('https://www.reddit.com/r/x'), 'reddit.com');
  assert.equal(siteOf('https://gemini.google.com/app'), 'gemini.google.com');
  assert.equal(siteOf('https://mail.google.com/'), 'mail.google.com');
  assert.equal(siteOf('not a url'), 'not a url');
});

test('groupBySite: repeat visits fold into one group, most reading time first', () => {
  const records = [
    rec('https://chatgpt.com/a', 7 * S), rec('https://chatgpt.com/b', 4 * S), rec('https://chatgpt.com/c', 0),
    rec('https://gemini.google.com/x', 387 * S),
    rec('https://higgsfield.ai/billing', 21 * S), rec('https://higgsfield.ai/cashback', 99 * S),
  ];
  const groups = groupBySite(records, NOW);
  assert.deepEqual(groups.map((g) => g.site), ['gemini.google.com', 'higgsfield.ai', 'chatgpt.com']);
  assert.equal(groups[1].totalMs, 120 * S);
  assert.equal(groups[2].records.length, 3);
  assert.ok(groups[2].records[0].lastActiveAt >= groups[2].records[1].lastActiveAt, 'visits newest first');
});

test('filterRecords: quick visits hidden by default, but never a noted tab', () => {
  const records = [
    rec('https://a.com/', 2 * S), rec('https://b.com/', 0), rec('https://c.com/', 45 * S),
    rec('https://d.com/', 3 * S, { note: 'keep this' }),
  ];
  const { shown, hiddenQuick } = filterRecords(records, { hideQuick: true }, NOW, bucketOf);
  assert.deepEqual(shown.map((r) => r.url), ['https://c.com/', 'https://d.com/']);
  assert.equal(hiddenQuick, 2);
  assert.equal(filterRecords(records, { hideQuick: false }, NOW, bucketOf).shown.length, 4);
  assert.ok(QUICK_MS === 10 * S);
});

test('filterRecords: picking a bucket shows exactly that bucket, quick visits included', () => {
  const records = [rec('https://a.com/', 0), rec('https://b.com/', 200 * S), rec('https://c.com/', 20 * S)];
  const ghosts = filterRecords(records, { hideQuick: true, buckets: new Set(['ghost']) }, NOW, bucketOf);
  assert.deepEqual(ghosts.shown.map((r) => r.url), ['https://a.com/'], 'asking for Ghost must not hide the unread ones');
  const two = filterRecords(records, { buckets: new Set(['deep', 'partial']) }, NOW, bucketOf);
  assert.deepEqual(two.shown.map((r) => r.url).sort(), ['https://b.com/', 'https://c.com/']);
});

test('search matches title, site, url and note, case-insensitively', () => {
  const r = rec('https://www.higgsfield.ai/cashback', 30 * S, { title: 'Cashback | Higgsfield API', note: 'ask about Pro' });
  assert.ok(matchesQuery(r, 'CASHBACK'));
  assert.ok(matchesQuery(r, 'higgsfield.ai'));
  assert.ok(matchesQuery(r, 'about pro'));
  assert.ok(!matchesQuery(r, 'gemini'));
  assert.ok(matchesQuery(r, '   '), 'blank query matches everything');
});

test('timeShares: top sites by reading time, the rest folded into Other', () => {
  const records = [
    rec('https://a.com/', 100 * S), rec('https://b.com/', 50 * S), rec('https://c.com/', 40 * S),
    rec('https://d.com/', 30 * S), rec('https://e.com/', 20 * S), rec('https://f.com/', 10 * S),
    rec('https://g.com/', 0),
  ];
  const t = timeShares(records, NOW);
  assert.equal(t.totalMs, 250 * S);
  assert.deepEqual(t.segments.map((s) => s.site), ['a.com', 'b.com', 'c.com', 'd.com']);
  assert.equal(t.otherMs, 30 * S);
  assert.equal(t.otherSites, 2, 'unread sites are not counted as time');
});

test('groupByDay: grouped by last engagement, newest day first', () => {
  const today = rec('https://a.com/', 5 * S, { lastActiveAt: NOW - 3600 * S / 1000 * 1000 });
  const yesterday = rec('https://b.com/', 5 * S, { lastActiveAt: NOW - 24 * 3600 * S });
  const days = groupByDay([yesterday, today], NOW);
  assert.deepEqual(days.map((d) => d.label), ['Today', 'Yesterday']);
});
