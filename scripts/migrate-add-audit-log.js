// One-off: creates audit_log (Master Subsystem E), migrates every existing
// master_delete_log row into it, then drops master_delete_log — see
// docs/superpowers/specs/2026-08-11-master-subsystem-e-design.md.
// Safe to re-run (create-if-not-exists, migrate-if-source-exists).
import { pool } from '../src/config/db.js';

async function main() {
  await pool.query(`
    create table if not exists audit_log (
      id bigserial primary key,
      actor_type text not null,
      actor_key text not null,
      action text not null,
      summary text not null,
      affected_count integer,
      created_at timestamptz not null default now()
    )
  `);
  await pool.query(`
    create index if not exists audit_log_created_at_idx on audit_log (created_at desc)
  `);

  const { rows: exists } = await pool.query(
    `select 1 from information_schema.tables where table_name = 'master_delete_log'`
  );
  if (exists.length) {
    const { rowCount } = await pool.query(`
      insert into audit_log (actor_type, actor_key, action, summary, affected_count, created_at)
      select 'master', master_username, 'purge.' || entity_type, summary, deleted_count, created_at
      from master_delete_log
    `);
    console.log(`Migrated ${rowCount} row(s) from master_delete_log into audit_log.`);
    await pool.query('drop table master_delete_log');
    console.log('Dropped master_delete_log.');
  } else {
    console.log('master_delete_log already gone, nothing to migrate.');
  }

  console.log('Migration complete: audit_log table ready.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
