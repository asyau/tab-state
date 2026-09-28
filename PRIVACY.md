# Tab State — Privacy Policy

_Last updated: 2026-09-29_

Tab State is a Chrome extension that tracks how you engage with your open tabs (active reading
time, scroll depth, and interactions) so it can sort them on a dashboard and write a one-line
summary of what you did. This page explains exactly what that involves.

## What is collected

For each tab you have open, Tab State records:

- The page's **URL, title, domain**, and a short description of what it's about — its
  `<meta name="description">` tag if present, or its main `<h1>` heading if not
- **Active time**: how long the tab was focused and visible (not simply "open")
- **Scroll depth**: the furthest percentage down the page you reached
- **Interaction counts**: how many times you copied text, highlighted text, or clicked a link
- The **last text you selected** (up to 200 characters) and a short snippet of the heading, code
  block, or paragraph nearest where you stopped scrolling
- Any **note you choose to type** on a tab's card
- Which domains you've marked to check daily, and whether you've visited them today

Tab State never reads or stores the full text/body of any page — only the metadata and
engagement signals above.

## Where it's stored

Everything above is stored **locally in your browser**, using Chrome's built-in
`chrome.storage.local` API. Nothing is uploaded anywhere by default. Your tab history is kept
indefinitely — see it day by day on the **History** page — so nothing is silently forgotten. The
one exception: a tab you explicitly **Purge** is deleted about an hour later (long enough to
still Undo), since purging is a deliberate "forget this" action. You can delete everything at any
time from **Settings → Delete all tracked data**.

## When data leaves your device

By default, **nothing leaves your device**. Tab State's one-line summaries are written by a
deterministic, on-device sentence generator unless you explicitly turn on an AI provider:

- **On-device (Gemini Nano)**: runs entirely inside Chrome, on your machine. Nothing is sent
  anywhere.
- **An OpenAI-compatible API or the Anthropic API**, configured by you in Settings. If you turn
  one of these on, Tab State sends the following, and nothing else:
  - *Per-tab summaries and the "deeper insight" in the detail view* (only for tabs in Deep Focus
    or Partially Read, or when you click the insight button): the page's title, domain and
    description, your engagement numbers (active time, scroll depth, copy/highlight counts), the
    heading nearest where you stopped, and any note you wrote on the tab.
  - *The session recap line*: the titles and domains of your tracked tabs, each with its
    engagement label.
  - *"Group related tabs"* (off by default, only when you click it): the titles and domains of
    your open tabs.

  **Never sent to a cloud provider:** the page's body text, the text you selected, and the
  paragraph text near where you stopped. Those stay on your device (they are shown to you in the
  detail view, and only an on-device model can use them). You choose the provider and supply your
  own API key; Tab State has no server of its own and no access to what you send.

If you use a local model server (e.g. Ollama) as your "API," nothing leaves your machine either.

## Sharing with AI assistants on your computer (optional, off by default)

Settings → **Share your tabs** lets AI assistants that run on your own computer — Claude Desktop,
Claude Code, OpenAI's Codex, or any MCP client — answer questions about your tabs. It is **off**
until you turn it on, and you can turn it off at any time.

- **What is shared:** for each tracked tab, its URL, title, description, your note, its
  engagement label (e.g. Deep Focus) and one-line summary, active time, scroll percentage,
  timestamps, and whether it's open or closed — the same things shown on your dashboard — plus
  the session recap line. **Never** page body text, text you selected, or the text near where
  you stopped.
- **Where it goes:** only to the Tab State helper program running on your own computer, at
  `127.0.0.1` (your computer's own address), which saves it in a file in your home folder
  (`~/.tab-state-mcp/`) readable only by your user account. The extension finds that helper by
  asking a few fixed local ports whether they're Tab State, and sends nothing to anything that
  doesn't identify itself as Tab State. Web pages cannot send data to or read data from the helper.
- **What your assistant does with it:** when you ask your assistant a question, it reads what it
  needs through the helper and, like everything else in that conversation, sends it to that
  assistant's provider (for example Anthropic for Claude, or OpenAI for Codex) under **their**
  privacy terms. Tab State itself sends nothing to them.
- **ChatGPT (advanced, manual):** ChatGPT can only reach helpers on the internet, so using it means
  you start a separate "remote mode" yourself and run a tunnel (such as Cloudflare's) that makes
  the helper reachable at a secret web address you give to ChatGPT. While that tunnel runs, anyone
  with that full address can read the same shared data, and OpenAI receives what ChatGPT reads.
  Tab State never starts this on its own.

To stop sharing, untick **Share my tab history** in Settings; to delete what was shared, delete
the `~/.tab-state-mcp/` folder.

## Tab groups

If you use **Group related tabs**, Tab State creates Chrome tab groups for the tabs you confirm,
and the dashboard reads your tab groups (names, colors, which tabs are in them) to show them. This
stays in your browser; the only data sent anywhere for grouping is described above under your AI
provider.

## Limited Use disclosure

Tab State's use of any data obtained through a connected AI provider adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements: data is used only to produce the summaries, recap,
insights or grouping you asked for, is not sold, is not used for advertising, and is not used for any purpose unrelated to
that single, disclosed feature.

## What Tab State does not do

- No accounts, no sign-in, no analytics, no tracking pixels, no advertising SDKs
- No data is sold, shared with third parties, or used for any purpose other than showing it back
  to you (and, only if you turn them on, the AI features described above)
- No data collection continues after you uninstall the extension (local storage is cleared by
  Chrome when an extension is removed)

## Open source

Tab State's full source code is public and auditable at
[github.com/asyau/tab-state](https://github.com/asyau/tab-state) — everything described above
can be verified directly in the code, particularly `lib/tracker.js` (what's tracked and where
it's stored) and `ai/providers.js` (exactly what is sent to a cloud provider, and only when one
is configured).

## Contact

Questions about this policy or your data: open an issue at
[github.com/asyau/tab-state/issues](https://github.com/asyau/tab-state/issues), or email
asyaunal02@gmail.com.
