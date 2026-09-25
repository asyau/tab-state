# Tab State — Privacy Policy

_Last updated: 2026-09-23_

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
`chrome.storage.local` API. Nothing is uploaded anywhere by default. Closed tabs with low
engagement are forgotten automatically after about an hour; all closed-tab records are forgotten
after 7 days. You can delete everything at any time from **Settings → Delete all tracked data**.

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

## Limited Use disclosure

Tab State's use of any data obtained through a connected AI provider adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements: data is used only to produce the summaries, recap,
insights or grouping you asked for, is not sold, is not used for advertising, and is not used for any purpose unrelated to
that single, disclosed feature.

## What Tab State does not do

- No accounts, no sign-in, no analytics, no tracking pixels, no advertising SDKs
- No data is sold, shared, or used for any purpose other than showing it back to you
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
