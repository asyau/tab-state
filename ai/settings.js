// AI provider settings, stored in chrome.storage.local under "settings".
// Note: chrome.storage.local is not encrypted. The settings page says so.

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
};

export const OPENAI_PRESETS = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', needsKey: false },
  { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', needsKey: false },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true },
];

export function mergeSettings(stored) {
  const s = stored || {};
  return {
    provider: s.provider || DEFAULT_SETTINGS.provider,
    openai: { ...DEFAULT_SETTINGS.openai, ...(s.openai || {}) },
    anthropic: { ...DEFAULT_SETTINGS.anthropic, ...(s.anthropic || {}) },
  };
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return mergeSettings(settings);
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings: mergeSettings(settings) });
}
