// Service worker: wires Chrome events to the tracker. All listeners are registered
// synchronously at top level so Chrome can wake the worker for them.

import { TIMING } from './lib/config.js';
import * as tracker from './lib/tracker.js';
import { isTrackable } from './lib/url.js';

const DASHBOARD_URL = chrome.runtime.getURL('ui/dashboard.html');
const TICK_ALARM = 'tick';

function logError(err) {
  console.warn('[tab-state]', err);
}

// --- Focus / lifecycle ------------------------------------------------------

chrome.tabs.onActivated.addListener(() => tracker.onFocusMaybeChanged().catch(logError));
chrome.windows.onFocusChanged.addListener(() => tracker.onFocusMaybeChanged().catch(logError));
chrome.idle.onStateChanged.addListener(() => tracker.onFocusMaybeChanged().catch(logError));
chrome.tabs.onCreated.addListener((tab) => tracker.onTabCreated(tab).catch(logError));
chrome.tabs.onUpdated.addListener((id, info, tab) => tracker.onTabUpdated(id, info, tab).catch(logError));
chrome.tabs.onRemoved.addListener((id) => tracker.onTabRemoved(id).catch(logError));
chrome.tabs.onReplaced.addListener((added, removed) => tracker.onTabReplaced(added, removed).catch(logError));

chrome.idle.setDetectionInterval(TIMING.idleSeconds);

// --- Heartbeat --------------------------------------------------------------

async function ensureAlarm() {
  const existing = await chrome.alarms.get(TICK_ALARM);
  if (!existing) chrome.alarms.create(TICK_ALARM, { periodInMinutes: TIMING.tickMinutes });
}
ensureAlarm().catch(logError);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) tracker.onTick().catch(logError);
});

// --- Install / startup ------------------------------------------------------

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter((t) => isTrackable(t.url) && !t.discarded).map((t) =>
    chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }).catch(() => {})));
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  try {
    await ensureAlarm();
    await tracker.adoptExistingTabs();
    await injectIntoOpenTabs();
    if (reason === 'install') await chrome.tabs.create({ url: DASHBOARD_URL });
  } catch (err) {
    logError(err);
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm().catch(logError);
  tracker.onFocusMaybeChanged().catch(logError);
});

// --- Toolbar button: open (or focus) the dashboard ----------------------------

async function openDashboard() {
  const [existing] = await chrome.tabs.query({ url: DASHBOARD_URL });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: DASHBOARD_URL });
  }
}

chrome.action.onClicked.addListener(() => openDashboard().catch(logError));

// --- Messages ---------------------------------------------------------------

const DASHBOARD_ACTIONS = {
  'ts:purge': (msg) => tracker.purge(msg.ids || []),
  'ts:restore': (msg) => tracker.restore(msg.ids || [], { focus: !!msg.focus }),
  'ts:dismiss': (msg) => tracker.dismiss(msg.ids || []),
  'ts:setAiSummary': (msg) => tracker.setAiSummary(msg),
  'ts:clearAll': () => tracker.clearAll(),
  'ts:refresh': () => tracker.onTick(),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  // Content scripts (web pages) may only report telemetry about their own tab.
  if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(''))) {
    tracker.onContentMessage(msg, sender.tab).catch(logError);
    return false;
  }

  const action = DASHBOARD_ACTIONS[msg.type];
  if (!action || sender.id !== chrome.runtime.id) return false;
  action(msg)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // async response
});
