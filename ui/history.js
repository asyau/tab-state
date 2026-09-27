// Every tab ever tracked, grouped by the day you were last actually looking at it — kept forever
// (see lib/tracker.js's prune()). Deliberately a separate, simpler page from dashboard.js: no
// live re-rendering on a heartbeat, no note editing, no purge/watch — just browsing your own
// history. Shares card-tpl/#detail-modal markup and CSS classes with dashboard.js (so a history
// row gets the same compact/hover-to-expand treatment for free) but keeps its own small
// self-contained render/detail logic rather than importing dashboard.js's, since that file's
// buildCard()/openDetail() are tightly closed over dashboard-only state (live re-render, purge
// selection, watchlist). Worth revisiting into a shared module if this page grows much further.

import { classify, effectiveActiveMs } from '../lib/classifier.js';
import { formatAgo, formatDuration, truncate } from '../lib/format.js';
import { RECORD_PREFIX } from '../lib/store.js';
import { templateSummary, describeAnchor } from '../lib/template.js';
import { domainOf } from '../lib/url.js';
import { loadSettings } from '../lib/settings.js';
import { initCardPeek, focusInCard } from './card-peek.js';

const $ = (sel) => document.querySelector(sel);
let settings = null;
let tabsById = new Map();

async function loadData() {
  const [stored, tabs, s] = await Promise.all([
    chrome.storage.local.get(null),
    chrome.tabs.query({}),
    loadSettings(),
  ]);
  settings = s;
  tabsById = new Map(tabs.map((t) => [t.id, t]));
  return Object.entries(stored)
    .filter(([key]) => key.startsWith(RECORD_PREFIX))
    .map(([, rec]) => rec);
}

function isOpen(rec) {
  return !rec.closed && rec.tabId != null && tabsById.has(rec.tabId);
}

function faviconUrl(pageUrl) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', '32');
  return u.toString();
}

function badge(text, title) {
  const el = document.createElement('span');
  el.className = 'badge';
  el.textContent = text;
  if (title) el.title = title;
  return el;
}

/** The day a tab counts under: when you were last actually engaged with it, not when it opened —
 * a tab opened Monday and read today shows under today, which is where you'd look for it. */
function dayKeyOf(rec) {
  const t = rec.lastActiveAt || rec.createdAt || 0;
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayLabel(dayKey, now) {
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

function groupByDay(records, now) {
  const groups = new Map();
  for (const rec of records) {
    const key = dayKeyOf(rec);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([key, list]) => ({
      key,
      label: dayLabel(key, now),
      records: list.sort((a, b) => (b.lastActiveAt || b.createdAt || 0) - (a.lastActiveAt || a.createdAt || 0)),
    }));
}

function buildCard(rec, now) {
  const node = $('#card-tpl').content.firstElementChild.cloneNode(true);
  const ms = effectiveActiveMs(rec, now);
  const bucket = classify(rec, now, settings.thresholds);
  const open = isOpen(rec);
  node.dataset.id = rec.id;

  const favicon = node.querySelector('.favicon');
  favicon.src = faviconUrl(rec.url);
  favicon.title = 'View details';
  const openIt = () => openDetail(rec);
  favicon.addEventListener('click', openIt);

  const title = node.querySelector('.title');
  title.textContent = rec.title || rec.url;
  title.title = rec.url;
  title.addEventListener('click', openIt);

  const when = open
    ? (rec.lastActiveAt ? `active ${formatAgo(rec.lastActiveAt, now)}` : `opened ${formatAgo(rec.createdAt, now)}`)
    : `closed ${formatAgo(rec.closedAt || rec.lastActiveAt, now)}`;
  const meta = node.querySelector('.meta');
  meta.textContent = `${domainOf(rec.url)} · ${when}`;
  meta.setAttribute('role', 'button');
  meta.setAttribute('aria-haspopup', 'dialog');
  meta.setAttribute('aria-label', `${meta.textContent}, view details`);
  meta.tabIndex = 0;
  meta.addEventListener('click', openIt);
  meta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openIt(); }
  });

  const badges = node.querySelector('.badges');
  if (bucket === 'ghost') badges.append(badge('never opened'));
  else {
    badges.append(badge(`⏱ ${formatDuration(ms)}`, 'Active reading time'));
    badges.append(badge(`↓ ${Math.round(rec.maxScrollPct || 0)}%`, 'Furthest scroll depth'));
  }
  if (rec.copies) badges.append(badge(`📋 ${rec.copies}`, 'Copied text'));
  if (rec.highlights) badges.append(badge(`🖍 ${rec.highlights}`, 'Highlighted text'));
  if (rec.note) badges.append(badge('📌 note'));

  const stat = node.querySelector('.row-stat');
  if (bucket === 'ghost') stat.textContent = 'unread';
  else { stat.textContent = formatDuration(ms); stat.title = 'Active reading time'; }
  node.querySelector('.row-pin').hidden = !rec.note;

  node.querySelector('.summary-text').textContent = templateSummary(rec, now, settings.thresholds);
  const noteDisplay = node.querySelector('.note-display');
  if (rec.note) { noteDisplay.textContent = `📌 ${rec.note}`; noteDisplay.hidden = false; }

  const jump = node.querySelector('.jump');
  if (open) {
    jump.querySelector('.lbl').textContent = 'Jump to tab';
    jump.addEventListener('click', () => jumpTo(rec));
  } else {
    jump.querySelector('.lbl').textContent = 'Reopen';
    jump.addEventListener('click', () => reopen(rec));
  }
  return node;
}

async function jumpTo(rec) {
  await chrome.tabs.update(rec.tabId, { active: true });
  await chrome.windows.update((await chrome.tabs.get(rec.tabId)).windowId, { focused: true });
}

async function reopen(rec) {
  await chrome.runtime.sendMessage({ type: 'ts:restore', ids: [rec.id], focus: true });
}

// --- Detail modal (a trimmed copy of dashboard.js's — see file header) -----------------------

let detailRec = null;
const BACKGROUND_SELECTOR = '.topbar, #days';
function setBackgroundInert(on) {
  document.querySelectorAll(BACKGROUND_SELECTOR).forEach((el) => { el.inert = on; });
}

function showSection(sectionId, textId, text) {
  const has = !!text;
  $(`#${sectionId}`).hidden = !has;
  if (has) $(`#${textId}`).textContent = text;
}

function openDetail(rec) {
  detailRec = rec;
  const now = Date.now();
  const open = isOpen(rec);

  $('#detail-favicon').src = faviconUrl(rec.url);
  $('#detail-title').textContent = rec.title || rec.url;
  const bucket = classify(rec, now, settings.thresholds);
  const when = open
    ? (rec.lastActiveAt ? `active ${formatAgo(rec.lastActiveAt, now)}` : `opened ${formatAgo(rec.createdAt, now)}`)
    : `closed ${formatAgo(rec.closedAt || rec.lastActiveAt, now)}`;
  $('#detail-meta').textContent = `${domainOf(rec.url)} · ${bucket} · ${when}`;
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

  $('#detail-insight').textContent = templateSummary(rec, now, settings.thresholds);

  const anchorText = describeAnchor(rec.anchor);
  showSection('detail-anchor-section', 'detail-anchor',
    anchorText && rec.anchor?.snippet ? `${anchorText}: "${truncate(rec.anchor.snippet, 200)}"` : anchorText);
  showSection('detail-selection-section', 'detail-selection', rec.selectionSnippet);
  showSection('detail-note-section', 'detail-note', rec.note);

  $('#detail-jump').textContent = open ? 'Jump to tab' : 'Reopen';
  $('#detail-backdrop').hidden = false;
  $('#detail-modal').hidden = false;
  setBackgroundInert(true);
  $('#detail-close').focus();
}

function closeDetail() {
  const id = detailRec?.id;
  $('#detail-backdrop').hidden = true;
  $('#detail-modal').hidden = true;
  detailRec = null;
  setBackgroundInert(false);
  if (id) focusInCard(document.querySelector(`.card[data-id="${id}"] .meta`));
}

$('#detail-backdrop').addEventListener('click', closeDetail);
$('#detail-close').addEventListener('click', closeDetail);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && detailRec) closeDetail(); });
$('#detail-jump').addEventListener('click', async () => {
  if (!detailRec) return;
  if (isOpen(detailRec)) await jumpTo(detailRec); else await reopen(detailRec);
  closeDetail();
});

// --- Render --------------------------------------------------------------------------------

function render(records) {
  const now = Date.now();
  const days = groupByDay(records, now);
  $('#empty').hidden = days.length > 0;
  $('#stats').textContent = days.length
    ? `${records.length} tabs tracked across ${days.length} day${days.length === 1 ? '' : 's'}`
    : '';

  $('#days').replaceChildren(...days.map(({ key, label, records: dayRecords }) => {
    const section = document.createElement('section');
    section.className = 'col history-day';
    section.dataset.day = key;
    const h2 = document.createElement('h2');
    h2.innerHTML = `${label} <span class="count">${dayRecords.length}</span>`;
    const list = document.createElement('div');
    list.className = 'cards';
    list.append(...dayRecords.map((rec) => buildCard(rec, now)));
    section.append(h2, list);
    return section;
  }));
}

initCardPeek();

(async function init() {
  const records = await loadData();
  render(records);
})();
