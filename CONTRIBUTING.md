# Contributing to Tab State

Thanks for helping! Bug reports, ideas, docs fixes and code are all welcome — you don't need to
write code to contribute.

- 🐛 **Found a bug?** [Open a bug report](https://github.com/asyau/tab-state/issues/new?template=bug_report.yml)
- 💡 **Have an idea?** [Suggest a feature](https://github.com/asyau/tab-state/issues/new?template=feature_request.yml)
- 🔒 **Found a security or privacy problem?** Please **don't** open a public issue — see [SECURITY.md](SECURITY.md).
- 🧑‍💻 **Want to write code?** Look for issues labelled
  [`good first issue`](https://github.com/asyau/tab-state/labels/good%20first%20issue) or
  [`help wanted`](https://github.com/asyau/tab-state/labels/help%20wanted), and comment that you're
  taking it so nobody duplicates work.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting a bug well

The more of this you include, the faster it gets fixed:

- What you did, what you expected, what happened instead
- Chrome version (`chrome://version`) and your OS
- Tab State version (on `chrome://extensions`)
- Which summary provider you use (Settings → Summary provider), if the bug involves summaries,
  recap, insights or grouping
- For the AI-assistant feature: which assistant (Claude Desktop / Claude Code / Codex / ChatGPT) and
  what `node --version` prints
- Errors, if any: on `chrome://extensions`, turn on Developer mode, then click **Errors** or
  **service worker** on the Tab State card and copy what you see
- A screenshot if it's visual — please blur anything private (tab titles are personal!)

## Development setup

No build step: the extension is plain JavaScript modules that Chrome loads directly.

```bash
git clone https://github.com/asyau/tab-state.git
cd tab-state
npm install                      # Playwright, for the browser tests only
npx playwright install chromium  # once
```

Load it in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → the `tab-state`
folder. After changing code, click ↻ on the extension's card (and reload the dashboard tab).

The optional MCP server / AI-assistant plugin lives in `mcp-server/` and has its own
dependencies: `cd mcp-server && npm install`.

## Tests

Please run these before opening a pull request:

```bash
npm test                      # unit tests + manifest/package checks (fast, no browser)
npm run test:e2e              # drives the real extension in Chromium: board, history, settings,
                              # grouping, and sync to the real MCP server
cd mcp-server && npm test     # MCP server, remote mode, the plugin bundle
```

CI runs `npm test` and the MCP server tests on every push and pull request.

Changed `mcp-server/server.mjs` or `store.mjs`? Rebuild the plugin bundle with
`cd mcp-server && npm run build:plugin` and commit it — a test fails if it's stale.

Changed the UI? Regenerate the screenshots with `npm run screenshots` if they're affected.

## Pull requests

1. Fork, then branch from `main` (`fix/…` or `feat/…`).
2. Keep a pull request to one change — small ones get reviewed quickly.
3. Add or update a test for behaviour you change. A bug fix is best with a test that failed before it.
4. Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for anything users would notice.
5. Open the pull request and fill in the template.

## House rules for the code

- **Privacy first.** Tab State never sends page body text or text the user selected to any cloud
  service, and nothing leaves the device unless the user turns a feature on. New features must keep
  that promise — and if a change affects what data goes where, update [PRIVACY.md](PRIVACY.md) in
  the same pull request.
- **Match the surrounding code**: plain ES modules, no frameworks, no new dependencies in the
  extension without discussing it in an issue first. Comments explain *why*, not *what*.
- **Accessible by default**: real buttons and labels, keyboard-operable, visible focus, respects
  `prefers-reduced-motion`, works in dark mode.
- **New Chrome permissions** need a strong reason and a justification line in
  [docs/chrome-web-store-submission.md](docs/chrome-web-store-submission.md) (a test enforces this).

## Where things are

See **Project layout** in the [README](README.md) (under the fold) — in short: `lib/tracker.js`
is the engine, `ui/` holds the dashboard, History and Settings pages, `ai/` the AI providers, and
`mcp-server/` + `plugins/` the AI-assistant integration.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
