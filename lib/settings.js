// App settings: AI provider config, user-editable sort thresholds, and the optional AI
// tab-grouping toggle. Stored in chrome.storage.local under "settings". Lives in lib/ (not
// ai/) because the service worker (lib/tracker.js) reads thresholds from it too, not just the
// UI pages. Note: chrome.storage.local is not encrypted; the settings page says so.

import { THRESHOLDS } from './config.js';

export const DEFAULT_SETTINGS = {
  provider: 'auto', // 'auto' | 'nano' | 'openai' | 'anthropic' | 'template'
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: '',
  },
  anthropic: {
    apiKey: '',
    model: 'claude-haiku-4-5-20251001',
  },
  thresholds: { ...THRESHOLDS },
  grouping: {
    enabled: false, // AI-assisted tab grouping: opt-in, off by default (see README Roadmap)
  },
};

export const OPENAI_PRESETS = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', needsKey: false },
  { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', needsKey: false },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true },
];

/** Merge stored thresholds over the defaults, discarding anything corrupt (non-numeric, negative). */
export function mergeThresholds(stored) {
  const merged = { ...THRESHOLDS, ...(stored || {}) };
  for (const key of Object.keys(THRESHOLDS)) {
    if (!Number.isFinite(merged[key]) || merged[key] < 0) merged[key] = THRESHOLDS[key];
  }
  return merged;
}

export function mergeSettings(stored) {
  const s = stored || {};
  return {
    provider: s.provider || DEFAULT_SETTINGS.provider,
    openai: { ...DEFAULT_SETTINGS.openai, ...(s.openai || {}) },
    anthropic: { ...DEFAULT_SETTINGS.anthropic, ...(s.anthropic || {}) },
    thresholds: mergeThresholds(s.thresholds),
    grouping: { ...DEFAULT_SETTINGS.grouping, ...(s.grouping || {}) },
  };
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return mergeSettings(settings);
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings: mergeSettings(settings) });
}
