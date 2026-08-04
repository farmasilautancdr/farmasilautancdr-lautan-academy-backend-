// In-memory fail counter, same shape as the GAS CacheService lockout:
// 5 wrong attempts locks a key out for 5 minutes. Per-process only — resets
// on restart. Fine for this app's traffic; revisit if backend ever runs
// multiple instances behind a load balancer.
const fails = new Map(); // key -> { count, expiresAt }
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 5 * 60 * 1000;

export function isLockedOut(key) {
  const entry = fails.get(key);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    fails.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

export function recordFailure(key) {
  const entry = fails.get(key);
  if (entry && Date.now() <= entry.expiresAt) {
    entry.count += 1;
  } else {
    fails.set(key, { count: 1, expiresAt: Date.now() + WINDOW_MS });
  }
}

export function clearFailures(key) {
  fails.delete(key);
}

// Separate, more generous counter for throttling (not lockout-on-failure)
// use cases — e.g. capping how many times someone can hit a per-question
// answer-check endpoint. A real quiz attempt only ever needs one check per
// question; this caps total calls per window high enough to comfortably
// cover legitimate use (retries, page reloads) while still meaningfully
// slowing a script trying to enumerate an entire question bank's answers
// one check call at a time.
const hits = new Map(); // key -> { count, expiresAt }

export function hitRateLimit(key, max, windowMs) {
  const entry = hits.get(key);
  const now = Date.now();
  if (!entry || now > entry.expiresAt) {
    hits.set(key, { count: 1, expiresAt: now + windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}
