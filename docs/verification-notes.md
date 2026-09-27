
# Verification notes

What's been verified by running real code, and what's been reviewed by reading code against a
spec but not exercised live — and why, so nothing here is overstated.

## Verified by running

- **Core tracking, dashboard, purge/undo, notes, recap, check-list, detail view, accessibility,
  MCP sync, hosted-provider UI**: `tests/unit/*.test.js` (69 tests, fake `chrome.*` API) and
  `tests/e2e/run.mjs` (Playwright driving the real unpacked extension in Chromium, including real
  page navigation, scrolling, copy/highlight events, a real HTTP POST to a local MCP sync
  listener, and — importantly — the real vendored ExtPay client actually loading and running
  inside a genuine extension page without crashing, which the unit tests can't cover since they
  inject a fake `ExtPay` instead of touching the vendored client at all; see
  `lib/extpay.js`'s comment for why).
- **Real websites**: `tests/e2e/real-sites.mjs` against live Wikipedia/MDN/GitHub/Hacker News.
- **`mcp-server/`**: `mcp-server/test/*.test.js` (12 tests) — a real MCP `Client`/`Server` pair
  over `InMemoryTransport`, a real HTTP request against the sync endpoint, and a genuine child
  process spawn (`test/manual-subprocess-check.mjs`) that sends a real MCP `initialize` handshake
  over stdio, used to catch a startup bug that otherwise failed silently (see its file header).
- **`pro-proxy/`**: `pro-proxy/test/worker.test.js` (11 tests) — the real Worker `fetch` handler,
  with a mocked KV binding and mocked outbound `fetch`, covering routing, request validation, the
  Anthropic request/response shape, error surfacing, and the per-user rate limit end to end.

All of the above ran on macOS, against Chromium (Playwright's bundled build), in this session.

## Reviewed, not live-tested

**Gemini Nano (on-device provider, [`ai/providers.js`](../ai/providers.js)).** The code supports
both the current `LanguageModel` global and the older origin-trial `window.ai.languageModel` shape,
and is only ever called from extension pages (dashboard/settings), never the service worker, since
Chrome only exposes the Prompt API to window contexts. What's actually been exercised: the
*absence* path — `nanoAvailability()` correctly reports `'unsupported'`/`'unavailable'` in
Playwright's Chromium (which doesn't ship the on-device model component), and the UI's fallback to
the deterministic built-in summary was confirmed working end-to-end in `tests/e2e/run.mjs`. What
hasn't been exercised: an actual on-device inference call, because that needs a real Chrome profile
with the model downloaded — Google's stated requirements are Chrome 131+ on Windows 10/11, macOS
13+, or Linux, 22GB+ free storage, and 4GB+ VRAM, none of which a sandboxed test browser satisfies.
If you have a machine that meets those, Settings → Summary provider → On-device will show a real
download progress bar and you can confirm it there.

**Hosted Pro tier ([`pro-proxy/`](../pro-proxy/README.md)).** The vendored ExtPay client was
confirmed to actually load and run in a real extension page in this session (`tests/e2e/run.mjs`)
— it calls the real extensionpay.com over HTTPS and reports back an (unregistered, unpaid) user
without throwing, which is what proves the integration itself is wired correctly. What wasn't, and
couldn't be, verified here: an actual Cloudflare deployment (`wrangler deploy` needs a real
Cloudflare account), a real ExtensionPay subscription and Stripe payment, or a real Anthropic call
made *through* a deployed Worker end to end — none of those are things this session has accounts
or credentials for, and creating payment/financial accounts isn't something to do without you.
The Worker's own logic (routing, rate limiting, the Anthropic request shape, error handling) is
unit-tested against a mocked KV store and mocked `fetch` (`pro-proxy/test/worker.test.js`), which
covers correctness but not a real deployment.

**Cloud API providers (OpenAI-compatible and Anthropic, same file).** No live API keys or a running
Ollama/LM Studio instance were available in this session, so no real network call to either
provider was made. Reviewed instead for conformance against each provider's documented request/
response shape:
- OpenAI-compatible: `POST {baseUrl}/chat/completions` with `{model, messages: [{role, content}]}`,
  reading `choices[0].message.content` back — matches the OpenAI Chat Completions shape that
  Ollama, LM Studio, OpenRouter, Groq etc. all implement. The API key header is only sent when a
  key is set, so Ollama (which needs none) isn't sent a spurious `Authorization` header.
- Anthropic: `POST https://api.anthropic.com/v1/messages` with `x-api-key`,
  `anthropic-version: 2023-06-01`, and `anthropic-dangerous-direct-browser-access: true` (required
  to call the API directly from a browser origin), body `{model, max_tokens, system, messages}`,
  reading the first `type: 'text'` block out of the returned `content` array — matches the Messages
  API shape.
- Error handling reads `body.error.message` first, which is the shape both providers use for error
  responses, before falling back to raw text — so a real 4xx from either one should surface a
  readable message rather than "[object Object]".

If you add a real key (or point the OpenAI-compatible field at a local Ollama), the "Test with a
sample tab" button in Settings is the fastest way to confirm this against a live provider yourself.

## Windows / Linux Chrome

Not tested on either OS this session (no such machine available here) — this is a static read-
through of the whole codebase, not a live run.

- The extension itself (`manifest.json`, `background.js`, `content.js`, `lib/`, `ui/`, `ai/`) has
  no OS-specific branches, hardcoded paths, or platform sniffing anywhere in it — it only touches
  `chrome.*` extension APIs and standard web APIs, which Chrome itself normalizes across platforms.
- The one keyboard shortcut (`Alt+Shift+S` in `manifest.json`) uses Chrome's `commands` API
  `"default"` key with no per-platform override; Chrome translates `Alt` to `Option` on macOS
  automatically, so the same manifest entry is correct on all three platforms without needing a
  separate `"mac"` binding.
- `mcp-server/` is plain Node.js (`http`, `fs`, `os`, `path` from `node:*`), which is
  cross-platform, with one real platform difference worth knowing about: the `0o600`/`0o700` file
  modes in `store.mjs` are POSIX permission bits. Node's own docs note that on Windows, a file
  mode only toggles the read-only attribute and the rest of the bits are ignored — so on Windows,
  "not world-readable" comes from `~/.tab-state-mcp` sitting inside the user's own profile
  directory (private by default under NTFS) rather than from those explicit chmod bits. This isn't
  a known vulnerability (a normal per-user Windows account already can't read another account's
  profile folder), just a different mechanism than on macOS/Linux, noted here so it isn't quietly
  assumed to work identically.

## What this means for you

Everything under "Verified by running" you can trust was actually exercised. Everything under
"Reviewed, not live-tested" is standard, spec-conformant code that has every reason to work, but
wasn't run against the real external thing (a model-enabled Chrome profile, a live API key, a
different OS) in this environment — worth a quick real check yourself before relying on it,
especially before publishing.
