# Tab State

A Chrome extension that tracks *how* you actually used each tab — not what site it is, but
whether you glanced at it, skimmed it, read it closely, or never looked at it at all — and shows
a Kanban dashboard sorted by that, with a one-line note on where you stopped in each one.

Everything runs locally by default: no account, no setup, no API key required.

## Install (unpacked, for development)

```bash
git clone <this repo>
```

1. Open `chrome://extensions/`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**, select the `tab-state/` folder
4. Click the toolbar icon to open the dashboard (or `Alt+Shift+S`)

## How tabs are sorted

| Bucket | Rule |
|---|---|
| 🎯 Deep Focus | Copied or highlighted text, or 90s+ active, or 70%+ scrolled with 30s+ active |
| 👻 Ghost | Active for under 2s (opened in the background, never really looked at) |
| 📖 Partially Read | 15s+ active, or 25%+ scrolled with 5s+ active |
| 👁️ Just Glanced | Everything else |

"Active time" only counts while the tab is visible, focused, and the window has focus — pausing
for another app or a locked screen, but **not** for sitting still reading without touching the
mouse (see [Design notes](#design-notes)).

## AI summaries (optional)

Each Deep Focus / Partially Read card gets a one-sentence note like *"Spent 2m reading 90% of the
page, copied a snippet, and stopped at a code block in 'Authentication'."* This works with no setup
via a deterministic built-in sentence, and gets more natural with a model:

- **On-device (Gemini Nano)** — built into recent Chrome, no data leaves your machine, free.
- **OpenAI-compatible API** — OpenAI, Ollama, LM Studio, OpenRouter, Groq, or anything else that
  speaks the `/chat/completions` format. Ollama works with no API key.
- **Anthropic API** — Claude models directly.

Configure under **Settings**. Only page titles, descriptions, and your engagement metrics are
sent to a cloud provider — never page content.

## Project layout

```
tab-state/
  manifest.json
  background.js       # service worker: wires Chrome events to the tracker
  content.js           # runs in every page: scroll depth, highlights, copies, "where you stopped"
  lib/
    tracker.js          # the telemetry engine (see Design notes)
    classifier.js        # pure classify() function
    store.js              # chrome.storage.local persistence, one record per key
    template.js            # deterministic fallback summary
    config.js, url.js, format.js
  ai/
    providers.js       # pluggable summary providers (nano / openai-compatible / anthropic)
    prompt.js            # the prompt sent to a model
    settings.js            # provider settings, stored in chrome.storage.local
  ui/
    dashboard.html/js/css   # the Kanban board
    settings.html/js         # provider settings + "how tabs are sorted" + data controls
  tests/
    unit/                # node --test, fake chrome.* APIs
    e2e/                  # Playwright, loads the real extension into Chromium
```

## Design notes

**Time is tracked with timestamps, never a running counter.** MV3 kills the service worker
whenever it wants, so nothing can rely on an interval firing continuously. A focused tab stores
`activeSince`; when focus leaves, `Date.now() - activeSince` is added to `activeMs` and
`activeSince` is cleared. If the *ending* event never arrives (sleep, crash, force-quit), a
15-second heartbeat from the content script caps how far a segment can be back-dated when the
worker wakes up again — so a laptop closed overnight adds at most ~45 seconds, not the whole night.

**Only a locked screen pauses tracking, not mere mouse/keyboard inactivity.** Chrome's `idle` API
reports `'idle'` after ~60s of no input — but someone deep in a long article often doesn't touch
the mouse for minutes. Treating that as "away" would undercount exactly the deep-focus reading
this tool exists to surface. Only `'locked'` (an actual screen lock) pauses the clock.

**Records key on the normalized URL, not the tab id**, because tab ids are meaningless across a
browser restart. On restart, closed-but-still-open records are matched back to restored tabs by
URL as they reload (tabs restore lazily, so there's a short revival window for tabs that haven't
loaded yet).

**Purge → close → undo is guarded against a real race.** Closing a tab via `chrome.tabs.remove()`
is asynchronous; a straggling `tabs.onUpdated` event for a tab that's mid-removal can otherwise
look like a brand-new tab once its record has been finalized, minting a duplicate. Tab ids headed
for removal are held in a short-lived guard until Chrome confirms the removal, so no duplicate
record gets created in that window (covered by a dedicated regression test).

## Testing

```bash
npm test                      # unit tests (lib/, ai/) — fake chrome.* APIs, no browser needed
node tests/e2e/run.mjs        # loads the real extension into Chromium via Playwright
```

The e2e test drives real tabs (scrolling, copying, highlighting, closing, navigating, purging,
undoing, restarting focus) against a local test server and asserts on the actual dashboard DOM —
not mocks.

## Roadmap

**v2**
- **Session recap** — one AI-generated line summarizing the whole session ("You went deep on
  auth docs and the async post, skimmed the recipe roundup, never opened 5 background tabs"),
  reusing the existing provider chain instead of only per-tab summaries.
- **Follow-up notes** — a free-text note on any card ("want to read this properly later").
  Writing one flags the tab as Follow Up, exempts it from Purge regardless of bucket, and the
  note is blended into that tab's AI summary. Starts fully manual; a "notice what I tend to
  flag" learning layer is a later refinement once there's real usage to learn from.
- **Editable thresholds** — the active-time/scroll-depth cutoffs in `lib/config.js` become
  user-editable in Settings instead of fixed constants.
- **Lightweight insights** — a one-line "how you used the browser today" summary in the
  dashboard header; a fuller charts view is a possible stretch, not the default.
- **Daily check-list** — mark specific sites "check daily"; the dashboard badges ones not yet
  checked today. Reuses the existing `chrome.alarms` heartbeat to reset at local midnight — no
  extra permission, no OS notification.
- **AI-assisted tab grouping** (optional, off by default) — uses `chrome.tabGroups` to group
  related tabs on request. Kept strictly opt-in: the product's whole differentiation is
  classifying tabs by *how you engaged*, not *what they are*, and always-on category grouping
  would blur that.
- **Hosted "Pro" summary tier** (a small proxy holding the API key, paywalled via ExtensionPay),
  so someone without a model of their own can still get AI summaries.

**v3**
- **MCP server support** — the extension can't host an MCP server itself (browser sandbox), so
  this needs a companion local process bridged via Chrome's Native Messaging API, exposing
  tracked session data as MCP tools/resources (e.g. "what was I reading about last week") to
  Claude or any other MCP client. A real sub-project, not a flag to flip.
