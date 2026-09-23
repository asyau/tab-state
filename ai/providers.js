// Pluggable summary providers. Each provider knows how to turn a (systemPrompt, userPrompt)
// pair into text via nano / OpenAI-compatible / Anthropic. Three call sites build on that:
// per-tab summaries, the whole-session recap, and AI-assisted tab grouping.
// Adding a provider (e.g. a paid hosted tier that calls our own proxy) means adding one entry
// to PROVIDERS and one option on the settings page. Nothing else changes.
//
// Runs in extension pages (dashboard / settings), not the service worker: Chrome's built-in
// model is only exposed to window contexts, and downloading it needs a user click.

import { templateInsight, templateSessionSummary, templateSummary } from '../lib/template.js';
import {
  SYSTEM_PROMPT, buildUserPrompt, cleanOutput,
  SESSION_SYSTEM_PROMPT, buildSessionPrompt,
  GROUPING_SYSTEM_PROMPT, buildGroupingPrompt,
  INSIGHT_SYSTEM_PROMPT,
} from './prompt.js';

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

async function createNanoSession(systemPrompt, onProgress) {
  const nano = nanoApi();
  if (!nano) throw new Error('This browser has no built-in AI model');
  const monitor = (m) => m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded ?? 0));
  if (nano.modern) {
    return nano.api.create({
      ...NANO_OPTIONS,
      initialPrompts: [{ role: 'system', content: systemPrompt }],
      monitor,
    });
  }
  return nano.api.create({ systemPrompt, monitor });
}

// A session bakes its system prompt in at creation time, so each distinct system prompt
// (per-tab summary, session recap, grouping) gets its own cached session.
const nanoSessions = new Map();

/** Must be called from a click handler: starts (or finishes) the model download. */
export async function enableNano(onProgress) {
  const session = await createNanoSession(SYSTEM_PROMPT, onProgress);
  nanoSessions.set(SYSTEM_PROMPT, session);
  return nanoAvailability();
}

async function nanoRun(systemPrompt, userPrompt) {
  const state = await nanoAvailability();
  if (state !== 'available') throw new Error(`On-device model is ${state}`);
  let base = nanoSessions.get(systemPrompt);
  if (!base) {
    base = await createNanoSession(systemPrompt);
    nanoSessions.set(systemPrompt, base);
  }
  // Clone so earlier calls don't leak into this one's context.
  const session = base.clone ? await base.clone() : base;
  try {
    return await session.prompt(userPrompt);
  } finally {
    if (session !== base) session.destroy?.();
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

async function openaiRun(systemPrompt, userPrompt, settings) {
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
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

// --- Anthropic ----------------------------------------------------------------

async function anthropicRun(systemPrompt, userPrompt, settings) {
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
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = await res.json();
  return data?.content?.find((b) => b.type === 'text')?.text ?? '';
}

// --- Registry -----------------------------------------------------------------

// `run` here takes (systemPrompt, userPrompt, settings) uniformly; the per-tab/session/grouping
// call sites below supply whichever prompt pair they need.
export const PROVIDERS = {
  auto: { id: 'auto', label: 'Automatic (on-device if available, else basic)', local: true },
  nano: { id: 'nano', label: 'On-device: Gemini Nano (Chrome built-in)', local: true, run: (sys, usr) => nanoRun(sys, usr) },
  openai: { id: 'openai', label: 'OpenAI-compatible API (OpenAI, Ollama, LM Studio, OpenRouter, Groq…)', local: false, run: openaiRun },
  anthropic: { id: 'anthropic', label: 'Anthropic API (Claude)', local: false, run: anthropicRun },
  template: { id: 'template', label: 'Basic: no AI, built-in sentence', local: true },
  // Future paid tier: { id: 'hosted', label: 'Pro (hosted)', run: callOurProxy }
};

export function providerChain(settings) {
  if (settings.provider === 'auto') return ['nano', 'template'];
  if (settings.provider === 'template' || !PROVIDERS[settings.provider]?.run) return ['template'];
  return [settings.provider, 'template'];
}

/** Try the configured provider chain with a given prompt pair. 'template' entries call `fallback`. */
async function runChain(chain, systemPrompt, userPrompt, settings, fallback, maxLen = 220) {
  const errors = [];
  for (const id of chain) {
    if (id === 'template') return { text: fallback(), source: 'template', errors };
    try {
      const text = cleanOutput(await PROVIDERS[id].run(systemPrompt, userPrompt, settings), maxLen);
      if (text) return { text, source: id, errors };
      errors.push(`${id}: empty response`);
    } catch (err) {
      errors.push(`${id}: ${err?.message || err}`);
    }
  }
  return { text: fallback(), source: 'template', errors };
}

/** Try the configured provider, fall back to the template. Never throws. */
export function summarize(record, settings) {
  const thresholds = settings.thresholds;
  return runChain(
    providerChain(settings),
    SYSTEM_PROMPT,
    buildUserPrompt(record, Date.now(), thresholds),
    settings,
    () => templateSummary(record, Date.now(), thresholds),
  );
}

/** One-line recap of the whole tracked session. Never throws. */
export function summarizeSession(records, settings) {
  const thresholds = settings.thresholds;
  const now = Date.now();
  return runChain(
    providerChain(settings),
    SESSION_SYSTEM_PROMPT,
    buildSessionPrompt(records, now, thresholds),
    settings,
    () => templateSessionSummary(records, now, thresholds),
  );
}

/** A fuller, on-demand 2-4 sentence insight for the card detail view. Never throws. */
export function getInsight(record, settings) {
  const thresholds = settings.thresholds;
  return runChain(
    providerChain(settings),
    INSIGHT_SYSTEM_PROMPT,
    buildUserPrompt(record, Date.now(), thresholds),
    settings,
    () => templateInsight(record, Date.now(), thresholds),
    500,
  );
}

/** Is a cloud provider selected? (Page titles and metrics will leave the device.) */
export function sendsDataOffDevice(settings) {
  return PROVIDERS[settings.provider]?.local === false;
}

// --- AI-assisted tab grouping (settings.grouping.enabled, off by default) -------------------

/** Tolerant JSON extraction: strips a ```json fence or leading/trailing prose if a model adds one. */
export function parseGroupsJson(text) {
  if (typeof text !== 'string') return [];
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((g) => g && typeof g.name === 'string' && Array.isArray(g.indexes));
  } catch {
    return [];
  }
}

/**
 * Proposes groups for the given records using the configured AI provider. Requires real AI
 * (no sensible non-AI fallback exists for "which of these are related"); returns an empty
 * `groups` array with an explanatory error if only the template is available.
 */
export async function proposeGroups(records, settings) {
  const chain = providerChain(settings).filter((id) => id !== 'template');
  if (!chain.length) {
    return { groups: [], errors: ['No AI provider configured — enable on-device AI or add an API key in Settings to use grouping.'] };
  }
  const { prompt, indexToId } = buildGroupingPrompt(records);
  const { text, errors, source } = await runChain(chain, GROUPING_SYSTEM_PROMPT, prompt, settings, () => '');
  if (!text) return { groups: [], errors: errors.length ? errors : ['No response from the AI provider.'] };

  const raw = parseGroupsJson(text);
  const seen = new Set();
  const groups = [];
  for (const g of raw) {
    const ids = [...new Set(g.indexes)]
      .map((i) => indexToId.get(Number(i)))
      .filter((id) => id && !seen.has(id));
    if (ids.length < 2) continue; // a "group" of one isn't a group
    for (const id of ids) seen.add(id);
    groups.push({ name: String(g.name).slice(0, 60) || 'Group', tabIds: ids });
  }
  return { groups, source, errors: groups.length ? [] : ['The model\'s response could not be parsed into valid groups.'] };
}
