// Compact cards: each card is a fixed one-line row in the list, and its full content opens as an
// overlay on top of the rows below it (see .card-body in styles.css). Because the row's slot never
// changes height, opening a card never moves any other card — which is what made the old
// grow-in-place version jumpy (the card under the pointer slid away as the one above it grew).
//
// Open state is a class, not :hover, so that every visual change (height, title wrap, shadow,
// content fade) starts together after one hover-intent delay, and so it can be kept across the
// dashboard's periodic full re-renders. Keyboard focus opens a card via :focus-within in CSS, with
// no delay. Click/tap on the row pins it open, since hover alone isn't available on touch.

const OPEN_DELAY_MS = 120; // sweeping the pointer across the list shouldn't open every row it crosses
const EDGE_GAP = 8;

let hovered = null; // the card under a mouse pointer
let timer = 0;

const cardOf = (el) => el?.closest?.('.card');

function scrollBoundsOf(card) {
  let top = 0;
  let bottom = window.innerHeight;
  for (let el = card.parentElement; el && el !== document.body; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden') {
      const r = el.getBoundingClientRect();
      top = Math.max(top, r.top);
      bottom = Math.min(bottom, r.bottom);
      break;
    }
  }
  return { top, bottom };
}

/** Near the bottom of its column, shift the open card up just enough to stay fully visible rather
 *  than get clipped by the column's scroll box (or the window). */
function fit(card) {
  const body = card.querySelector('.card-body');
  const more = card.querySelector('.card-more');
  if (!body || !more) return;
  const slot = card.getBoundingClientRect();
  // Collapsed, .card-more is a 0-height grid row, but its scrollHeight is still its natural height;
  // + ~one line for the title wrapping onto a second line when open.
  const height = body.offsetHeight + more.scrollHeight + 20;
  const { top, bottom } = scrollBoundsOf(card);
  const overflow = slot.top + height - (bottom - EDGE_GAP);
  const shift = overflow > 0 ? -Math.min(overflow, Math.max(0, slot.top - top - EDGE_GAP)) : 0;
  card.style.setProperty('--shift', `${Math.round(shift)}px`);
}

function open(card) {
  fit(card);
  card.classList.add('is-open');
}

function close(card) {
  card.classList.remove('is-open', 'pinned');
}

function closePinned(except) {
  document.querySelectorAll('.card.pinned').forEach((c) => { if (c !== except) close(c); });
}

export function initCardPeek() {
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const card = cardOf(e.target);
    if (card === hovered) return;
    if (hovered && !hovered.classList.contains('pinned')) close(hovered);
    clearTimeout(timer);
    hovered = card;
    if (card) timer = setTimeout(() => { if (hovered === card) open(card); }, OPEN_DELAY_MS);
  });

  document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse' || !hovered) return;
    if (cardOf(e.relatedTarget) === hovered) return;
    clearTimeout(timer);
    if (!hovered.classList.contains('pinned')) close(hovered);
    hovered = null;
  });

  // Click/tap on the row itself (not a control inside it) pins the card open; again to unpin.
  document.addEventListener('click', (e) => {
    const card = cardOf(e.target);
    closePinned(card);
    if (!card || e.target.closest('button, a, input, textarea, select, label, [role="button"], .favicon')) return;
    if (card.classList.contains('pinned')) close(card);
    else { open(card); card.classList.add('pinned'); }
  });

  document.addEventListener('focusin', (e) => {
    const card = cardOf(e.target);
    if (card) fit(card);
  });
  document.addEventListener('focusout', (e) => {
    const card = cardOf(e.target);
    if (card && !card.contains(e.relatedTarget)) card.classList.remove('dismissed');
  });

  // Capture phase, so an Escape that closes the details dialog is seen while it's still open (and
  // ignored here) rather than after it has put focus back into a card.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || document.querySelector('.modal:not([hidden])')) return;
    const card = cardOf(document.activeElement) || document.querySelector('.card.is-open');
    if (!card) return;
    close(card);
    if (card.contains(document.activeElement)) card.classList.add('dismissed');
  }, true);
}

/** Focus a control inside a card that may be collapsed (its details are visibility:hidden, so
 *  can't take focus directly): open it instantly, focus, and let :focus-within hold it open. */
export function focusInCard(el) {
  const card = cardOf(el);
  if (!card || card.classList.contains('is-open')) { el?.focus(); return; }
  card.classList.add('no-anim', 'is-open');
  el.focus();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    card.classList.remove('no-anim');
    if (card !== hovered) card.classList.remove('is-open');
  }));
}

function regionOf(card) {
  const parent = card.parentElement;
  if (parent?.id) return `#${parent.id}`;
  const group = card.closest('[data-bucket], [data-day]');
  if (group?.dataset.bucket) return `[data-bucket="${group.dataset.bucket}"]`;
  if (group?.dataset.day) return `[data-day="${group.dataset.day}"]`;
  return '';
}

/** Cards are rebuilt from scratch on every render. Remember which ones were open... */
export function captureOpen() {
  return [...document.querySelectorAll('.card.is-open, .card:focus-within')].map((c) => ({
    region: regionOf(c),
    id: c.dataset.id,
    wasOpen: c.classList.contains('is-open'),
    pinned: c.classList.contains('pinned'),
    shift: c.style.getPropertyValue('--shift'),
    hovered: c === hovered,
  }));
}

/** ...and reopen their replacements instantly (no animation), so a background refresh doesn't
 *  make the card under the pointer — or the one in use by keyboard — collapse and reopen. Call
 *  before restoring focus: a collapsed card's controls are visibility:hidden, so can't take focus;
 *  once focus is back inside, :focus-within keeps it open and the temporary class comes off. */
export function restoreOpen(list) {
  for (const o of list) {
    const card = document.querySelector(`${o.region} .card[data-id="${CSS.escape(o.id)}"]`);
    if (!card) continue;
    card.classList.add('no-anim', 'is-open');
    if (o.pinned) card.classList.add('pinned');
    if (o.shift) card.style.setProperty('--shift', o.shift);
    if (o.hovered) hovered = card;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      card.classList.remove('no-anim');
      if (!o.wasOpen && hovered !== card) card.classList.remove('is-open');
    }));
  }
}
