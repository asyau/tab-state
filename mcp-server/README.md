# tab-state-mcp

A local [MCP](https://modelcontextprotocol.io) server that lets Claude (or any other MCP client)
answer questions like *"what was I reading about Rust async last week?"* or *"summarize my browsing
session"* — using the reading history the [Tab State](../README.md) Chrome extension already
tracks.

It runs entirely on your machine. The extension pushes a snapshot of your tracked tabs to it over
`http://127.0.0.1`, and it never talks to anything outside your computer.

```
Chrome (Tab State extension)  --POST /sync-->  tab-state-mcp (this process)  <--stdio-->  Claude
                                                        |
                                                        v
                                              ~/.tab-state-mcp/data.json
```

## Install & run

```bash
cd mcp-server
npm install
npm start
```

This starts two things in one process:

- An HTTP listener on `http://127.0.0.1:8765` (`/sync`) that the extension posts your tracked tabs
  to. Nothing but the Tab State extension, running in your own browser, should ever call this.
- An MCP server connected over stdio, for a client (Claude Desktop, Claude Code, etc.) to talk to.

Leave it running in a terminal, or let your MCP client launch it for you (see below). Your data is
stored at `~/.tab-state-mcp/data.json`, created with `0600` permissions (owner read/write only) in
a `0700` directory.

Set `TAB_STATE_MCP_PORT` to use a different port than 8765 — and match it in the extension's
**Settings → MCP server** panel.

## Connect it to Chrome

1. Start the server (`npm start` in this folder), or leave your MCP client to start it.
2. In the Tab State extension, open **Settings → MCP server (local, optional)**.
3. Check **"Sync your tracked tabs to a local MCP server"**. It's off by default — nothing is sent
   anywhere unless you turn this on.
4. The status line confirms it's reachable. Tab State syncs automatically on its normal ~30s
   heartbeat from then on, while the extension is running.

## Connect it to Claude Desktop or Claude Code

Add it as an MCP server, pointing at this folder's `server.mjs`. For **Claude Desktop**, edit its
config (`claude_desktop_config.json`) and add:

```json
{
  "mcpServers": {
    "tab-state": {
      "command": "node",
      "args": ["/absolute/path/to/tab-state/mcp-server/server.mjs"]
    }
  }
}
```

For **Claude Code**, run:

```bash
claude mcp add tab-state -- node /absolute/path/to/tab-state/mcp-server/server.mjs
```

Restart the client afterward. It will start `server.mjs` itself (over stdio) whenever it needs the
tools below — you don't need to also run `npm start` by hand in that case, though it doesn't hurt
to leave it running.

## Tools exposed to the MCP client

| Tool | What it does |
|---|---|
| `list_tabs` | Lists synced tabs, optionally filtered by bucket (`glanced`/`partial`/`deep`/`ghost`) and open/closed, most recent first. |
| `search_tabs` | Case-insensitive search over title, description, note and URL. |
| `get_tab` | Looks up one tab by id, or by an exact or partial URL. |
| `get_session_recap` | Returns the same one-line session recap shown on the dashboard, plus counts per bucket. |

Every tool reads from the last snapshot the extension synced — it's a point-in-time picture of your
open (and recently closed) tabs, not a live feed.

## What gets synced, and what doesn't

Per tab: id, URL, title, description, your note, its bucket, its summary, active time, scroll
percentage, timestamps, and open/closed state — the same fields already shown on the dashboard.
Titles, descriptions and notes are truncated the same way the rest of the extension truncates them.

Raw page text and anything you selected/highlighted are **never** included — the extension only
ever sends what's already visible on the dashboard card, nothing content scripts capture. See the
main [privacy policy](../PRIVACY.md) for the full picture of what the extension does and doesn't
send, and to what.

## Development

```bash
npm test          # node:test — store round-trips, permissions, and a real MCP client/server pair
```

`test/manual-subprocess-check.mjs` is a standalone diagnostic (not part of `npm test`) that spawns
`server.mjs` as a real child process, sends it a genuine MCP `initialize` handshake, and checks the
HTTP endpoint concurrently — useful when something about the "run as a script" startup path is
suspect, since a bug there can fail silently (the process just exits with no output).

## Uninstall / reset

Delete `~/.tab-state-mcp/` to remove all synced data. Turning off the sync toggle in the extension
stops new data from being sent, but doesn't delete what's already there.
