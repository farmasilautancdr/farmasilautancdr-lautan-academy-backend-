// One-off: adds master_delete_log, the interim audit trail for Master
// Subsystem C (test-data purge/hard delete) until Subsystem E (full audit
// logs) exists — see docs/superpowers/specs/2026-08-11-master-subsystem-c-design.md.
// Safe to re-run.
import { pool } from '../src/config/db.js';

async function main() {
  await pool.query(`
    create table if not exists master_delete_log (
      id bigserial primary key,
      master_username text not null,
      entity_type text not null,
      summary text not null,
      deleted_count int not null,
      created_at timestamptz not null default now()
    )
  `);
  console.log('Migration complete: master_delete_log table created.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
