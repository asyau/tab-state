const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_eid|mc_cid|igshid|ref_src)$/i;

/** Pages we can meaningfully track (not chrome://, extension pages, about:blank, etc.). */
export function isTrackable(url) {
  return typeof url === 'string' && /^(https?|file):/i.test(url);
}

/**
 * Stable identity for a page: drops the #fragment and common tracking params
 * so the same article matches across reloads and browser restarts.
 */
export function normalizeUrl(url) {
  if (!isTrackable(url)) return null;
  try {
    const u = new URL(url);
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return null;
  }
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
