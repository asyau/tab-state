import { THRESHOLDS } from '../lib/config.js';
import { formatDuration } from '../lib/format.js';
import { OPENAI_PRESETS, loadSettings, saveSettings } from '../ai/settings.js';
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

let settings;

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

function renderRules() {
  const t = THRESHOLDS;
  const rows = [
    ['🎯 Deep Focus', `Copied or highlighted text, or ${formatDuration(t.deepMinMs)}+ active, or ${t.deepScrollPct}%+ scrolled with ${formatDuration(t.deepScrollMinMs)}+ active`],
    ['👻 Ghost', `Active for less than ${formatDuration(t.ghostMaxMs)}`],
    ['📖 Partially Read', `${formatDuration(t.glancedMaxMs)}+ active, or ${t.partialScrollPct}%+ scrolled with ${formatDuration(t.partialScrollMinMs)}+ active`],
    ['👁️ Just Glanced', 'Everything else'],
  ];
  $('#rules').replaceChildren(...rows.map(([name, rule]) => {
    const tr = document.createElement('tr');
    const a = document.createElement('td');
    const b = document.createElement('td');
    a.textContent = name;
    b.textContent = rule;
    tr.append(a, b);
    return tr;
  }));
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
  renderRules();
  renderNano();
})();
