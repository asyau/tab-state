// Cloudflare Worker: the "hosted Pro" AI proxy. Holds a real Anthropic API key server-side so a
// paying user doesn't need to bring their own; the extension only ever talks to this Worker.
//
// Security model, stated plainly (see pro-proxy/README.md for the full explanation): ExtensionPay
// is explicitly a client-only, "no server needed" product — it has no public server-to-server API
// for a third party like this Worker to independently verify a user's paid status. So this Worker
// cannot cryptographically confirm payment; it trusts the extension's own client-side ExtPay
// check and, as a cost-abuse backstop (not a security boundary), rate-limits per `userId`. Anyone
// who patches the shipped extension to lie about being paid could still call this Worker directly.
// That's a deliberate, documented trade-off, not an oversight — see the README before relying on
// this in production with real money on the line.

const ALLOWED_ORIGIN_PREFIX = 'chrome-extension://';
const RATE_LIMIT_PER_DAY = 200; // per userId; a generous daily cap to bound cost under abuse
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_MAX_TOKENS = 300;

function corsHeaders(origin) {
  const allowed = origin && origin.startsWith(ALLOWED_ORIGIN_PREFIX) ? origin : '';
  return {
    'access-control-allow-origin': allowed || 'null',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
  });
}

/** YYYY-MM-DD in UTC, so the daily cap resets at a fixed, predictable time. */
function utcDateKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Increments today's request count for this userId and reports whether it's over the cap.
 * `env.RATE_LIMIT` is a Workers KV namespace binding (see wrangler.toml).
 */
export async function checkRateLimit(env, userId, now = Date.now()) {
  const key = `rl:${userId}:${utcDateKey(now)}`;
  const current = Number((await env.RATE_LIMIT.get(key)) || 0);
  if (current >= RATE_LIMIT_PER_DAY) return { allowed: false, count: current };
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 60 * 60 * 26 }); // 26h: outlives the UTC day it's keyed to
  return { allowed: true, count: current + 1 };
}

/** Calls Anthropic's Messages API with the Worker's own key. Same request/response shape the
 * extension's own direct Anthropic provider uses (see ai/providers.js) so behavior matches. */
export async function callAnthropic(env, systemPrompt, userPrompt) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('Worker is not configured: missing ANTHROPIC_API_KEY secret');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* ignore parse failure, use empty detail */ }
    throw new Error(`Anthropic HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = await res.json();
  return data?.content?.find((b) => b.type === 'text')?.text ?? '';
}

async function handleSummarize(request, env) {
  const origin = request.headers.get('origin') || '';
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Malformed JSON body' }, 400, origin);
  }
  const { systemPrompt, userPrompt, userId } = body || {};
  if (typeof systemPrompt !== 'string' || typeof userPrompt !== 'string' || !systemPrompt || !userPrompt) {
    return json({ error: 'systemPrompt and userPrompt are required strings' }, 400, origin);
  }
  // Unauthenticated callers all share one bucket; a real userId (from the extension's ExtPay
  // check) gets its own. Either way this is a cost backstop, not proof of payment — see the
  // header comment.
  const id = typeof userId === 'string' && userId ? userId : 'anonymous';
  const rate = await checkRateLimit(env, id);
  if (!rate.allowed) {
    return json({ error: `Daily request limit (${RATE_LIMIT_PER_DAY}) reached for this account` }, 429, origin);
  }
  try {
    const text = await callAnthropic(env, systemPrompt, userPrompt);
    return json({ text }, 200, origin);
  } catch (err) {
    return json({ error: String(err?.message || err) }, 502, origin);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true }, 200, origin);
    if (request.method === 'POST' && url.pathname === '/summarize') return handleSummarize(request, env);
    return json({ error: 'not found' }, 404, origin);
  },
};
