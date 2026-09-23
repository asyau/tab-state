import { THRESHOLDS } from '../lib/config.js';
import { OPENAI_PRESETS, loadSettings, saveSettings } from '../lib/settings.js';
import { PROVIDERS, enableNano, nanoAvailability, sendsDataOffDevice, summarize } from '../ai/providers.js';

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
  $('#privacy').hidden = !sendsDataOffDevice(settings);
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
  renderNano();
  renderWatchlist();
})();

// Keep the watchlist panel live if it's changed elsewhere (e.g. a "Watch daily" click on the
// dashboard while this Settings page is already open).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.watchlist) renderWatchlist();
});
