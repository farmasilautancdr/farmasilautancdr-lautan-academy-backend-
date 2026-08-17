import { pool } from '../config/db.js';

// Shared audit-trail writer for every privileged/admin action. Accepts
// either the module-level `pool` (standalone routes — catches its own
// errors, fail-open, never blocks the caller's response) or a transaction
// `client` (purge routes — an insert failure here throws up through the
// caller's own try/catch and rolls back the whole transaction, same
// all-or-nothing behavior master_delete_log already had, not a new
// failure mode). See docs/superpowers/specs/2026-08-11-master-subsystem-e-design.md.
export async function logAudit(dbOrClient = pool, { actorType, actorKey, action, summary, affectedCount = null }) {
  await dbOrClient.query(
    'insert into audit_log (actor_type, actor_key, action, summary, affected_count) values ($1,$2,$3,$4,$5)',
    [actorType, actorKey, action, summary, affectedCount]
  );
}

// Fail-open wrapper for standalone (non-transactional) routes — never
// throws, logs to console on failure instead. Purge routes call logAudit()
// directly (not this) since they need the throw to trigger their rollback.
export async function logAuditSafe(fields) {
  try {
    await logAudit(pool, fields);
  } catch (err) {
    console.error('logAudit failed:', err.message);
  }
}

const RETENTION_DAYS = 14;

// Piggybacks on sessionRevocationCache's existing maintenance loop — no
// separate cron mechanism in this app (same pattern as pruneOldSessions).
export async function pruneOldAuditLog() {
  await pool.query(`delete from audit_log where created_at < now() - interval '${RETENTION_DAYS} days'`);
}
