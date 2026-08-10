// One-off: adds system_settings, a generic key-value table. First user is
// Master Subsystem D's maintenance kill-switch (key='maintenance'), but the
// shape is intentionally generic so future Master subsystems can reuse it
// without another migration. See
// docs/superpowers/specs/2026-08-11-master-subsystem-d-design.md. Safe to re-run.
import { pool } from '../src/config/db.js';

async function main() {
  await pool.query(`
    create table if not exists system_settings (
      key text primary key,
      value jsonb not null,
      updated_by text,
      updated_at timestamptz not null default now()
    )
  `);
  console.log('Migration complete: system_settings table created.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
