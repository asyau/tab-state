# pro-proxy

A Cloudflare Worker that lets you offer "Tab State Pro" — hosted AI summaries with no API key for
the user to manage — gated by [ExtensionPay](https://extensionpay.com) payments.

**This is not a service Tab State ships for you.** There is no public, already-running instance.
To offer this, you deploy your own copy with your own Cloudflare, Anthropic, and ExtensionPay
accounts. Read this whole file before doing so — the security model in particular.

## How it fits together

```
User pays  →  ExtensionPay (Stripe)  →  extension checks user.paid client-side
                                              │
                                              ▼
                          Settings → "Tab State Pro" provider, with your Worker's URL
                                              │
                                              ▼
                          extension POSTs {systemPrompt, userPrompt, userId} to your Worker
                                              │
                                              ▼
                    Worker (this folder) calls Anthropic with ITS OWN key, returns {text}
```

## Security model — read this before relying on it

[ExtensionPay's own site](https://extensionpay.com) advertises itself as "no server needed": the
extension's own client-side JavaScript checks `user.paid` by talking directly to ExtensionPay's
servers. There is no public server-to-server API for a third party (like this Worker) to
independently re-verify that a request really came from a paying user — that's confirmed by
reading ExtensionPay's own docs and source (see [`../lib/vendor/extpay.js`](../lib/vendor/extpay.js)
header for exactly what was checked and where).

So this Worker **trusts the extension's own client-side check**. It cannot cryptographically prove
a request came from a paying user. What it does instead, as a cost-abuse backstop rather than a
security boundary, is rate-limit requests per `userId` (200/day by default — see
`RATE_LIMIT_PER_DAY` in `src/worker.js`). Someone who modified their own copy of the extension to
lie about being paid could still call your Worker directly and rack up requests against your
Anthropic bill, up to that daily cap, under a `userId` of their choosing.

This is a real, deliberate trade-off of choosing ExtensionPay for its simplicity (no backend,
Stripe integration handled for you), not an oversight. If you need actual proof of payment, you'd
want your own auth system and to call Stripe directly instead. For a small-extension "Pro" tier,
most developers accept this trade-off; you should decide for yourself whether it's acceptable
given how much you're subsidizing per free-riding request.

## What's NOT wired up (v1 scope)

ExtensionPay's `onPaid`/`onTrialStarted` instant-unlock callbacks need a content script that runs
on `extensionpay.com` (to relay the "you just paid" message back to the extension). Tab State
doesn't declare that content script, to avoid an extra permission warning for a page most users
never load. The practical effect: after paying, a user needs to reopen the Settings page (or click
"Refresh status") to see their subscription reflected — it isn't instant. If you want the instant
version, add the content script block from
[ExtPay's README](https://github.com/Glench/ExtPay#7-use-extpayonpaidaddlistener-to-run-code-when-the-user-pays)
to `manifest.json` and call `extpay.onPaid.addListener(...)`.

## Deploy your own copy

1. **Sign up at [extensionpay.com](https://extensionpay.com)**, connect a Stripe account, and
   register an extension id. Put that id in [`../lib/extpay.js`](../lib/extpay.js)'s
   `PRO_EXTENSION_ID` (it's `'tab-state'` as a placeholder — until you replace it with your real
   registered id, `getUser()` will just report an unpaid, unregistered user, harmlessly).
2. **Install [wrangler](https://developers.cloudflare.com/workers/wrangler/)** and log in:
   ```bash
   cd pro-proxy
   npm install
   npx wrangler login
   ```
3. **Create the KV namespace** used for rate limiting, then paste the id it prints into
   `wrangler.toml`:
   ```bash
   npx wrangler kv namespace create RATE_LIMIT
   ```
4. **Set your real Anthropic key as a secret** (never put it in `wrangler.toml` — that file is
   committed to git):
   ```bash
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
5. **Deploy:**
   ```bash
   npm run deploy
   ```
   Wrangler prints your Worker's URL (`https://tab-state-pro-proxy.<your-subdomain>.workers.dev`).
6. **Point the extension at it**: in Settings → Tab State Pro, paste that URL into "Worker URL",
   pick "Tab State Pro (hosted)" as the provider, and use "Upgrade / manage subscription" to test
   a real payment (ExtensionPay gives you Stripe test mode while developing).

## API

`GET /health` → `{ ok: true }`.

`POST /summarize` — body `{ systemPrompt, userPrompt, userId }` (all required strings; `userId`
is whatever the extension sends, normally the ExtensionPay user's email). Returns `{ text }` on
success; `{ error }` with a 4xx/5xx status otherwise (400 malformed input, 429 rate-limited, 502
Anthropic itself failed).

## Development

```bash
npm test        # node:test — mocks the KV binding and outbound fetch, no real Cloudflare/Anthropic call
npm run dev      # wrangler dev — a real local Worker, still needs a real ANTHROPIC_API_KEY secret to return real text
```
