// One-off: creates sessions (Master Subsystem G) — one row per staff/manager
// login, tracked so Master can view active sessions and force-logout one or
// several. Master's own tokens are never written here (untracked by design).
// See docs/superpowers/specs/2026-08-11-master-subsystem-g-design.md.
// Safe to re-run (create-if-not-exists).
import { pool } from '../src/config/db.js';

async function main() {
  await pool.query(`
    create table if not exists sessions (
      id bigserial primary key,
      scope_type text not null,
      scope_key text not null,
      issued_at timestamptz not null default now(),
      expires_at timestamptz not null,
      revoked_at timestamptz,
      revoked_by text,
      ip text,
      user_agent text
    )
  `);
  await pool.query(`
    create index if not exists sessions_active_idx on sessions (revoked_at, expires_at)
  `);
  await pool.query(`
    create index if not exists sessions_scope_idx on sessions (scope_type, scope_key)
  `);
  console.log('Migration complete: sessions table created.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
