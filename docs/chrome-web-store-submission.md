# Chrome Web Store submission — copy-paste reference

Everything below is text to paste into the [Developer Dashboard](https://chrome.google.com/webstore/devconsole)
when you submit. Nothing here requires code changes — it's the paperwork.

## Store listing

**Name:** Tab State

**Summary** (132 chars max):
> Sorts your tabs by how you actually used them — glanced, skimmed, or deep focus — and
> remembers exactly where you stopped.

**Description:**
> Tab State tracks the state of your mind, not just your tabs. It watches how long you actively
> read a page, how far you scrolled, and whether you copied or highlighted anything — then sorts
> every tab into Just Glanced, Partially Read, Deep Focus, or Ghost on a dashboard, with a
> one-line summary of what you did and where you stopped.
>
> Unlike tab managers that group by site or keyword, Tab State never guesses what a page is —
> it tracks how you engaged with it, so the same site can land in a different column depending
> on whether you actually read it.
>
> • Compact one-line rows: see every tab at once; hover one for its full card
> • A one-line summary on every card that starts with what the page is about
> • Details for any tab: where you stopped, what you copied, and an on-demand AI insight
> • Full history, kept forever: every tab by day, repeat visits grouped by site, a bar of where
>   your reading time went, search and filters
> • Purge Ghost & Glanced tabs in one click, with undo
> • Follow-up notes that exempt a tab from ever being purged
> • A daily check-list, a one-line session recap, editable sort thresholds
> • Optional AI tab grouping — proposes groups, you confirm, they appear on the dashboard and in
>   Chrome's tab bar
> • Optional: ask your AI assistant about your tabs — "what was I reading about X last week?" —
>   with Claude Desktop, Claude Code or Codex, through a small helper on your own computer
> • Works with zero setup — on-device AI (Gemini Nano) or a built-in summary by default; bring
>   your own OpenAI-compatible or Anthropic API key for smarter summaries
> • Private by design: no accounts, no analytics, nothing sent anywhere unless you turn on an AI
>   feature yourself
>
> Free and open source: github.com/asyau/tab-state

**Category:** Productivity

**Privacy policy URL:** https://github.com/asyau/tab-state/blob/main/PRIVACY.md

## Privacy practices tab (data disclosures)

Tick these to match `PRIVACY.md`:

| Data type | Tick? | Why |
|---|---|---|
| Web history | **Yes** | URLs and titles of tabs, to identify and label each tracked tab |
| User activity | **Yes** | Active reading time, scroll depth, copy/highlight/link-click counts — how tabs are sorted |
| Website content | **Yes** | Page title, description, the heading nearest where you stopped, and the last selected text (kept on-device; the selected text is never sent anywhere) |
| Personally identifiable info | No | — |
| Health, Financial, Personal communications, Location | No | — |
| Authentication info | No | The user's own AI API key, if they add one, is stored locally and sent only to that provider — never to Tab State |

All of it is stored locally. It leaves the device only through features the user turns on: an AI
provider they configure, or sharing with an AI assistant on their own computer (see `PRIVACY.md`).

**Certifications** (tick all three): not sold to third parties; not used or transferred for
purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.

**Single purpose declaration** (paste as-is):
> Tab State tracks how a user engages with each browser tab (active time, scroll depth, and
> interactions) and organizes tabs into a dashboard sorted by that engagement, so the user can
> find what they were reading and safely close what they never opened.

**"Are you using remote code?"** No.

## Permission justifications

Paste one line per permission where the dashboard asks for a justification:

| Permission | Justification |
|---|---|
| `tabs` | Read each tab's URL, title, and lifecycle events (created/updated/removed) to identify which page a tab shows and when it opens, navigates, or closes — the core of what the extension tracks. |
| `tabGroups` | Creates and labels Chrome tab groups only when the user clicks "Group related tabs" and confirms the proposed groups (an optional, off-by-default feature), and reads the user's tab groups to show them on the dashboard. Never groups tabs automatically. |
| `storage` | Stores tracked tab records, user settings, and the daily check-list locally via `chrome.storage.local`, and a temporary session marker via `chrome.storage.session`. No data leaves the device through this permission. |
| `unlimitedStorage` | Tab history is kept indefinitely (the History page), which can exceed `chrome.storage.local`'s default 10MB cap for an active user over months of use. Still 100% local — this only raises the on-device storage ceiling, it doesn't change what's collected or send anything anywhere. |
| `idle` | Detects when the screen is locked, so the active-reading-time clock pauses appropriately. The extension does not pause on ordinary mouse/keyboard inactivity, since long, still reading is exactly the behavior it's meant to catch. |
| `alarms` | A recurring ~30-second background heartbeat that keeps the active-time clock accurate despite Chrome suspending the extension's service worker between events. |
| `scripting` | Injects the content script into tabs that were already open at install/update time, so tracking starts immediately without needing a page reload. |
| `favicon` | Shows each tracked tab's site icon on the dashboard via Chrome's internal favicon cache, avoiding a separate network request per icon. |
| Host permission `<all_urls>` | The extension's purpose is tracking engagement on whatever page the user visits, which cannot be known in advance — it needs to run its content script and read tab URLs on any site. It also lets the extension reach, only when the user turns the matching feature on: the AI provider URL the user configured in Settings (OpenAI-compatible or Anthropic API, or a local server such as Ollama), and the Tab State helper on the user's own computer at `http://127.0.0.1` (ports 47651–47655 / 8765) for the optional "Share your tabs with AI assistants" feature. |

## Developer account

- One-time $5 registration fee at the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) — your Google account, your payment method.
- This is a step only you can do (Claude cannot enter payment details or create accounts on your behalf).

## Assets checklist

- [x] Icons (16/32/48/128px) — in `icons/`
- [x] Screenshots, 1280×800px, **max 5** — upload in this order: `docs/screenshots/1-dashboard.png`, `6-tab-groups.png`, `5-history.png`, `2-detail.png`, `3-purge-confirm.png` (`4-settings.png` is for the README only)
- [x] Small promo tile, 440×280px — `docs/promo/small-tile-440x280.png`
- [x] Marquee image, 1400×560px — `docs/promo/marquee-1400x560.png` (only used for featured placement)
- [x] Upload package — `npm run package` builds `dist/tab-state-<version>.zip`
- [ ] Regenerate all of the above after any UI change: `npm run screenshots && npm run promo`

**"Test instructions" field for reviewers** (paste as-is):
> No account or login needed. Install, open a few normal websites in different tabs and read one
> of them for a minute (scroll, select some text). Click the toolbar icon to open the dashboard:
> each tab appears as a row in Just Glanced / Partially Read / Deep Focus / Ghost — hover a row
> for its full card, click the domain line for details. "History" (top right) lists every tab by
> day. All AI features are optional and off until configured in Settings. "Share your tabs" in
> Settings is also off by default: when on, the extension contacts a helper program on the
> user's own computer at http://127.0.0.1 (ports 47651–47655, or 8765 for older helpers) and
> nothing else; without that helper installed it simply shows "Waiting for assistant".

## Before you click submit

1. Re-read `PRIVACY.md` once more and confirm it still matches what the code actually does.
   Keep `PRO_TIER_ENABLED` (in `lib/extpay.js`) **false** for this submission — the Pro tier isn't
   live, and an option that can't work is a common rejection reason.
2. Load the unpacked extension one more time and click through the full flow yourself
   (see [README.md](../README.md) → "Testing it for real in Chrome").
3. Expect review to take anywhere from a few hours to a few days — `<all_urls>` + broad
   permissions commonly trigger manual review.
