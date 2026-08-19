import { pool } from '../config/db.js';
import { pruneOldAuditLog } from './auditLog.js';

// In-memory cache of currently-revoked, not-yet-naturally-expired session
// ids. requireAuth checks against this instead of hitting the DB on every
// authenticated request — decided during brainstorming as the lighter-
// weight alternative to a live per-request DB check. Single Railway
// instance, so no cross-instance sync concern. See
// docs/superpowers/specs/2026-08-11-master-subsystem-g-design.md.
let revokedSids = new Set();

export function isRevoked(sid) {
  return revokedSids.has(sid);
}

// Called directly by the revoke route so the process handling the revoke
// enforces it immediately, not after the next poll tick. The periodic
// refresh below remains the source of truth (handles restarts, and prunes
// ids once they age past their own expires_at, keeping the Set bounded).
export function addRevokedSid(sid) {
  revokedSids.add(sid);
}

async function refreshRevocationCache() {
  const { rows } = await pool.query(
    `select id from sessions where revoked_at is not null and expires_at > now()`
  );
  revokedSids = new Set(rows.map((r) => r.id));
}

const POLL_INTERVAL_MS = 25000;
const RETENTION_DAYS = 30;

// Prunes session rows older than the retention window. Piggybacks on the
// same interval as the cache refresh — no separate cron mechanism exists in
// this app (see Subsystem F's retention approach for the same pattern).
async function pruneOldSessions() {
  await pool.query(`delete from sessions where expires_at < now() - interval '${RETENTION_DAYS} days'`);
}

// Call once at server startup. Runs refreshRevocationCache() immediately
// (no blind window on a fresh deploy where a revoked-but-not-yet-expired
// session exists), then every POLL_INTERVAL_MS after that.
export function startSessionMaintenanceLoop() {
  refreshRevocationCache().catch((err) => console.error('refreshRevocationCache failed:', err.message));
  setInterval(() => {
    refreshRevocationCache().catch((err) => console.error('refreshRevocationCache failed:', err.message));
    pruneOldSessions().catch((err) => console.error('pruneOldSessions failed:', err.message));
    pruneOldAuditLog().catch((err) => console.error('pruneOldAuditLog failed:', err.message));
  }, POLL_INTERVAL_MS);
}
