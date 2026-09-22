import { THRESHOLDS, TIMING } from './config.js';

/**
 * Active time including a segment that is still running.
 * A running segment is capped at lastSeen + grace, same rule the tracker uses when it closes one.
 */
export function effectiveActiveMs(r, now = Date.now()) {
  let ms = r.activeMs || 0;
  if (r.activeSince != null) {
    const lastSeen = Math.max(r.lastSeen || 0, r.activeSince);
    const end = Math.min(now, lastSeen + TIMING.heartbeatGraceMs);
    ms += Math.max(0, end - r.activeSince);
  }
  return ms;
}

/**
 * Map telemetry to one engagement bucket. Rules are checked in priority order so
 * every record lands in exactly one bucket (the product spec leaves gaps between ranges).
 */
export function classify(r, now = Date.now(), t = THRESHOLDS) {
  const ms = effectiveActiveMs(r, now);
  const scroll = r.maxScrollPct || 0;
  const interacted = (r.highlights || 0) > 0 || (r.copies || 0) > 0;

  if (interacted) return 'deep';
  if (ms < t.ghostMaxMs) return 'ghost';
  if (ms >= t.deepMinMs) return 'deep';
  if (scroll >= t.deepScrollPct && ms >= t.deepScrollMinMs) return 'deep';
  if (ms >= t.glancedMaxMs) return 'partial';
  if (scroll >= t.partialScrollPct && ms >= t.partialScrollMinMs) return 'partial';
  return 'glanced';
}
