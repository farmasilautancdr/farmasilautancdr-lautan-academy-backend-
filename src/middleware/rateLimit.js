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
