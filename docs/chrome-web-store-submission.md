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
> it only tracks how you engaged with it, so the same site can land in a different category
> depending on whether you actually read it.
>
> • Purge Ghost & Glanced tabs in one click, with undo
> • Follow-up notes that exempt a tab from ever being purged
> • A daily check-list for sites you want to remember to look at
> • Editable sort thresholds
> • Works with zero setup — on-device AI (Gemini Nano) or a deterministic built-in summary by
>   default; bring your own OpenAI-compatible or Anthropic API key for smarter summaries
> • 100% local. No accounts, no analytics, nothing sent anywhere unless you turn on a cloud AI
>   provider yourself
>
> Free and open source: github.com/asyau/tab-state

**Category:** Productivity

**Privacy policy URL:** https://github.com/asyau/tab-state/blob/main/PRIVACY.md

## Privacy practices tab (data disclosures)

Tick these to match `PRIVACY.md`:

| Data type | Collected? | Why |
|---|---|---|
| Web history / URLs | Yes | To identify and label each tracked tab |
| Website content | **No** | Only page titles/descriptions/metrics are read, never page content |
| Personally identifiable info | No | — |
| Authentication info | No (unless the user pastes their own API key into Settings — stored locally only, never transmitted to Tab State) | — |

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
| `tabGroups` | Used only by the optional, off-by-default "AI-assisted tab grouping" feature to create and label a Chrome tab group when the user explicitly clicks "Group related tabs." Never used automatically. |
| `storage` | Stores tracked tab records, user settings, and the daily check-list locally via `chrome.storage.local`, and a temporary session marker via `chrome.storage.session`. No data leaves the device through this permission. |
| `idle` | Detects when the screen is locked, so the active-reading-time clock pauses appropriately. The extension does not pause on ordinary mouse/keyboard inactivity, since long, still reading is exactly the behavior it's meant to catch. |
| `alarms` | A recurring ~30-second background heartbeat that keeps the active-time clock accurate despite Chrome suspending the extension's service worker between events. |
| `scripting` | Injects the content script into tabs that were already open at install/update time, so tracking starts immediately without needing a page reload. |
| `favicon` | Shows each tracked tab's site icon on the dashboard via Chrome's internal favicon cache, avoiding a separate network request per icon. |
| Host permission `<all_urls>` | The extension's purpose is tracking engagement on whatever page the user visits, which cannot be known in advance — it needs to run its content script and read tab URLs on any site. |

## Developer account

- One-time $5 registration fee at the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) — your Google account, your payment method.
- This is a step only you can do (Claude cannot enter payment details or create accounts on your behalf).

## Assets checklist

- [x] Icons (16/32/48/128px) — already in `icons/`
- [ ] At least 1 screenshot, 1280×800px (up to 5) — see `tests/e2e/output/store/`
- [ ] Small promo tile, 440×280px — optional but commonly expected; not yet made
- [ ] Marquee image, 1400×560px — optional, only for featured placement

## Before you click submit

1. Re-read `PRIVACY.md` once more and confirm it still matches what the code actually does.
2. Load the unpacked extension one more time and click through the full flow yourself
   (see [README.md](../README.md) → "Testing it for real in Chrome").
3. Expect review to take anywhere from a few hours to a few days — `<all_urls>` + broad
   permissions commonly trigger manual review.
