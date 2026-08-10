// One-off: creates master_users for the Master User / Super Admin role —
// see docs/superpowers/specs/2026-08-10-master-admin-subsystem-a-design.md.
// Fully independent of staff_roster/manager_pins/manager_credentials — the
// Master role is not scoped to any outlet/region. Safe to re-run.
import { pool } from '../src/config/db.js';

async function main() {
  await pool.query(`
    create table if not exists master_users (
      id bigserial primary key,
      username text unique not null,
      password_hash text not null,
      created_at timestamptz not null default now()
    )
  `);
  console.log('Migration complete: master_users table created.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
