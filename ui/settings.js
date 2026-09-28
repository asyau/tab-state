import { THRESHOLDS } from '../lib/config.js';
import { OPENAI_PRESETS, loadSettings, saveSettings } from '../lib/settings.js';
import {
  PROVIDERS, enableNano, nanoAvailability, sendsDataOffDevice, summarize,
  hostedUser, openHostedCheckout,
} from '../ai/providers.js';

const $ = (sel) => document.querySelector(sel);

const SAMPLE_RECORD = {
  title: 'Authentication | Stripe API Reference',
  url: 'https://docs.stripe.com/api/authentication',
  description: 'The Stripe API uses API keys to authenticate requests.',
  activeMs: 134_000,
  activeSince: null,
  maxScrollPct: 88,
  copies: 1,
  highlights: 0,
  selectionSnippet: 'curl https://api.stripe.com/v1/charges -u sk_test_...',
  anchor: { kind: 'code', heading: 'Authentication', snippet: 'curl https://api.stripe.com/v1/charges' },
};

const NANO_TEXT = {
  available: 'On-device model is ready.',
  downloadable: 'This device supports Chrome\'s on-device model. It needs a one-time download.',
  downloading: 'On-device model is downloading…',
  unavailable: 'Chrome\'s on-device model isn\'t available on this device (it needs recent Chrome and enough disk space and memory). Summaries fall back to the basic sentence, or add an API below.',
  unsupported: 'This browser doesn\'t expose Chrome\'s built-in AI. Summaries fall back to the basic sentence, or add an API below.',
};

// [settingsKey, inputId, divisor to convert ms->displayed unit; 1 for percent fields]
const THRESHOLD_FIELDS = [
  ['ghostMaxMs', 't-ghostMaxMs', 1000],
  ['glancedMaxMs', 't-glancedMaxMs', 1000],
  ['deepMinMs', 't-deepMinMs', 1000],
  ['deepScrollPct', 't-deepScrollPct', 1],
  ['deepScrollMinMs', 't-deepScrollMinMs', 1000],
  ['partialScrollPct', 't-partialScrollPct', 1],
  ['partialScrollMinMs', 't-partialScrollMinMs', 1000],
  ['interactedMinMs', 't-interactedMinMs', 1000],
];

let settings;

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload }).then((res) => {
    if (!res?.ok) throw new Error(res?.error || 'No response from background');
    return res.result;
  });
}

// --- Provider ------------------------------------------------------------------------------

function renderProviders() {
  const wrap = $('#providers');
  wrap.replaceChildren(...Object.values(PROVIDERS).map((p) => {
    const label = document.createElement('label');
    label.className = 'option';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'provider';
    input.value = p.id;
    input.checked = settings.provider === p.id;
    input.addEventListener('change', () => { settings.provider = p.id; syncVisibility(); });
    const text = document.createElement('span');
    text.textContent = p.label;
    label.append(input, text);
    return label;
  }));
}

function syncVisibility() {
  $('#openai-fields').hidden = settings.provider !== 'openai';
  $('#anthropic-fields').hidden = settings.provider !== 'anthropic';
  $('#hosted-fields').hidden = settings.provider !== 'hosted';
  $('#privacy').hidden = !sendsDataOffDevice(settings);
  if (settings.provider === 'hosted') renderHostedStatus();
}

function fillFields() {
  const preset = $('#openai-preset');
  preset.replaceChildren(
    new Option('Custom', ''),
    ...OPENAI_PRESETS.map((p) => new Option(p.label, p.baseUrl)),
  );
  preset.value = OPENAI_PRESETS.some((p) => p.baseUrl === settings.openai.baseUrl) ? settings.openai.baseUrl : '';
  $('#openai-base').value = settings.openai.baseUrl;
  $('#openai-key').value = settings.openai.apiKey;
  $('#openai-model').value = settings.openai.model;
  $('#anthropic-key').value = settings.anthropic.apiKey;
  $('#anthropic-model').value = settings.anthropic.model;
  $('#hosted-worker-url').value = settings.hosted.workerUrl;
}

function readFields() {
  settings.openai = {
    baseUrl: $('#openai-base').value.trim(),
    apiKey: $('#openai-key').value.trim(),
    model: $('#openai-model').value.trim(),
  };
  settings.anthropic = {
    apiKey: $('#anthropic-key').value.trim(),
    model: $('#anthropic-model').value.trim(),
  };
  settings.hosted = {
    workerUrl: $('#hosted-worker-url').value.trim(),
  };
}

async function renderNano() {
  const status = await nanoAvailability();
  $('#nano-status').textContent = NANO_TEXT[status] || status;
  $('#enable-nano').hidden = status !== 'downloadable';
}

$('#openai-preset').addEventListener('change', (e) => {
  if (e.target.value) $('#openai-base').value = e.target.value;
});

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  readFields();
  await saveSettings(settings);
  $('#saved').hidden = false;
  setTimeout(() => { $('#saved').hidden = true; }, 2000);
});

$('#test').addEventListener('click', async () => {
  readFields();
  const out = $('#test-result');
  out.textContent = 'Testing…';
  const result = await summarize(SAMPLE_RECORD, settings);
  const lines = [`Result (${result.source}): ${result.text}`];
  if (result.errors.length) lines.push('', 'Problems:', ...result.errors.map((e) => `• ${e}`));
  out.textContent = lines.join('\n');
});

$('#enable-nano').addEventListener('click', async () => {
  const btn = $('#enable-nano');
  btn.disabled = true;
  try {
    await enableNano((p) => { btn.textContent = `Downloading ${Math.round(p * 100)}%`; });
  } catch (err) {
    $('#nano-status').textContent = `Download failed: ${err?.message || err}`;
  }
  btn.disabled = false;
  btn.textContent = 'Download on-device model';
  renderNano();
});

// --- Tab State Pro (hosted) ---------------------------------------------------------------

async function renderHostedStatus() {
  const status = $('#hosted-status');
  status.textContent = 'Checking…';
  try {
    const user = await hostedUser();
    status.textContent = user?.paid
      ? `✅ Subscribed${user.email ? ` as ${user.email}` : ''}.`
      : 'Not subscribed yet — use "Upgrade" below once your Worker URL is set.';
  } catch (err) {
    status.textContent = `⚠️ Could not check subscription status: ${err?.message || err}`;
  }
}

$('#hosted-upgrade').addEventListener('click', async () => {
  try {
    await openHostedCheckout();
  } catch (err) {
    $('#hosted-status').textContent = `⚠️ Could not open the upgrade page: ${err?.message || err}`;
  }
});

$('#hosted-refresh').addEventListener('click', renderHostedStatus);

// --- Thresholds ------------------------------------------------------------------------------

function fillThresholdFields() {
  for (const [key, id, div] of THRESHOLD_FIELDS) $(`#${id}`).value = Math.round(settings.thresholds[key] / div);
}

function readThresholdFields() {
  const next = {};
  for (const [key, id, div] of THRESHOLD_FIELDS) {
    const n = Number($(`#${id}`).value);
    next[key] = Number.isFinite(n) && n >= 0 ? Math.round(n * div) : THRESHOLDS[key];
  }
  return next;
}

$('#thresholds-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  settings.thresholds = readThresholdFields();
  await saveSettings(settings);
  $('#thresholds-saved').hidden = false;
  setTimeout(() => { $('#thresholds-saved').hidden = true; }, 2000);
});

$('#thresholds-reset').addEventListener('click', async () => {
  settings.thresholds = { ...THRESHOLDS };
  fillThresholdFields();
  await saveSettings(settings);
});

// --- AI-assisted tab grouping (instant-apply toggle) ------------------------------------------

$('#grouping-enabled').addEventListener('change', async (e) => {
  settings.grouping = { enabled: e.target.checked };
  await saveSettings(settings);
});

// --- Connect your AI assistant (MCP sync: local, off by default) -------------------------------

let mcpTimer = 0;

function setMcpPill(kind, text) {
  const pill = $('#mcp-pill');
  pill.hidden = !kind;
  pill.className = `pill${kind === 'ok' ? ' on' : kind === 'warn' ? ' warn' : ''}`;
  pill.textContent = text || '';
}

/** Is the local server up? It runs whenever an assistant with the plugin (or the .mcpb) has
 *  started it — so while sync is on and it isn't reachable yet, keep checking quietly. */
async function checkMcpStatus() {
  clearTimeout(mcpTimer);
  const status = $('#mcp-status');
  if (!settings.mcpSync?.enabled) {
    status.textContent = 'Off — your assistant can\'t see your tabs.';
    setMcpPill('off', 'Off');
    return;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${settings.mcpSync.port}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(String(res.status));
    status.textContent = '✅ Connected — your assistant can see your tabs.';
    setMcpPill('ok', 'Connected');
    mcpTimer = setTimeout(checkMcpStatus, 30_000);
  } catch {
    status.textContent = 'On — waiting for your assistant. Do step 2, then open Claude Code, Codex or Claude Desktop: this turns green by itself.';
    setMcpPill('warn', 'Waiting for assistant');
    mcpTimer = setTimeout(checkMcpStatus, 5_000);
  }
}

$('#mcp-enabled').addEventListener('change', async (e) => {
  settings.mcpSync = { ...settings.mcpSync, enabled: e.target.checked };
  await saveSettings(settings);
  checkMcpStatus();
});

$('#mcp-port').addEventListener('change', async (e) => {
  const port = Number(e.target.value);
  settings.mcpSync = { ...settings.mcpSync, port: Number.isFinite(port) && port > 0 ? port : 8765 };
  e.target.value = settings.mcpSync.port;
  await saveSettings(settings);
  checkMcpStatus();
});

// Assistant tabs (WAI-ARIA tabs pattern: arrow keys move between tabs). The last one picked is
// remembered per browser — a convenience only, so storage failures are ignored.
const ASSISTANT_KEY = 'ts-settings-assistant';
const tabs = [...document.querySelectorAll('.st-tab')];
function selectAssistant(pane, { focus = false } = {}) {
  for (const tab of tabs) {
    const on = tab.dataset.pane === pane;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`#pane-${tab.dataset.pane}`).hidden = !on;
    if (on && focus) tab.focus();
  }
  try { localStorage.setItem(ASSISTANT_KEY, pane); } catch { /* optional */ }
}
tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => selectAssistant(tab.dataset.pane));
  tab.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (e.key === 'Home' || e.key === 'End' || step) {
      e.preventDefault();
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + step + tabs.length) % tabs.length;
      selectAssistant(tabs[j].dataset.pane, { focus: true });
    }
  });
});
let savedAssistant = null;
try { savedAssistant = localStorage.getItem(ASSISTANT_KEY); } catch { /* optional */ }
selectAssistant(tabs.some((t) => t.dataset.pane === savedAssistant) ? savedAssistant : 'claude-code');

async function copyText(text, button, doneLabel = 'Copied') {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = doneLabel;
  } catch {
    button.textContent = 'Press Ctrl+C';
    const range = document.createRange();
    range.selectNodeContents(button.closest('.st-cmd')?.querySelector('code') ?? button);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }
  button.classList.add('done');
  setTimeout(() => { button.textContent = label; button.classList.remove('done'); }, 1600);
}
document.querySelectorAll('.st-copy').forEach((btn) => btn.addEventListener('click', () =>
  copyText(btn.closest('.st-cmd').querySelector('code').textContent, btn)));
document.querySelectorAll('.st-prompt').forEach((btn) => btn.addEventListener('click', async () => {
  const text = btn.textContent;
  await copyText(text, btn, '✓ Copied — paste it into your assistant');
}));

// Section menu: highlight the section you're reading — the last one whose top has scrolled past
// the top of the window. Sections side by side (same top) keep the first, so Summaries (not
// Sorting) is highlighted at the top of the page.
const navLinks = [...document.querySelectorAll('.st-nav-link')];
const navTargets = navLinks.map((a) => document.querySelector(a.getAttribute('href')));
function updateNav() {
  let active = 0;
  let activeTop = -Infinity;
  navTargets.forEach((t, i) => {
    const top = t?.getBoundingClientRect().top ?? Infinity;
    if (top <= 140 && top > activeTop + 1) { active = i; activeTop = top; }
  });
  // At the very bottom the last sections can't reach the top; highlight the last one.
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) active = navLinks.length - 1;
  navLinks.forEach((a, i) => a.classList.toggle('active', i === active));
}
window.addEventListener('scroll', updateNav, { passive: true });
window.addEventListener('resize', updateNav);
updateNav();

// --- Daily check-list management --------------------------------------------------------------

async function renderWatchlist() {
  const box = $('#watchlist');
  let list;
  try {
    list = await send('ts:getWatchlist');
  } catch {
    list = [];
  }
  if (!list.length) {
    box.textContent = 'Nothing on your check-list yet.';
    return;
  }
  box.replaceChildren(...list.map((w) => {
    const row = document.createElement('div');
    row.className = 'watchlist-row';
    const label = document.createElement('span');
    label.textContent = `${w.label} (${w.domain})`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn small subtle';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      await send('ts:watchRemove', { domain: w.domain });
      renderWatchlist();
    });
    row.append(label, remove);
    return row;
  }));
}

// --- Data ------------------------------------------------------------------------------------

$('#clear').addEventListener('click', async () => {
  if (!confirm('Delete all tracked tab data? Open tabs stay open.')) return;
  await chrome.runtime.sendMessage({ type: 'ts:clearAll' });
  await chrome.runtime.sendMessage({ type: 'ts:refresh' });
  $('#clear').textContent = 'Deleted';
});

(async function init() {
  settings = await loadSettings();
  renderProviders();
  fillFields();
  syncVisibility();
  fillThresholdFields();
  $('#grouping-enabled').checked = !!settings.grouping?.enabled;
  $('#mcp-enabled').checked = !!settings.mcpSync?.enabled;
  $('#mcp-port').value = settings.mcpSync?.port || 8765;
  checkMcpStatus();
  renderNano();
  renderWatchlist();
})();

// Keep the watchlist panel live if it's changed elsewhere (e.g. a "Watch daily" click on the
// dashboard while this Settings page is already open).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.watchlist) renderWatchlist();
});
