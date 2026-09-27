---
name: tab-history
description: Answer questions about what the user was reading or working on in Chrome — "what was I reading about X", "where did I stop on that article", "what did I spend today on", "find that tab about Y" — using the Tab State tools (search_tabs, list_tabs, get_tab, get_session_recap). Use whenever the user refers to their tabs, browsing, or something they read earlier and hasn't pasted it.
---

# Tab history (Tab State)

The `tab-state` MCP server exposes the user's own Chrome reading history, tracked locally by the
Tab State extension. Each tab has a **bucket** that says how it was actually used:

| bucket | meaning |
|---|---|
| `deep` | Deep Focus — read closely: long active time, far scroll, copied/highlighted text |
| `partial` | Partially Read — skimmed, not finished |
| `glanced` | Just Glanced — opened and left within seconds |
| `ghost` | never really looked at |

## How to answer

- **"What was I reading about X?"** → `search_tabs` with the topic; prefer `deep` and `partial`
  results, most recent first. Give title + URL and one line on how far they got (from the summary).
- **"Where did I stop / what did I copy?"** → find the tab (`search_tabs`), then `get_tab` for its
  full detail, and quote where they stopped.
- **"What did I do today / this session?"** → `get_session_recap`, then `list_tabs` with
  `bucket: "deep"` for the substance.
- **"Which tabs can I close?"** → `list_tabs` with `bucket: "ghost"` and `"glanced"`; never suggest
  closing a tab that has a note (the user flagged it to keep).

## If nothing comes back

The data comes from the extension syncing to this server. If the tools return nothing, tell the
user to open the Tab State extension's **Settings → MCP server** and turn on sync (and that Chrome
must be running with the extension). Don't guess at what they were reading.

Everything here is the user's private browsing history: answer what they asked, don't volunteer
unrelated tabs.
