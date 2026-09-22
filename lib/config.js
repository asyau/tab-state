// Tunable constants. Everything time-based is in milliseconds.

export const THRESHOLDS = {
  ghostMaxMs: 2_000,           // viewed for less than this -> Ghost
  glancedMaxMs: 15_000,        // below this (and little scroll) -> Just Glanced
  deepMinMs: 90_000,           // at least this -> Deep Focus
  deepScrollPct: 70,           // scrolled this far...
  deepScrollMinMs: 30_000,     // ...for at least this long -> Deep Focus
  partialScrollPct: 25,        // scrolled this far...
  partialScrollMinMs: 5_000,   // ...for at least this long -> Partially Read
};

export const TIMING = {
  pingIntervalMs: 15_000,      // content-script heartbeat while visible + focused
  tickMinutes: 0.5,            // chrome.alarms heartbeat (30s is Chrome's minimum)
  heartbeatGraceMs: 45_000,    // a segment can extend at most this far past the last heartbeat
  sleepGapMs: 75_000,          // no heartbeat for this long -> the machine slept; split the segment
  idleSeconds: 60,             // chrome.idle threshold; only its 'locked' state pauses tracking
  closedRetentionMs: 7 * 24 * 60 * 60 * 1000,
  undoWindowMs: 30_000,
};

export const BUCKETS = ['glanced', 'partial', 'deep', 'ghost'];

export const BUCKET_META = {
  glanced: { label: 'Just Glanced', emoji: '👁️' },
  partial: { label: 'Partially Read', emoji: '📖' },
  deep: { label: 'Deep Focus', emoji: '🎯' },
  ghost: { label: 'Ghost Tabs', emoji: '👻' },
};
