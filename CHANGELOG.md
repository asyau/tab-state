# Changelog

## Unreleased

- **Full history, kept forever.** Closed tabs are no longer deleted after 7 days (or 1 hour for
  low-engagement ones) — everything's kept, browsable day by day on a new History page. The one
  exception: an explicitly Purged tab is still cleaned up after its undo window. Needs the new
  `unlimitedStorage` permission, since `chrome.storage.local`'s default 10MB cap could otherwise
  be hit by an active user over months of use.
- **Compact dashboard cards.** Cards collapse to a single-line row by default and expand on
  hover or keyboard focus, so far more tabs fit on screen without scrolling; each column's list
  now scrolls independently instead of the whole page.
- Deep Focus now requires the tab to have been active for at least 30s (editable) before a
  copy/highlight alone can force that classification — previously any highlight did, however
  brief the visit, including an easily-accidental one.
- Optional local MCP server (`mcp-server/`) so Claude or another MCP client can answer questions
  like "what was I reading about X last week?" from your tracked tabs. Off by default; the
  extension only syncs to it if you turn it on in Settings, and it never leaves your machine. See
  [`mcp-server/README.md`](mcp-server/README.md).
- Optional self-hosted "Tab State Pro" tier (`pro-proxy/`): a new hosted provider that needs no
  API key, gated by an ExtensionPay subscription, backed by a Cloudflare Worker you deploy
  yourself. See [`pro-proxy/README.md`](pro-proxy/README.md), including its security model.

## 1.0.0

First public release.

- Behavior-based sorting into Just Glanced, Partially Read, Deep Focus and Ghost, from active
  reading time, scroll depth, and copy/highlight activity
- Kanban dashboard with a one-line summary per tab that starts with what the page is about
  (meta description, falling back to the page's `<h1>`)
- Card detail view: where you stopped, last selected text, your note, and an on-demand AI insight
- Purge Ghost & Glanced with confirmation and a 30-second undo; pinned, active and noted tabs are
  never purged
- Follow-up notes, session recap, daily check-list, editable thresholds
- Optional AI-assisted tab grouping (off by default, always confirmed before applying)
- Summary providers: deterministic built-in (default), on-device Gemini Nano, any
  OpenAI-compatible API, Anthropic. Cloud providers never receive page body text or selected text
- Keyboard-accessible dashboard: focus management in the detail dialog, focus preserved across
  live updates, an in-progress note is never lost to a refresh
- Chrome Web Store package build, manifest/permission consistency tests, screenshots and promo
  images generated from the real extension
