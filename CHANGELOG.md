# Changelog

## Unreleased

(Nothing yet — add changes here, then cut a version: bump `manifest.json` and `package.json` together.)

## 1.0.0 — first public release (Chrome Web Store)

### Core

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

### Added before launch

- **Full history, kept forever.** Closed tabs are no longer deleted after 7 days (or 1 hour for
  low-engagement ones) — everything's kept, browsable day by day on a new History page. The one
  exception: an explicitly Purged tab is still cleaned up after its undo window. Needs the new
  `unlimitedStorage` permission, since `chrome.storage.local`'s default 10MB cap could otherwise
  be hit by an active user over months of use.
- **The MCP server and the extension now find each other automatically** instead of both assuming
  port 8765, which collides with common tools (AnkiConnect uses exactly 127.0.0.1:8765). The
  server takes the first free port of 47651–47655 (and writes it to `~/.tab-state-mcp/port`); the
  extension probes those ports for a `/health` that says `"service": "tab-state"` and remembers
  it — never sending tab data to some other app. 8765 is still tried last for older servers, and a
  previously saved 8765 setting now means "automatic". Settings shows which port it found; the
  port field is blank ("Automatic") unless you pin one. ChatGPT remote mode moved to 47660.
- MCP server: no longer exits when its sync port is taken by another app (it showed up in Claude
  Code only as "failed to connect") — it keeps answering from the last synced data and retries the
  port. The plugin's bundled server starts unconditionally instead of via a main-module path check
  that can misfire on some systems. New "Troubleshooting" section in `mcp-server/README.md`.
- **Claude Desktop: one-click download.** A GitHub Action builds the `.mcpb` on every server change
  and publishes it at a fixed link; Settings' assistant guide now opens on Claude Desktop with a
  Download button. The Claude Code tab says its `/plugin` commands are for Claude Code in a terminal
  on the same computer as Chrome — not the Claude app or cloud sessions ("Plugins aren't available
  in this environment").
- **Tab groups on the dashboard.** "Group related tabs" made real Chrome tab groups, but only
  Chrome's tab bar showed them — the dashboard looked unchanged apart from a toast. A "Tab groups"
  section now lists every Chrome group (made here or by hand): its color and name, its tabs with
  reading time, and Go to group / Ungroup. Board rows get a dot in their group's color, and the
  page scrolls to the section after grouping. Stays in sync when groups change in Chrome.
- **Fixed: "Group related tabs" failing with "The model's response could not be parsed into valid
  groups."** Grouping's JSON reply went through the cleanup meant for one-line summaries (first
  line only, 220 characters, quotes stripped), so any reply formatted over several lines — what
  most models send — was destroyed before parsing. Grouping now reads the reply untouched,
  understands fenced / wrapped / `indices` variants, keeps the complete groups from a reply cut
  off mid-way, asks Claude for enough output (1,500 tokens; the self-hosted Pro proxy now honours
  this, capped) — and sends no output limit to OpenAI-compatible APIs, since newer OpenAI models
  reject `max_tokens` (HTTP 400: "use 'max_completion_tokens'"), and sends at most the 60 most recently used tabs. Clearer message when a model really
  does answer in the wrong format.
- **Security: web pages can no longer write to the local MCP server.** Its sync endpoint used to
  accept a POST from any origin, so any site open in your browser could replace the tab list your
  assistant reads with text of its own (verified: a plain `fetch(…, {mode: 'no-cors'})` from a web
  page did it). It now refuses non-extension `Origin`s, foreign `Host` headers (DNS rebinding) and
  non-JSON writes, and echoes only the extension's origin in CORS headers, never `*`. Update the
  plugin (`/plugin update` / `codex plugin marketplace upgrade`) or rebuild the `.mcpb`.
- Settings' assistant section now speaks plainly: "Share my tab history with AI assistants on this
  computer", a status of Off / Waiting for assistant / Connected, and the port under "Advanced".
- **Settings, redesigned to use the whole window**, with a sticky section menu. The MCP panel is
  now **Connect your AI assistant**: three steps (turn on sync → add Tab State to Claude Code,
  Codex, Claude Desktop, ChatGPT or any MCP client, with copy-paste commands → example questions)
  and a live status that turns green by itself once your assistant has started the server.
- **History page, redesigned to use the whole window.** Two panes: the list on the left, a
  details panel on the right that follows the hovered or ↑/↓-selected tab (click pins it; Enter
  or double-click jumps to / reopens the tab) and lists your other visits to the same site.
  Repeat visits fold into one row per site ("chatgpt.com · 8 tabs · 54s"), sorted by reading
  time. Each day opens with a "where your reading time went" bar (top 4 sites + other, labelled,
  click a site to filter to it). Toolbar: search (titles, sites, URLs, notes), bucket filters,
  and "Hide quick visits (<10s)" — on by default, never hides a noted tab. Narrow windows get
  one column with the details as a bottom sheet.
- **Compact dashboard cards.** Every tab is a single 30px row (favicon, title, and one number:
  reading time, scroll depth, or "unread"), so a column shows roughly 3–4x more tabs than before
  without scrolling. Hovering a row (after a short intent delay, so sweeping the pointer across
  the list stays calm) or tabbing onto it opens the full card *over* the rows below instead of
  pushing them down — nothing else in the list moves. Near the bottom of a column the open card
  shifts up to stay fully visible. Click or tap a row to pin it open (hover isn't available on
  touch); Esc closes it. Card actions are now quiet icon+label buttons (Jump to tab · Note ·
  Watch · ✕) that fit on one line. Respects `prefers-reduced-motion`. Each board column scrolls
  on its own; the same rows are used in Recently closed, Follow Up, and History.
- The tab in front of you is now picked up the moment the extension's background worker starts
  (browser restart, extension update, or Chrome waking the worker), instead of waiting for the
  next tab event or the 30s heartbeat.
- Deep Focus now requires the tab to have been active for at least 30s (editable) before a
  copy/highlight alone can force that classification — previously any highlight did, however
  brief the visit, including an easily-accidental one.
- Optional local MCP server (`mcp-server/`) so Claude or another MCP client can answer questions
  like "what was I reading about X last week?" from your tracked tabs. Off by default; the
  extension only syncs to it if you turn it on in Settings, and it never leaves your machine. See
  [`mcp-server/README.md`](mcp-server/README.md). For Claude Desktop it can be packed into a
  one-click `.mcpb` installer (`cd mcp-server && npm run build:mcpb`) — no npm install or config
  editing on the user's side.
- **Claude Code + Codex plugin** (`plugins/tab-state/`), installable straight from this repo
  (`/plugin marketplace add asyau/tab-state`, `codex plugin marketplace add asyau/tab-state`). One
  folder serves both: the MCP server bundled into a single file (Node 18+, no `npm install`) plus
  a `tab-history` skill. CI checks the bundle is rebuilt whenever the server changes.
- **ChatGPT support via remote mode** (`npm run remote` in `mcp-server/`): the same read-only
  tools over Streamable HTTP on a separate local port, behind a random 256-bit token URL, for you
  to expose with a tunnel. The extension's sync endpoint is never served there.
- MCP server: several assistants can now run at once — a second copy shares the sync port's data
  instead of exiting, and takes the port over if the first one quits.
- Store screenshots now show real site favicons (the extension itself always used Chrome's
  favicon cache for real icons; the test pages just didn't have any).
- Optional self-hosted "Tab State Pro" tier (`pro-proxy/`): a new hosted provider that needs no
  API key, gated by an ExtensionPay subscription, backed by a Cloudflare Worker you deploy
  yourself. See [`pro-proxy/README.md`](pro-proxy/README.md), including its security model.
