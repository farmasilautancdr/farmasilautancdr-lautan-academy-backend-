// One-off: adds manager_credentials so Outlet/Warehouse/Area Manager can
// register a personal per-outlet/per-region password instead of the single
// shared PIN per role in manager_pins (which becomes the master/recovery
// PIN going forward — see
// docs/superpowers/specs/2026-08-06-manager-auth-design.md). Safe to re-run.
import { pool } from '../src/config/db.js';

async function main() {
  await pool.query(`
    create table if not exists manager_credentials (
      id bigserial primary key,
      role text not null,
      scope_key text not null,
      password_hash text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (role, scope_key)
    )
  `);
  console.log('Migration complete: manager_credentials table created.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
