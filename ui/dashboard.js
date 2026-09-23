import { classify, effectiveActiveMs } from '../lib/classifier.js';
import { BUCKETS, BUCKET_META, TIMING } from '../lib/config.js';
import { formatAgo, formatDuration, truncate } from '../lib/format.js';
import { RECORD_PREFIX } from '../lib/store.js';
import { summaryFingerprint, templateSummary, describeAnchor } from '../lib/template.js';
import { domainOf } from '../lib/url.js';
import { loadSettings } from '../lib/settings.js';
import {
  PROVIDERS, enableNano, nanoAvailability, summarize, summarizeSession, proposeGroups, getInsight,
} from '../ai/providers.js';

const $ = (sel) => document.querySelector(sel);
const PURGE_BUCKETS = new Set(['ghost', 'glanced']);
const AI_BUCKETS = new Set(['partial', 'deep']);
const CLOSED_LIMIT = 24;

const state = {
  records: [],
  tabs: new Map(),
  watchlist: [],
  settings: null,
  nano: 'unsupported',
  aiBusy: false,
  aiError: '',
  purgeIds: [],
  undoIds: [],
  recapFingerprint: '',
  recapBusy: false,
  pendingGroups: [],
};

// --- Data -------------------------------------------------------------------------

async function loadData() {
  const [stored, tabs] = await Promise.all([chrome.storage.local.get(null), chrome.tabs.query({})]);
  state.records = Object.entries(stored)
    .filter(([key]) => key.startsWith(RECORD_PREFIX))
    .map(([, rec]) => rec);
  state.watchlist = Array.isArray(stored.watchlist) ? stored.watchlist : [];
  state.tabs = new Map(tabs.map((t) => [t.id, t]));
}

function isOpen(rec) {
  return !rec.closed && rec.tabId != null && state.tabs.has(rec.tabId);
}

function thresholds() {
  return state.settings?.thresholds;
}

function aiFingerprint(rec, now) {
  return `${summaryFingerprint(rec, now, thresholds())}|${state.settings?.provider}`;
}

/** An AI summary is only shown while it still describes the current state of the tab. */
function summaryFor(rec, now) {
  if (rec.ai && rec.ai.source !== 'template' && rec.ai.fingerprint === aiFingerprint(rec, now)) {
    return { text: rec.ai.text, source: rec.ai.source };
  }
  return { text: templateSummary(rec, now, thresholds()), source: 'template' };
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload }).then((res) => {
    if (!res?.ok) throw new Error(res?.error || 'No response from background');
    return res.result;
  });
}

/** True if any tracked record for this domain shows activity since local midnight. */
function isCheckedToday(domain, now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return state.records.some((r) => domainOf(r.url) === domain && (r.lastActiveAt || 0) >= start.getTime());
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
  const bucket = classify(rec, now, thresholds());
  node.dataset.id = rec.id;
  if (rec.activeSince != null) node.classList.add('active-now');

  const favicon = node.querySelector('.favicon');
  favicon.src = faviconUrl(rec.url);
  favicon.title = 'View details';
  favicon.addEventListener('click', () => openDetail(rec, { closed }));
  const title = node.querySelector('.title');
  title.textContent = rec.title || rec.url;
  title.title = rec.url;

  const when = closed
    ? `closed ${formatAgo(rec.closedAt, now)}`
    : rec.lastActiveAt ? `active ${formatAgo(rec.lastActiveAt, now)}` : `opened ${formatAgo(rec.createdAt, now)}`;
  const meta = node.querySelector('.meta');
  meta.textContent = `${domainOf(rec.url)} · ${when}`;
  meta.title = 'View details';
  meta.addEventListener('click', () => openDetail(rec, { closed }));

  const badges = node.querySelector('.badges');
  if (bucket === 'ghost') badges.append(badge('never opened'));
  else {
    badges.append(badge(`⏱ ${formatDuration(ms)}`, 'Active reading time'));
    badges.append(badge(`↓ ${Math.round(rec.maxScrollPct || 0)}%`, 'Furthest scroll depth'));
  }
  if (rec.copies) badges.append(badge(`📋 ${rec.copies}`, 'Copied text'));
  if (rec.highlights) badges.append(badge(`🖍 ${rec.highlights}`, 'Highlighted text'));
  if (rec.views > 1) badges.append(badge(`${rec.views} visits`));
  if (rec.note) badges.append(badge('📌 follow up', 'Purge always skips this tab'));

  const summary = summaryFor(rec, now);
  node.querySelector('.summary-text').textContent = summary.text;
  const source = node.querySelector('.source');
  source.textContent = sourceLabel(summary.source);
  if (summary.source === 'template') source.classList.add('basic');

  // --- note editor ---
  const noteDisplay = node.querySelector('.note-display');
  const noteLabel = node.querySelector('.note-label');
  const noteInput = node.querySelector('.note-input');
  const noteToggle = node.querySelector('.note-toggle');
  noteInput.value = rec.note || '';
  noteToggle.textContent = rec.note ? 'Edit note' : '+ Note';
  if (rec.note) {
    noteDisplay.textContent = `📌 ${rec.note}`;
    noteDisplay.hidden = false;
  }
  noteToggle.addEventListener('click', () => {
    const opening = noteLabel.hidden;
    noteLabel.hidden = !opening;
    noteDisplay.hidden = opening || !rec.note;
    if (opening) noteInput.focus();
  });
  noteInput.addEventListener('blur', () => {
    const value = noteInput.value.trim();
    if (value !== (rec.note || '')) send('ts:setNote', { id: rec.id, note: value }).catch(showError);
  });

  const jump = node.querySelector('.jump');
  const close = node.querySelector('.close');
  const watchBtn = node.querySelector('.watch-toggle');
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

    const domain = domainOf(rec.url);
    const watched = state.watchlist.some((w) => w.domain === domain);
    watchBtn.hidden = false;
    watchBtn.textContent = watched ? '✓ Watching daily' : '👁 Watch daily';
    watchBtn.addEventListener('click', () => {
      const type = watched ? 'ts:watchRemove' : 'ts:watchAdd';
      send(type, { domain, label: rec.title || domain }).catch(showError);
    });
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
  for (const rec of open) groups[classify(rec, now, thresholds())].push(rec);

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
    .filter((r) => r.closed && r.closedReason !== 'purged' && !r.note && AI_BUCKETS.has(classify(r, now, thresholds())))
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
    .slice(0, CLOSED_LIMIT);
  $('#closed').hidden = closed.length === 0;
  $('#closed-list').replaceChildren(...closed.map((rec) => buildCard(rec, now, { closed: true })));

  const noted = state.records.filter((r) => r.note).sort((a, b) => sortKey(b) - sortKey(a));
  $('#followup').hidden = noted.length === 0;
  $('#followup-list').replaceChildren(...noted.map((rec) => buildCard(rec, now, { closed: rec.closed })));

  renderChecklist(now);

  // Never purge a noted ("don't lose this"), pinned, or currently-active tab.
  state.purgeIds = open
    .filter((r) => PURGE_BUCKETS.has(classify(r, now, thresholds())) && r.activeSince == null &&
      !r.note && !state.tabs.get(r.tabId)?.pinned)
    .map((r) => r.id);
  const purge = $('#purge');
  purge.disabled = state.purgeIds.length === 0;
  purge.textContent = `Purge Ghost & Glanced (${state.purgeIds.length})`;

  const deep = groups.deep.length;
  $('#stats').textContent = open.length
    ? `${open.length} tracked tab${open.length === 1 ? '' : 's'} · ${deep} in deep focus · ${state.purgeIds.length} safe to close`
    : 'No tracked tabs yet. Browse normally and come back.';

  $('#group-tabs').hidden = !state.settings?.grouping?.enabled;
  renderAiStatus();
}

function renderChecklist(now) {
  const box = $('#checklist');
  if (!state.watchlist.length) { box.hidden = true; return; }
  box.hidden = false;
  $('#checklist-list').replaceChildren(...state.watchlist.map((w) => {
    const checked = isCheckedToday(w.domain, now);
    const el = document.createElement('span');
    el.className = `pill${checked ? ' on' : ''}`;
    el.textContent = `${checked ? '✓' : '○'} ${w.label}`;
    el.title = checked ? 'Checked today' : 'Not checked yet today';
    return el;
  }));
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

// --- Card detail view: everything tracked about one tab, plus an on-demand deeper AI insight ---
// "Preview" here is a large favicon + title + domain + URL, not a literal screenshot of the page:
// a real page capture could show inbox contents, private dashboards, anything on screen, which
// conflicts with never capturing page content — the whole point of how this extension works.

let detailRec = null;
let detailClosed = false;

function showSection(sectionId, textId, text) {
  const has = !!text;
  $(`#${sectionId}`).hidden = !has;
  if (has) $(`#${textId}`).textContent = text;
}

function openDetail(rec, { closed }) {
  detailRec = rec;
  detailClosed = closed;
  const now = Date.now();

  $('#detail-favicon').src = faviconUrl(rec.url);
  $('#detail-title').textContent = rec.title || rec.url;
  const bucket = classify(rec, now, thresholds());
  const when = closed
    ? `closed ${formatAgo(rec.closedAt, now)}`
    : rec.lastActiveAt ? `active ${formatAgo(rec.lastActiveAt, now)}` : `opened ${formatAgo(rec.createdAt, now)}`;
  $('#detail-meta').textContent = `${domainOf(rec.url)} · ${BUCKET_META[bucket]?.label || bucket} · ${when}`;
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

  $('#detail-insight').textContent = summaryFor(rec, now).text;
  $('#detail-insight-btn').disabled = false;
  $('#detail-insight-btn').textContent = 'Get a deeper AI insight';

  const anchorText = describeAnchor(rec.anchor);
  showSection('detail-anchor-section', 'detail-anchor',
    anchorText && rec.anchor?.snippet ? `${anchorText}: “${truncate(rec.anchor.snippet, 200)}”` : anchorText);
  showSection('detail-selection-section', 'detail-selection', rec.selectionSnippet);
  showSection('detail-note-section', 'detail-note', rec.note);

  const jumpBtn = $('#detail-jump');
  jumpBtn.textContent = closed ? 'Reopen' : 'Jump to tab';
  const closeBtn = $('#detail-close-tab');
  closeBtn.textContent = closed ? 'Dismiss' : 'Close';

  $('#detail-backdrop').hidden = false;
  $('#detail-modal').hidden = false;
}

function closeDetail() {
  $('#detail-backdrop').hidden = true;
  $('#detail-modal').hidden = true;
  detailRec = null;
}

$('#detail-backdrop').addEventListener('click', closeDetail);
$('#detail-close').addEventListener('click', closeDetail);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && detailRec) closeDetail(); });

$('#detail-jump').addEventListener('click', async () => {
  if (!detailRec) return;
  if (detailClosed) await send('ts:restore', { ids: [detailRec.id], focus: true }).catch(showError);
  else await jumpTo(detailRec);
  closeDetail();
});

$('#detail-close-tab').addEventListener('click', async () => {
  if (!detailRec) return;
  if (detailClosed) await send('ts:dismiss', { ids: [detailRec.id] }).catch(showError);
  else await chrome.tabs.remove(detailRec.tabId).catch(showError);
  closeDetail();
});

$('#detail-insight-btn').addEventListener('click', async () => {
  if (!detailRec) return;
  const btn = $('#detail-insight-btn');
  btn.disabled = true;
  btn.textContent = 'Thinking…';
  try {
    const { text, source, errors } = await getInsight(detailRec, state.settings);
    $('#detail-insight').textContent = text;
    if (source === 'template' && errors.length) showToast(errors[0]);
  } catch (err) {
    showError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Get a deeper AI insight';
  }
});

$('#purge').addEventListener('click', () => {
  const n = state.purgeIds.length;
  $('#purge-confirm-text').textContent =
    `Close ${n} ghost and glanced tab${n === 1 ? '' : 's'}? Pinned and noted tabs are kept. You can undo for ${TIMING.undoWindowMs / 1000}s.`;
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
  refreshRecap();
});

// --- AI-assisted tab grouping (only shown when enabled in Settings) --------------------------

$('#group-tabs').addEventListener('click', async () => {
  const btn = $('#group-tabs');
  const candidates = state.records.filter(isOpen);
  if (candidates.length < 2) { showToast('Need at least 2 open tabs to find groups.'); return; }
  btn.disabled = true;
  btn.textContent = 'Thinking…';
  try {
    const { groups, errors } = await proposeGroups(candidates, state.settings);
    if (!groups.length) {
      showToast(errors[0] || 'No clear groups found among your open tabs.');
      return;
    }
    state.pendingGroups = groups;
    $('#group-confirm-body').replaceChildren(...groups.map((g) => {
      const p = document.createElement('p');
      const strong = document.createElement('strong');
      strong.textContent = g.name;
      const names = g.tabIds.map((id) => candidates.find((r) => r.id === id)?.title || id).join(', ');
      p.append(strong, document.createTextNode(`: ${names}`));
      return p;
    }));
    $('#group-confirm').hidden = false;
  } catch (err) {
    showError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Group related tabs';
  }
});

$('#group-cancel').addEventListener('click', () => {
  $('#group-confirm').hidden = true;
  state.pendingGroups = [];
});

$('#group-go').addEventListener('click', async () => {
  $('#group-confirm').hidden = true;
  const groups = state.pendingGroups;
  state.pendingGroups = [];
  let applied = 0;
  for (const g of groups) {
    const tabIds = g.tabIds
      .map((id) => state.records.find((r) => r.id === id)?.tabId)
      .filter((id) => id != null && state.tabs.has(id));
    if (tabIds.length < 2) continue;
    try {
      const groupId = await chrome.tabs.group({ tabIds });
      await chrome.tabGroups.update(groupId, { title: g.name });
      applied += 1;
    } catch (err) {
      showError(err);
    }
  }
  if (applied) showToast(`Grouped into ${applied} group${applied === 1 ? '' : 's'}.`);
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
        AI_BUCKETS.has(classify(r, now, thresholds())) && r.activeSince == null &&
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

// --- Session recap (one line, regenerated only when the tracked set materially changes) -----

async function refreshRecap() {
  const now = Date.now();
  const open = state.records.filter(isOpen);
  if (!open.length) { $('#recap').hidden = true; return; }
  const fp = `${open.map((r) => summaryFingerprint(r, now, thresholds())).sort().join(',')}|${state.settings?.provider}`;
  if (fp === state.recapFingerprint) { $('#recap').hidden = false; return; }
  if (state.recapBusy) return;
  state.recapBusy = true;
  try {
    const { text } = await summarizeSession(open, state.settings);
    state.recapFingerprint = fp;
    $('#recap').textContent = text;
    $('#recap').hidden = false;
  } catch {
    // Leave whatever recap was showing; not worth surfacing as an error toast.
  } finally {
    state.recapBusy = false;
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
  refreshRecap();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) {
    loadSettings().then((s) => { state.settings = s; state.aiError = ''; scheduleRefresh(); });
    return;
  }
  if (changes.watchlist || Object.keys(changes).some((k) => k.startsWith(RECORD_PREFIX))) scheduleRefresh();
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
