# Launch posts

Ready to copy. Replace `[STORE LINK]` with the Chrome Web Store URL once it's live (until then
use `https://github.com/asyau/tab-state`). Edit anything that isn't true for you before posting.
Images are in `docs/screenshots/`.

Ground rules that keep launches from backfiring: don't state install counts or reviews you don't
have, answer every early comment within the hour, and ask a real question at the end.

---

## X: single post  (attach `1-dashboard.png`)

```
Tab managers sort tabs by what a page is.

The tab that matters is the one you actually read.

Tab State sorts by what you did: glanced, skimmed, deep-read, or never opened. It remembers where you stopped.

Free, open source, all local.

[STORE LINK]
```

## X: thread

**1/7** (attach `1-dashboard.png`)
```
Tab managers sort tabs by what a page is: work, social, news.

But the tab that matters isn't a category. It's the one you actually read.

So I built Tab State: it sorts your tabs by how you used them, and remembers where you stopped. 🧵
```

**2/7**
```
How it works:

• active time, counted only while the tab is focused
• how far you scrolled
• whether you copied or highlighted anything

That puts every tab in one of four buckets: Just Glanced, Partially Read, Deep Focus, or Ghost (never really looked at).
```

**3/7** (attach `2-detail.png`)
```
Every card gets one sentence that starts with what the page is about:

"A robotics simulator for training AI-driven robots. — Barely opened (under 2s) and never read."

Click a card and you see where you stopped, what you copied, and can ask for a deeper AI insight.
```

**4/7** (attach `3-purge-confirm.png`)
```
The payoff: after a meeting or a weekend, one click closes every Ghost and Glanced tab.

It asks first, there's a 30-second undo, and it never touches pinned tabs, the tab you're on, or anything you've put a note on.
```

**5/7**
```
Notes are the part I use most.

Type "want to actually learn this" on a card and Tab State will never suggest closing it, however little you looked at it.

There's also a daily check-list for sites you want to open every day.
```

**6/7**
```
Privacy, since it watches your browsing:

• no account, no analytics, no server
• everything stays in your browser
• AI is optional: on-device Gemini Nano, or your own OpenAI / Anthropic / Ollama
• a cloud provider gets titles and stats, never page text or what you selected
```

**7/7**
```
It's free and MIT-licensed.

Store: [STORE LINK]
Code: https://github.com/asyau/tab-state

What would you want it to track that it doesn't? I'm collecting ideas for v1.1.
```

---

## Threads  (attach `1-dashboard.png`; keep under 500 characters)

```
Most tab managers sort tabs by what a page is. But the tab that matters is the one you actually read.

Tab State sorts by what you did: glanced, skimmed, read and copied something, or never opened. It remembers where you stopped, and lets you close the rest in one click (with undo).

Free, open source, everything stays in your browser.

[STORE LINK]

What would you want it to notice about how you browse?
```

---

## Show HN

**Title:** `Show HN: Tab State – sorts your tabs by how you used them, not what they are`

**Text:**
```
Hi HN. Tab managers I've seen group tabs by what a page is (domain, category, keywords). What I
actually want after a long research session is "which of these did I read, and where did I stop?"
So Tab State classifies each tab by behavior: active time (only while focused), scroll depth, and
copy/highlight activity, into Just Glanced / Partially Read / Deep Focus / Ghost. Each card gets a
one-line summary and, on click, where you stopped.

A few things I found interesting to build:

- MV3 service workers get killed constantly, so time is never a running counter. A focused tab
  stores a timestamp and a heartbeat caps how far a segment can be back-dated, so a closed laptop
  adds seconds rather than hours.
- Chrome's idle state fires after ~60s without input, which is exactly what deep reading looks like,
  so only a locked screen pauses tracking.
- It watches browsing, so privacy is the product: everything is local. AI is optional (on-device
  Gemini Nano, or your own OpenAI-compatible / Anthropic key). A cloud provider gets titles and
  numbers, never page text or your selection, and there are tests that assert that.

It's MIT: https://github.com/asyau/tab-state
I'd especially like to hear where the bucket thresholds feel wrong for how you read.
```

---

## Reddit: r/chrome_extensions  (attach `1-dashboard.png`)

**Title:** `I made a tab manager that sorts by how you used a tab instead of what it is (free, open source)`

```
Tab State tracks active reading time, scroll depth and copy/highlight activity per tab and sorts
them into Just Glanced / Partially Read / Deep Focus / Ghost, with a one-line summary of what the
page is about and where you stopped.

- one-click purge of Ghost + Glanced tabs, with confirm and undo
- notes on a tab exempt it from ever being purged
- session recap and a daily check-list
- no account, everything local; AI is optional and bring-your-own-key

Code (MIT): https://github.com/asyau/tab-state
Store: [STORE LINK]

Feedback welcome, especially anything that breaks on sites you use every day.
```

---

## Product Hunt

**Name:** Tab State
**Tagline** (60 chars max): `Tabs sorted by how you used them, not what they are`
**Description** (260 chars max):
```
Tab State sorts your open tabs by behavior (glanced, skimmed, deep focus, never opened) and remembers where you stopped. Close the clutter in one click, with undo. Free, open source, and everything stays in your browser.
```
**First comment:**
```
Maker here. I built this because category-based tab managers can't tell a tab you studied from one
you never opened. Everything runs locally; AI summaries are optional and bring-your-own-key. I'd
love to know which behaviors you'd want it to notice next.
```

---

## LinkedIn

```
A small thing I built: Tab State, a Chrome extension that sorts your tabs by how you actually used
them (glanced at, skimmed, read closely, never opened) instead of by what they are.

After a meeting or a weekend, it shows the few tabs that mattered and where you stopped, and closes
the rest in one click, with undo. It's free, open source, and everything stays in your browser.

[STORE LINK]

If you research for a living, what would make this useful to you?
```
