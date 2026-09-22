import { classify, effectiveActiveMs } from '../lib/classifier.js';
import { BUCKETS, TIMING } from '../lib/config.js';
import { formatAgo, formatDuration } from '../lib/format.js';
import { RECORD_PREFIX } from '../lib/store.js';
import { summaryFingerprint, templateSummary } from '../lib/template.js';
import { domainOf } from '../lib/url.js';
import { loadSettings } from '../ai/settings.js';
import { PROVIDERS, enableNano, nanoAvailability, summarize } from '../ai/providers.js';

const $ = (sel) => document.querySelector(sel);
const PURGE_BUCKETS = new Set(['ghost', 'glanced']);
const AI_BUCKETS = new Set(['partial', 'deep']);
const CLOSED_LIMIT = 24;

const state = {
  records: [],
  tabs: new Map(),
  settings: null,
  nano: 'unsupported',
  aiBusy: false,
  aiError: '',
  purgeIds: [],
  undoIds: [],
  undoTimer: null,
};

// --- Data -------------------------------------------------------------------------

async function loadData() {
  const [stored, tabs] = await Promise.all([chrome.storage.local.get(null), chrome.tabs.query({})]);
  state.records = Object.entries(stored)
    .filter(([key]) => key.startsWith(RECORD_PREFIX))
    .map(([, rec]) => rec);
  state.tabs = new Map(tabs.map((t) => [t.id, t]));
}

function isOpen(rec) {
  return !rec.closed && rec.tabId != null && state.tabs.has(rec.tabId);
}

function aiFingerprint(rec, now) {
  return `${summaryFingerprint(rec, now)}|${state.settings?.provider}`;
}

/** An AI summary is only shown while it still describes the current state of the tab. */
function summaryFor(rec, now) {
  if (rec.ai && rec.ai.source !== 'template' && rec.ai.fingerprint === aiFingerprint(rec, now)) {
    return { text: rec.ai.text, source: rec.ai.source };
  }
  return { text: templateSummary(rec, now), source: 'template' };
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload }).then((res) => {
    if (!res?.ok) throw new Error(res?.error || 'No response from background');
    return res.result;
  });
}

// --- Rendering -----------------------------------------------------------------------

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

function sourceLabel(source) {
  if (source === 'template') return 'basic';
  if (source === 'nano') return 'AI · on-device';
  if (source === 'openai') return 'AI · API';
  if (source === 'anthropic') return 'AI · Claude';
  return `AI · ${source}`;
}

function buildCard(rec, now, { closed = false } = {}) {
  const node = $('#card-tpl').content.firstElementChild.cloneNode(true);
  const ms = effectiveActiveMs(rec, now);
  const bucket = classify(rec, now);
  node.dataset.id = rec.id;
  if (rec.activeSince != null) node.classList.add('active-now');

  node.querySelector('.favicon').src = faviconUrl(rec.url);
  const title = node.querySelector('.title');
  title.textContent = rec.title || rec.url;
  title.title = rec.url;

  const when = closed
    ? `closed ${formatAgo(rec.closedAt, now)}`
    : rec.lastActiveAt ? `active ${formatAgo(rec.lastActiveAt, now)}` : `opened ${formatAgo(rec.createdAt, now)}`;
  node.querySelector('.meta').textContent = `${domainOf(rec.url)} · ${when}`;

  const badges = node.querySelector('.badges');
  if (bucket === 'ghost') badges.append(badge('never opened'));
  else {
    badges.append(badge(`⏱ ${formatDuration(ms)}`, 'Active reading time'));
    badges.append(badge(`↓ ${Math.round(rec.maxScrollPct || 0)}%`, 'Furthest scroll depth'));
  }
  if (rec.copies) badges.append(badge(`📋 ${rec.copies}`, 'Copied text'));
  if (rec.highlights) badges.append(badge(`🖍 ${rec.highlights}`, 'Highlighted text'));
  if (rec.views > 1) badges.append(badge(`${rec.views} visits`));

  const summary = summaryFor(rec, now);
  node.querySelector('.summary-text').textContent = summary.text;
  const source = node.querySelector('.source');
  source.textContent = sourceLabel(summary.source);
  if (summary.source === 'template') source.classList.add('basic');

  const jump = node.querySelector('.jump');
  const close = node.querySelector('.close');
  if (closed) {
    jump.textContent = 'Reopen';
    jump.addEventListener('click', () => send('ts:restore', { ids: [rec.id], focus: true }).catch(showError));
    title.addEventListener('click', () => send('ts:restore', { ids: [rec.id], focus: true }).catch(showError));
    close.textContent = 'Dismiss';
    close.addEventListener('click', () => send('ts:dismiss', { ids: [rec.id] }).catch(showError));
  } else {
    const goTo = () => jumpTo(rec);
    jump.addEventListener('click', goTo);
    title.addEventListener('click', goTo);
    close.addEventListener('click', () => chrome.tabs.remove(rec.tabId).catch(showError));
  }
  return node;
}

function sortKey(rec) {
  return rec.lastActiveAt || rec.createdAt || 0;
}

function render() {
  const now = Date.now();
  const open = state.records.filter(isOpen);
  const groups = Object.fromEntries(BUCKETS.map((b) => [b, []]));
  for (const rec of open) groups[classify(rec, now)].push(rec);

  for (const bucket of BUCKETS) {
    const col = document.querySelector(`.col[data-bucket="${bucket}"]`);
    const list = groups[bucket].sort((a, b) => sortKey(b) - sortKey(a));
    col.querySelector('.count').textContent = String(list.length);
    const cards = col.querySelector('.cards');
    cards.replaceChildren(...list.map((rec) => buildCard(rec, now)));
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Nothing here';
      cards.append(empty);
    }
  }

  const closed = state.records
    .filter((r) => r.closed && r.closedReason !== 'purged' && AI_BUCKETS.has(classify(r, now)))
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
    .slice(0, CLOSED_LIMIT);
  $('#closed').hidden = closed.length === 0;
  $('#closed-list').replaceChildren(...closed.map((rec) => buildCard(rec, now, { closed: true })));

  // Never purge pinned tabs or the tab being read right now.
  state.purgeIds = open
    .filter((r) => PURGE_BUCKETS.has(classify(r, now)) && r.activeSince == null && !state.tabs.get(r.tabId)?.pinned)
    .map((r) => r.id);
  const purge = $('#purge');
  purge.disabled = state.purgeIds.length === 0;
  purge.textContent = `Purge Ghost & Glanced (${state.purgeIds.length})`;

  const deep = groups.deep.length;
  $('#stats').textContent = open.length
    ? `${open.length} tracked tab${open.length === 1 ? '' : 's'} · ${deep} in deep focus · ${state.purgeIds.length} safe to close`
    : 'No tracked tabs yet. Browse normally and come back.';

  renderAiStatus();
}

function renderAiStatus() {
  const pill = $('#ai-status');
  const btn = $('#enable-nano');
  const provider = state.settings?.provider || 'auto';
  pill.className = 'pill';
  pill.title = state.aiError;
  btn.hidden = true;

  if (provider === 'template') {
    pill.textContent = 'Summaries: basic';
  } else if (provider === 'auto' || provider === 'nano') {
    if (state.nano === 'available') {
      pill.textContent = 'AI: on-device';
      pill.classList.add('on');
    } else if (state.nano === 'downloadable' || state.nano === 'downloading') {
      pill.textContent = state.nano === 'downloading' ? 'Downloading on-device model…' : 'Summaries: basic';
      btn.hidden = state.nano === 'downloading';
    } else {
      pill.textContent = 'Summaries: basic (no on-device AI here)';
      pill.title = 'Chrome\'s built-in model isn\'t available on this device. Add an API in Settings for AI summaries.';
    }
  } else {
    pill.textContent = `AI: ${provider === 'anthropic' ? 'Claude API' : 'your API'}`;
    pill.classList.add('on');
  }
  if (state.aiError) {
    pill.classList.remove('on');
    pill.classList.add('warn');
    pill.textContent += ' · error';
  }
}

// --- Actions ------------------------------------------------------------------------

async function jumpTo(rec) {
  try {
    const tab = await chrome.tabs.update(rec.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (err) {
    showError(err);
  }
}

let toastTimer = null;
function showToast(text, { undo = false, ms = 4000 } = {}) {
  clearTimeout(toastTimer);
  $('#toast-text').textContent = text;
  $('#toast-undo').hidden = !undo;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, ms);
}

function showError(err) {
  console.warn('[tab-state]', err);
  showToast(`Something went wrong: ${err?.message || err}`);
}

$('#purge').addEventListener('click', () => {
  const n = state.purgeIds.length;
  $('#purge-confirm-text').textContent =
    `Close ${n} ghost and glanced tab${n === 1 ? '' : 's'}? Pinned tabs are kept. You can undo for ${TIMING.undoWindowMs / 1000}s.`;
  $('#purge-confirm').hidden = false;
});

$('#purge-cancel').addEventListener('click', () => { $('#purge-confirm').hidden = true; });

$('#purge-go').addEventListener('click', async () => {
  $('#purge-confirm').hidden = true;
  const ids = [...state.purgeIds];
  try {
    const { closed } = await send('ts:purge', { ids });
    state.undoIds = ids;
    showToast(`Closed ${closed} tab${closed === 1 ? '' : 's'}.`, { undo: true, ms: TIMING.undoWindowMs });
  } catch (err) {
    showError(err);
  }
});

$('#toast-undo').addEventListener('click', async () => {
  const ids = state.undoIds;
  state.undoIds = [];
  $('#toast').hidden = true;
  try {
    const { opened } = await send('ts:restore', { ids });
    showToast(`Reopened ${opened} tab${opened === 1 ? '' : 's'}.`);
  } catch (err) {
    showError(err);
  }
});

$('#enable-nano').addEventListener('click', async () => {
  const btn = $('#enable-nano');
  btn.disabled = true;
  try {
    state.nano = await enableNano((p) => { btn.textContent = `Downloading ${Math.round(p * 100)}%`; });
    state.aiError = '';
  } catch (err) {
    state.aiError = String(err?.message || err);
  }
  btn.disabled = false;
  btn.textContent = 'Enable on-device AI';
  render();
  runAiQueue();
});

// --- AI summaries (one at a time, only for tabs that matter) --------------------------------

function aiEnabled() {
  const provider = state.settings?.provider || 'auto';
  if (provider === 'template') return false;
  if (provider === 'auto') return state.nano === 'available';
  return !!PROVIDERS[provider]?.run;
}

async function runAiQueue() {
  if (state.aiBusy || !aiEnabled()) return;
  state.aiBusy = true;
  try {
    for (;;) {
      const now = Date.now();
      const next = state.records.find((r) =>
        (isOpen(r) || r.closed) && r.closedReason !== 'purged' &&
        AI_BUCKETS.has(classify(r, now)) && r.activeSince == null &&
        r.ai?.fingerprint !== aiFingerprint(r, now));
      if (!next) break;
      const fingerprint = aiFingerprint(next, now);
      const result = await summarize(next, state.settings);
      state.aiError = result.source === 'template' ? result.errors.join('\n') : '';
      // Cache even a fallback, so a broken provider isn't retried in a loop for this state.
      next.ai = { text: result.text, source: result.source, fingerprint };
      await send('ts:setAiSummary', { id: next.id, ...next.ai });
      if (state.aiError) break;
    }
  } catch (err) {
    state.aiError = String(err?.message || err);
  } finally {
    state.aiBusy = false;
    renderAiStatus();
  }
}

// --- Live updates -----------------------------------------------------------------------

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 250);
}

async function refresh() {
  await loadData();
  render();
  runAiQueue();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) {
    loadSettings().then((s) => { state.settings = s; state.aiError = ''; scheduleRefresh(); });
    return;
  }
  if (Object.keys(changes).some((k) => k.startsWith(RECORD_PREFIX))) scheduleRefresh();
});
chrome.tabs.onRemoved.addListener(scheduleRefresh);
chrome.tabs.onCreated.addListener(scheduleRefresh);
chrome.tabs.onUpdated.addListener((id, info) => { if (info.pinned !== undefined) scheduleRefresh(); });
setInterval(render, 30_000); // keep "5m ago" labels fresh
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') send('ts:refresh').catch(() => {}).finally(refresh);
});

(async function init() {
  state.settings = await loadSettings();
  state.nano = await nanoAvailability();
  // Make sure the background has closed the segment of the tab we came from.
  await send('ts:refresh').catch(() => {});
  await refresh();
})();
