// Every tab ever tracked, by day — kept forever (see lib/tracker.js's prune()). Two panes: a dense
// list on the left (repeat visits to a site folded into one expandable group, sorted by reading
// time) and a details panel on the right that follows the hovered / keyboard-selected tab. Above
// each day, a bar of where that day's reading time went. Filters: search, buckets, and hiding
// quick (<10s) visits, which are most of any day's list.
//
// Data shaping lives in history-model.js (pure, unit-tested); this file is DOM + chrome.* only.
// Deliberately separate from dashboard.js: no live re-render on a heartbeat, no purge or notes.

import { classify, effectiveActiveMs } from '../lib/classifier.js';
import { formatAgo, formatDuration, truncate } from '../lib/format.js';
import { RECORD_PREFIX } from '../lib/store.js';
import { templateSummary, describeAnchor } from '../lib/template.js';
import { loadSettings } from '../lib/settings.js';
import { BUCKET_META } from '../lib/config.js';
import {
  siteOf, groupByDay, filterRecords, groupBySite, timeShares,
} from './history-model.js';

const $ = (sel) => document.querySelector(sel);
const PREFS_KEY = 'ts-history-prefs'; // per-viewer UI convenience only (see prefs below)
const HOVER_DELAY_MS = 80;

const state = {
  records: [],
  settings: null,
  tabsById: new Map(),
  query: '',
  buckets: new Set(),
  hideQuick: true,
  expanded: new Set(), // `${dayKey}|${site}` groups the user opened
  selectedId: null,
  pinnedId: null, // clicked: hover stops changing the panel until Esc or another click
};

// --- Data ---------------------------------------------------------------------------------

async function loadData() {
  const [stored, tabs, s] = await Promise.all([
    chrome.storage.local.get(null),
    chrome.tabs.query({}),
    loadSettings(),
  ]);
  state.settings = s;
  state.tabsById = new Map(tabs.map((t) => [t.id, t]));
  state.records = Object.entries(stored)
    .filter(([key]) => key.startsWith(RECORD_PREFIX))
    .map(([, rec]) => rec)
    .filter((rec) => rec.closedReason !== 'purged');
}

const isOpen = (rec) => !rec.closed && rec.tabId != null && state.tabsById.has(rec.tabId);
const bucketOf = (rec) => classify(rec, Date.now(), state.settings.thresholds);
const byId = (id) => state.records.find((r) => r.id === id);

function faviconUrl(pageUrl) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', '32');
  return u.toString();
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

function favicon(url) {
  return el('img', { class: 'favicon', src: faviconUrl(url), alt: '', width: '16', height: '16' });
}

const PIN_SVG = '<svg class="icon row-pin" viewBox="0 0 24 24" role="img" aria-label="Has a note"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
const CHEVRON_SVG = '<svg class="icon hs-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

function statText(rec, now) {
  const ms = effectiveActiveMs(rec, now);
  return bucketOf(rec) === 'ghost' || ms === 0 ? 'unread' : formatDuration(ms);
}

// --- Rendering ------------------------------------------------------------------------------

function buildRow(rec, now, { nested = false } = {}) {
  const row = el('button', {
    class: `hs-row hs-nav${nested ? ' nested' : ''}${rec.id === state.selectedId ? ' is-selected' : ''}`,
    type: 'button',
    dataset: { id: rec.id },
    title: rec.url,
  },
  favicon(rec.url),
  el('span', { class: 'hs-row-title' }, rec.title || rec.url),
  isOpen(rec) ? el('span', { class: 'hs-open', title: 'Still open' }, 'open') : null);
  if (rec.note) row.insertAdjacentHTML('beforeend', PIN_SVG);
  row.append(el('span', { class: 'row-stat' }, statText(rec, now)));
  row.setAttribute('aria-label', `${rec.title || rec.url}, ${siteOf(rec.url)}, ${statText(rec, now)}${isOpen(rec) ? ', open' : ''}`);
  return row;
}

/** `siteTotals` is per-site time and visit count over the *whole* day, so a group's numbers match
 *  the time bar above it even when filters hide some of its visits ("2 of 8 tabs"). */
function buildGroup(dayKey, group, now, siteTotals) {
  if (group.records.length === 1) return buildRow(group.records[0], now);
  const all = siteTotals.get(group.site) ?? { count: group.records.length, ms: group.totalMs };
  const key = `${dayKey}|${group.site}`;
  const expanded = state.expanded.has(key) || state.query.trim() !== '';
  const head = el('button', {
    class: 'hs-group-head hs-nav', type: 'button', 'aria-expanded': String(expanded), dataset: { group: key },
  });
  head.insertAdjacentHTML('beforeend', CHEVRON_SVG);
  head.append(
    favicon(group.records[0].url),
    el('span', { class: 'hs-row-title' }, group.site),
    el('span', { class: 'hs-visits muted' },
      all.count > group.records.length ? `${group.records.length} of ${all.count} tabs` : `${all.count} tabs`),
    el('span', { class: 'row-stat' }, all.ms ? formatDuration(all.ms) : 'unread'),
  );
  const rows = el('div', { class: 'hs-group-rows' }, ...group.records.map((r) => buildRow(r, now, { nested: true })));
  rows.hidden = !expanded;
  return el('div', { class: 'hs-group' }, head, rows);
}

function buildTimebar(dayRecords, now) {
  const { totalMs, segments, otherMs, otherSites } = timeShares(dayRecords, now);
  if (totalMs < 1000) return null;
  const parts = segments.map((s, i) => ({ ...s, cls: `s${i + 1}`, label: s.site }));
  if (otherMs > 0) parts.push({ site: null, ms: otherMs, cls: 'other', label: `${otherSites} other site${otherSites === 1 ? '' : 's'}` });

  const bar = el('div', { class: 'hs-bar', role: 'img', 'aria-label': `Reading time: ${parts.map((p) => `${p.label} ${formatDuration(p.ms)}`).join(', ')}` },
    ...parts.map((p) => el('span', {
      class: `hs-seg ${p.cls}`,
      style: `flex-grow: ${p.ms}`,
      title: `${p.label} — ${formatDuration(p.ms)} (${Math.round((p.ms / totalMs) * 100)}%)`,
    })));
  // The legend is the labels *and* the table view: every segment's site and time in text, so
  // color never carries identity alone. Clicking a site filters the list to it.
  const legend = el('div', { class: 'hs-legend' }, ...parts.map((p) => {
    const item = el(p.site ? 'button' : 'span', {
      class: `hs-legend-item${p.site ? '' : ' static'}`,
      ...(p.site ? { type: 'button', title: `Show only ${p.site}` } : {}),
    },
    el('span', { class: `hs-swatch ${p.cls}`, 'aria-hidden': 'true' }),
    p.site ? favicon(p.url) : null,
    el('span', { class: 'hs-legend-site' }, p.label),
    el('span', { class: 'muted' }, formatDuration(p.ms)));
    if (p.site) item.addEventListener('click', () => setQuery(p.site));
    return item;
  }));
  return el('div', { class: 'hs-timebar' },
    el('p', { class: 'hs-timebar-label muted' }, `Where your ${formatDuration(totalMs)} of reading went`),
    bar, legend);
}

function render() {
  const now = Date.now();
  const filters = { query: state.query, buckets: state.buckets, hideQuick: state.hideQuick };
  const days = groupByDay(state.records, now);
  let shownTotal = 0;

  const sections = days.map(({ key, label, records: dayRecords }) => {
    const { shown, hiddenQuick } = filterRecords(dayRecords, filters, now, bucketOf);
    shownTotal += shown.length;
    const dayMs = dayRecords.reduce((sum, r) => sum + effectiveActiveMs(r, now), 0);

    const head = el('header', { class: 'hs-day-head' },
      el('h2', {}, label),
      el('span', { class: 'muted' }, `${dayRecords.length} tabs · ${formatDuration(dayMs)} read`));
    if (hiddenQuick) {
      const show = el('button', { class: 'hs-linklike', type: 'button' }, 'show them');
      show.addEventListener('click', () => setHideQuick(false));
      head.append(el('span', { class: 'hs-hidden-note muted' }, `· ${hiddenQuick} quick visit${hiddenQuick === 1 ? '' : 's'} hidden — `, show));
    }
    const siteTotals = new Map(groupBySite(dayRecords, now).map((g) => [g.site, { count: g.records.length, ms: g.totalMs }]));
    const groups = groupBySite(shown, now).map((g) => buildGroup(key, g, now, siteTotals));
    if (!shown.length && dayRecords.length) return null; // the whole day filtered out
    return el('section', { class: 'hs-day', dataset: { day: String(key) } },
      head, buildTimebar(dayRecords, now), el('div', { class: 'hs-groups' }, ...groups));
  }).filter(Boolean);

  $('#days').replaceChildren(...sections);
  $('#empty').hidden = state.records.length > 0;
  $('#no-match').hidden = !state.records.length || shownTotal > 0;

  const totalMs = state.records.reduce((sum, r) => sum + effectiveActiveMs(r, now), 0);
  $('#stats').textContent = days.length
    ? `${state.records.length} tabs across ${days.length} day${days.length === 1 ? '' : 's'} · ${formatDuration(totalMs)} of reading`
    : '';
  $('#hs-showing').textContent = state.records.length ? `Showing ${shownTotal} of ${state.records.length}` : '';

  if (state.selectedId && !document.querySelector(`.hs-row[data-id="${CSS.escape(state.selectedId)}"]`)) {
    // Filtered out of view: keep showing it only if it was pinned on purpose.
    if (state.pinnedId !== state.selectedId) showDetail(null);
  }
}

// --- Details panel --------------------------------------------------------------------------

function badge(text, title) {
  return el('span', { class: 'badge', ...(title ? { title } : {}) }, text);
}

function showSection(sectionId, textId, text) {
  $(`#${sectionId}`).hidden = !text;
  if (text) $(`#${textId}`).textContent = text;
}

function showDetail(rec) {
  state.selectedId = rec?.id ?? null;
  document.querySelectorAll('.hs-row.is-selected').forEach((r) => r.classList.remove('is-selected'));
  if (rec) document.querySelector(`.hs-row[data-id="${CSS.escape(rec.id)}"]`)?.classList.add('is-selected');
  $('#hs-panel-empty').hidden = !!rec;
  $('#hs-panel-body').hidden = !rec;
  if (!rec) return;

  const now = Date.now();
  const open = isOpen(rec);
  const bucket = bucketOf(rec);
  $('#detail-favicon').src = faviconUrl(rec.url);
  $('#detail-title').textContent = rec.title || rec.url;
  const when = open
    ? (rec.lastActiveAt ? `active ${formatAgo(rec.lastActiveAt, now)}` : `opened ${formatAgo(rec.createdAt, now)}`)
    : `closed ${formatAgo(rec.closedAt || rec.lastActiveAt || rec.createdAt, now)}`;
  $('#detail-meta').textContent = `${siteOf(rec.url)} · ${BUCKET_META[bucket]?.label ?? bucket} · ${when}`;
  $('#detail-url').textContent = rec.url;

  const ms = effectiveActiveMs(rec, now);
  const badges = $('#detail-badges');
  badges.replaceChildren();
  if (bucket === 'ghost') badges.append(badge('never opened'));
  else {
    badges.append(badge(`⏱ ${formatDuration(ms)}`, 'Active reading time'));
    badges.append(badge(`↓ ${Math.round(rec.maxScrollPct || 0)}%`, 'Furthest scroll depth'));
  }
  if (rec.copies) badges.append(badge(`📋 ${rec.copies}`, 'Copied text'));
  if (rec.highlights) badges.append(badge(`🖍 ${rec.highlights}`, 'Highlighted text'));
  if (rec.views > 1) badges.append(badge(`${rec.views} visits`));

  $('#detail-insight').textContent = rec.ai?.text || templateSummary(rec, now, state.settings.thresholds);
  const anchorText = describeAnchor(rec.anchor);
  showSection('detail-anchor-section', 'detail-anchor',
    anchorText && rec.anchor?.snippet ? `${anchorText}: "${truncate(rec.anchor.snippet, 200)}"` : anchorText);
  showSection('detail-selection-section', 'detail-selection', rec.selectionSnippet);
  showSection('detail-note-section', 'detail-note', rec.note);
  $('#detail-jump').textContent = open ? 'Jump to tab' : 'Reopen';

  // Other visits to the same site, any day — the rest of the story for this tab.
  const site = siteOf(rec.url);
  const others = state.records
    .filter((r) => r.id !== rec.id && siteOf(r.url) === site)
    .sort((a, b) => (b.lastActiveAt || b.createdAt || 0) - (a.lastActiveAt || a.createdAt || 0));
  $('#detail-more-section').hidden = others.length === 0;
  $('#detail-more-title').textContent = `More from ${site} (${others.length})`;
  $('#detail-more').replaceChildren(...others.slice(0, 12).map((r) => {
    const b = el('button', { class: 'hs-more-item', type: 'button', dataset: { id: r.id }, title: r.url },
      el('span', { class: 'hs-row-title' }, r.title || r.url),
      el('span', { class: 'muted' }, formatAgo(r.lastActiveAt || r.createdAt, now)),
      el('span', { class: 'row-stat' }, statText(r, now)));
    b.addEventListener('click', () => { state.pinnedId = r.id; showDetail(r); });
    return b;
  }));
  if (others.length > 12) {
    const all = el('button', { class: 'hs-linklike', type: 'button' }, `Show all ${others.length + 1} in the list`);
    all.addEventListener('click', () => setQuery(site));
    $('#detail-more').append(all);
  }
}

async function openRecord(rec) {
  if (!rec) return;
  if (isOpen(rec)) {
    await chrome.tabs.update(rec.tabId, { active: true });
    await chrome.windows.update((await chrome.tabs.get(rec.tabId)).windowId, { focused: true });
  } else {
    await chrome.runtime.sendMessage({ type: 'ts:restore', ids: [rec.id], focus: true });
  }
}

// Narrow windows have no room for a side panel: it becomes a sheet, opened by click/Enter only.
const narrow = window.matchMedia('(max-width: 900px)');
function setSheet(open) {
  document.body.classList.toggle('hs-sheet-open', open && narrow.matches);
}

// --- Filters ----------------------------------------------------------------------------------

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ hideQuick: state.hideQuick })); } catch { /* optional */ }
}
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (typeof p.hideQuick === 'boolean') state.hideQuick = p.hideQuick;
  } catch { /* optional */ }
}

function setQuery(q) {
  state.query = q;
  $('#hs-query').value = q;
  render();
}
function setHideQuick(on) {
  state.hideQuick = on;
  $('#hs-hide-quick').checked = on;
  savePrefs();
  render();
}

let queryTimer = 0;
$('#hs-query').addEventListener('input', (e) => {
  clearTimeout(queryTimer);
  queryTimer = setTimeout(() => { state.query = e.target.value; render(); }, 120);
});
$('#hs-hide-quick').addEventListener('change', (e) => setHideQuick(e.target.checked));
document.querySelectorAll('.hs-chip').forEach((chip) => chip.addEventListener('click', () => {
  const b = chip.dataset.bucket;
  if (state.buckets.has(b)) state.buckets.delete(b); else state.buckets.add(b);
  chip.setAttribute('aria-pressed', String(state.buckets.has(b)));
  $('#hs-hide-quick').disabled = state.buckets.size > 0; // picking buckets shows exactly those
  render();
}));

// --- List interaction ---------------------------------------------------------------------------

const list = $('#days');
let hoverTimer = 0;

list.addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse' || state.pinnedId || narrow.matches) return;
  const row = e.target.closest('.hs-row');
  clearTimeout(hoverTimer);
  if (row && row.dataset.id !== state.selectedId) {
    hoverTimer = setTimeout(() => showDetail(byId(row.dataset.id)), HOVER_DELAY_MS);
  }
});

list.addEventListener('click', (e) => {
  const head = e.target.closest('.hs-group-head');
  if (head) {
    const key = head.dataset.group;
    const rows = head.nextElementSibling;
    const expand = rows.hidden;
    rows.hidden = !expand;
    head.setAttribute('aria-expanded', String(expand));
    if (expand) state.expanded.add(key); else state.expanded.delete(key);
    return;
  }
  const row = e.target.closest('.hs-row');
  if (!row) return;
  const rec = byId(row.dataset.id);
  if (e.detail >= 2) { openRecord(rec).catch(console.warn); return; } // double-click: go there
  state.pinnedId = rec.id;
  showDetail(rec);
  setSheet(true);
});

list.addEventListener('focusin', (e) => {
  const row = e.target.closest('.hs-row');
  if (row && e.target === row) showDetail(byId(row.dataset.id));
});

list.addEventListener('keydown', (e) => {
  const nav = e.target.closest('.hs-nav');
  if (!nav) return;
  const all = [...list.querySelectorAll('.hs-nav')].filter((n) => n.offsetParent !== null);
  const i = all.indexOf(nav);
  const move = (j) => { e.preventDefault(); all[Math.max(0, Math.min(all.length - 1, j))]?.focus(); };
  if (e.key === 'ArrowDown') move(i + 1);
  else if (e.key === 'ArrowUp') move(i - 1);
  else if (e.key === 'Home') move(0);
  else if (e.key === 'End') move(all.length - 1);
  else if (nav.classList.contains('hs-group-head') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    if ((e.key === 'ArrowRight') !== (nav.getAttribute('aria-expanded') === 'true')) nav.click();
    e.preventDefault();
  } else if (nav.classList.contains('hs-row') && e.key === 'Enter') {
    e.preventDefault();
    if (narrow.matches) { state.pinnedId = nav.dataset.id; setSheet(true); } else openRecord(byId(nav.dataset.id)).catch(console.warn);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.body.classList.contains('hs-sheet-open')) { setSheet(false); return; }
  if (state.pinnedId) { state.pinnedId = null; return; }
  if (document.activeElement === $('#hs-query') && state.query) setQuery('');
});

$('#detail-jump').addEventListener('click', () => openRecord(byId(state.selectedId)).catch(console.warn));
$('#hs-panel-close').addEventListener('click', () => { setSheet(false); state.pinnedId = null; });

// --- Start ---------------------------------------------------------------------------------------

loadPrefs();
$('#hs-hide-quick').checked = state.hideQuick;

(async function init() {
  await loadData();
  render();
})();
