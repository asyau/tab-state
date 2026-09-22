// Pluggable summary providers. Each provider takes a record + settings and returns one sentence.
// Adding a provider (e.g. a paid hosted tier that calls our own proxy) means adding one entry
// to PROVIDERS and one option on the settings page. Nothing else changes.
//
// Runs in extension pages (dashboard / settings), not the service worker: Chrome's built-in
// model is only exposed to window contexts, and downloading it needs a user click.

import { templateSummary } from '../lib/template.js';
import { SYSTEM_PROMPT, buildUserPrompt, cleanOutput } from './prompt.js';

const REQUEST_TIMEOUT_MS = 25_000;
const NANO_OPTIONS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

// --- Gemini Nano (Chrome built-in Prompt API) -------------------------------------

function nanoApi() {
  if (typeof globalThis.LanguageModel !== 'undefined') return { modern: true, api: globalThis.LanguageModel };
  if (globalThis.ai?.languageModel) return { modern: false, api: globalThis.ai.languageModel };
  return null;
}

/** 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available' */
export async function nanoAvailability() {
  const nano = nanoApi();
  if (!nano) return 'unsupported';
  try {
    if (nano.modern) return await nano.api.availability(NANO_OPTIONS);
    const caps = await nano.api.capabilities();
    if (caps.available === 'readily') return 'available';
    if (caps.available === 'after-download') return 'downloadable';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

let nanoSession = null;

async function createNanoSession(onProgress) {
  const nano = nanoApi();
  if (!nano) throw new Error('This browser has no built-in AI model');
  const monitor = (m) => m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded ?? 0));
  if (nano.modern) {
    return nano.api.create({
      ...NANO_OPTIONS,
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
      monitor,
    });
  }
  return nano.api.create({ systemPrompt: SYSTEM_PROMPT, monitor });
}

/** Must be called from a click handler: starts (or finishes) the model download. */
export async function enableNano(onProgress) {
  nanoSession = await createNanoSession(onProgress);
  return nanoAvailability();
}

async function nanoSummarize(record) {
  const state = await nanoAvailability();
  if (state !== 'available') throw new Error(`On-device model is ${state}`);
  if (!nanoSession) nanoSession = await createNanoSession();
  // Clone so earlier summaries don't leak into this one's context.
  const session = nanoSession.clone ? await nanoSession.clone() : nanoSession;
  try {
    return await session.prompt(buildUserPrompt(record));
  } finally {
    if (session !== nanoSession) session.destroy?.();
  }
}

// --- OpenAI-compatible (OpenAI, Ollama, LM Studio, OpenRouter, Groq, Together, ...) ------

async function readError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || body?.message || JSON.stringify(body);
  } catch {
    detail = await res.text().catch(() => '');
  }
  const hint = res.status === 403 && /localhost|127\.0\.0\.1/.test(res.url)
    ? ' (Ollama: start it with OLLAMA_ORIGINS="chrome-extension://*")'
    : '';
  return `HTTP ${res.status}: ${String(detail).slice(0, 200)}${hint}`;
}

async function openaiSummarize(record, settings) {
  const cfg = settings.openai;
  if (!cfg.baseUrl) throw new Error('Set a base URL');
  if (!cfg.model) throw new Error('Set a model name');
  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(record) },
      ],
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

// --- Anthropic ----------------------------------------------------------------

async function anthropicSummarize(record, settings) {
  const cfg = settings.anthropic;
  if (!cfg.apiKey) throw new Error('Set an Anthropic API key');
  if (!cfg.model) throw new Error('Set a model name');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 120,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(record) }],
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = await res.json();
  return data?.content?.find((b) => b.type === 'text')?.text ?? '';
}

// --- Registry -----------------------------------------------------------------

export const PROVIDERS = {
  auto: { id: 'auto', label: 'Automatic (on-device if available, else basic)', local: true },
  nano: { id: 'nano', label: 'On-device: Gemini Nano (Chrome built-in)', local: true, run: nanoSummarize },
  openai: { id: 'openai', label: 'OpenAI-compatible API (OpenAI, Ollama, LM Studio, OpenRouter, Groq…)', local: false, run: openaiSummarize },
  anthropic: { id: 'anthropic', label: 'Anthropic API (Claude)', local: false, run: anthropicSummarize },
  template: { id: 'template', label: 'Basic: no AI, built-in sentence', local: true, run: (r) => templateSummary(r) },
  // Future paid tier: { id: 'hosted', label: 'Pro (hosted)', run: callOurProxy }
};

export function providerChain(settings) {
  if (settings.provider === 'auto') return ['nano', 'template'];
  if (settings.provider === 'template' || !PROVIDERS[settings.provider]?.run) return ['template'];
  return [settings.provider, 'template'];
}

/** Try the configured provider, fall back to the template. Never throws. */
export async function summarize(record, settings) {
  const errors = [];
  for (const id of providerChain(settings)) {
    try {
      const text = cleanOutput(await PROVIDERS[id].run(record, settings));
      if (text) return { text, source: id, errors };
      errors.push(`${id}: empty response`);
    } catch (err) {
      errors.push(`${id}: ${err?.message || err}`);
    }
  }
  return { text: templateSummary(record), source: 'template', errors };
}

/** Is a cloud provider selected? (Page titles and metrics will leave the device.) */
export function sendsDataOffDevice(settings) {
  return PROVIDERS[settings.provider]?.local === false;
}
