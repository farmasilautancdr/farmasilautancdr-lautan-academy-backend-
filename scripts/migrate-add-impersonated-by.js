// One-off: adds sessions.impersonated_by (Master Subsystem H) — set to the
// Master username on impersonation-issued session rows, null for every
// ordinary staff/manager login. Lets Active Sessions (Subsystem G) show
// which rows are impersonation sessions without a separate table. See
// docs/superpowers/specs/2026-08-11-master-subsystem-h-design.md.
// Safe to re-run (add-if-not-exists).
import { pool } from '../src/config/db.js';

async function main() {
  await pool.query(`alter table sessions add column if not exists impersonated_by text`);
  console.log('Migration complete: sessions.impersonated_by added.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
