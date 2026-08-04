// Postgres-backed — survives restarts and is correct across multiple
// backend instances (was an in-memory Map before, per-process only, wiped
// on every restart/redeploy). Same shared `rate_limits` table backs both
// the login-lockout counter and the more generous check-endpoint
// throttle; each caller picks its own window/threshold, the table doesn't
// care which is which.
import { pool } from '../config/db.js';

const FAIL_MAX_ATTEMPTS = 5;
const FAIL_WINDOW_MS = 5 * 60 * 1000;

// Atomic: increments if the existing row hasn't expired yet, otherwise
// resets to 1 with a fresh expiry — avoids a separate read-then-write
// race between concurrent requests for the same key.
async function bump(key, windowMs) {
  const expiresAt = new Date(Date.now() + windowMs);
  const { rows } = await pool.query(
    `insert into rate_limits (key, count, expires_at) values ($1, 1, $2)
     on conflict (key) do update set
       count = case when rate_limits.expires_at > now() then rate_limits.count + 1 else 1 end,
       expires_at = case when rate_limits.expires_at > now() then rate_limits.expires_at else excluded.expires_at end
     returning count`,
    [key, expiresAt]
  );
  return rows[0].count;
}

export async function isLockedOut(key) {
  const { rows } = await pool.query('select count, expires_at from rate_limits where key = $1', [key]);
  const entry = rows[0];
  if (!entry) return false;
  if (Date.now() > new Date(entry.expires_at).getTime()) {
    await pool.query('delete from rate_limits where key = $1', [key]);
    return false;
  }
  return entry.count >= FAIL_MAX_ATTEMPTS;
}

export async function recordFailure(key) {
  await bump(key, FAIL_WINDOW_MS);
}

export async function clearFailures(key) {
  await pool.query('delete from rate_limits where key = $1', [key]);
}

// Separate, more generous counter for throttling (not lockout-on-failure)
// use cases — e.g. capping how many times someone can hit a per-question
// answer-check endpoint. A real quiz attempt only ever needs one check per
// question; this caps total calls per window high enough to comfortably
// cover legitimate use (retries, page reloads) while still meaningfully
// slowing a script trying to enumerate an entire question bank's answers
// one check call at a time.
export async function hitRateLimit(key, max, windowMs) {
  const count = await bump(key, windowMs);
  return count > max;
}
