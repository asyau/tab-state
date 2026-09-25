# Changelog

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
