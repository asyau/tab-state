// Runs in every web page. Measures scroll depth, highlights, copies and link clicks,
// works out where the reader stopped, and sends a heartbeat while the page is in view.
// Plain script (content scripts can't be ES modules); guarded so re-injection is harmless.

(() => {
  if (window.__tabStateContent) return;
  window.__tabStateContent = true;
  if (window.top !== window) return; // top frame only

  const PING_MS = 15_000;
  const SCROLL_DEBOUNCE_MS = 700;
  const MIN_SELECTION_CHARS = 20;

  let alive = true;
  let pageUrl = location.href;
  let maxPct = 0;
  let lastSentPct = -1;
  let lastAnchorKey = '';
  let scrollTimer = null;

  function send(msg) {
    if (!alive) return;
    try {
      if (!chrome.runtime?.id) throw new Error('context invalidated');
      chrome.runtime.sendMessage({ ...msg, url: location.href }).catch(() => {});
    } catch {
      // The extension was reloaded or removed; this script is orphaned.
      alive = false;
      teardown();
    }
  }

  function pageChanged() {
    // SPA navigation (pushState): start fresh for the new page.
    if (location.href.split('#')[0] === pageUrl.split('#')[0]) return false;
    pageUrl = location.href;
    maxPct = 0;
    lastSentPct = -1;
    lastAnchorKey = '';
    sendMeta();
    return true;
  }

  // --- Scroll depth -------------------------------------------------------

  function scrollPct() {
    const doc = document.documentElement;
    const body = document.body;
    const total = Math.max(doc.scrollHeight, body ? body.scrollHeight : 0);
    if (!total) return 0;
    const bottom = window.scrollY + window.innerHeight;
    return Math.min(100, Math.round((bottom / total) * 100));
  }

  // --- "Where did you stop?" anchor ----------------------------------------

  function textOf(el, max) {
    return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function headingAbove(y) {
    let best = null;
    for (const h of document.querySelectorAll('h1, h2, h3, h4')) {
      const top = h.getBoundingClientRect().top;
      if (top <= y) best = h;
      else break;
    }
    return best;
  }

  function computeAnchor() {
    const y = window.innerHeight * 0.4;
    let el = null;
    for (const x of [0.5, 0.35, 0.65]) {
      const hit = document.elementFromPoint(window.innerWidth * x, y);
      if (hit && hit !== document.body && hit !== document.documentElement) {
        el = hit;
        break;
      }
    }
    const heading = textOf(headingAbove(y), 120);
    if (!el) return heading ? { kind: 'heading', heading, snippet: '' } : null;

    const block = el.closest('pre, code, table, h1, h2, h3, h4, p, li, blockquote');
    if (!block) return heading ? { kind: 'heading', heading, snippet: '' } : null;
    const tag = block.tagName.toLowerCase();
    let kind = 'text';
    if (tag === 'pre' || tag === 'code') kind = 'code';
    else if (tag === 'table') kind = 'table';
    else if (/^h[1-4]$/.test(tag)) kind = 'heading';

    return {
      kind,
      heading: kind === 'heading' ? textOf(block, 120) : heading,
      snippet: textOf(block, 120),
    };
  }

  function reportScroll(force) {
    if (pageChanged()) force = true;
    maxPct = Math.max(maxPct, scrollPct());
    const anchor = computeAnchor();
    const anchorKey = anchor ? `${anchor.kind}|${anchor.heading}|${anchor.snippet}` : '';
    if (!force && maxPct < lastSentPct + 2 && anchorKey === lastAnchorKey) return;
    lastSentPct = maxPct;
    lastAnchorKey = anchorKey;
    send({ type: 'ts:scroll', pct: maxPct, anchor });
  }

  function onScroll() {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => reportScroll(false), SCROLL_DEBOUNCE_MS);
  }

  // --- Interactions ----------------------------------------------------------

  function selectionText() {
    return (window.getSelection()?.toString() || '').replace(/\s+/g, ' ').trim();
  }

  function onCopy() {
    pageChanged();
    send({ type: 'ts:interaction', kind: 'copy', snippet: selectionText().slice(0, 200), anchor: computeAnchor() });
  }

  let lastHighlight = '';
  function onMouseUp() {
    setTimeout(() => {
      const text = selectionText();
      if (text.length < MIN_SELECTION_CHARS || text === lastHighlight) return;
      lastHighlight = text;
      pageChanged();
      send({ type: 'ts:interaction', kind: 'highlight', snippet: text.slice(0, 200), anchor: computeAnchor() });
    }, 0);
  }

  function onClick(e) {
    const a = e.target?.closest?.('a[href]');
    if (!a || a.getAttribute('href').startsWith('#')) return;
    send({ type: 'ts:interaction', kind: 'link' });
  }

  // --- Heartbeat + metadata -------------------------------------------------------

  function ping() {
    if (document.visibilityState === 'visible' && document.hasFocus()) {
      pageChanged();
      send({ type: 'ts:ping' });
    }
  }

  /**
   * A short line describing what the page is about, for the dashboard summary. Prefers the
   * real meta description; many pages don't have one, so falls back to the page's own <h1> —
   * still a short heading, not body content, same sensitivity as the reading-position anchor
   * already captured elsewhere in this file.
   */
  function pageDescription() {
    const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
    if (meta?.content?.trim()) return meta.content.trim();
    const h1 = document.querySelector('h1')?.innerText?.trim();
    return h1 || '';
  }

  function sendMeta() {
    send({ type: 'ts:meta', title: document.title, description: pageDescription().slice(0, 300) });
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden') reportScroll(true);
    else ping();
  }

  const pingTimer = setInterval(ping, PING_MS);
  const listeners = [
    [window, 'scroll', onScroll, { passive: true }],
    [document, 'copy', onCopy, true],
    [document, 'mouseup', onMouseUp, true],
    [document, 'click', onClick, true],
    [document, 'visibilitychange', onVisibility, false],
    [window, 'focus', ping, false],
  ];
  for (const [target, type, fn, opts] of listeners) target.addEventListener(type, fn, opts);

  function teardown() {
    clearInterval(pingTimer);
    clearTimeout(scrollTimer);
    for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
  }

  sendMeta();
  reportScroll(true);
  ping();
})();
