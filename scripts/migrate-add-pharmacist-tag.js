// One-off: adds staff_roster.is_pharmacist (CPD sub-project B tag) and
// extends video_trainings for pharmacist-gated courses (kind: video|reading,
// pharmacist_only flag, optional body text for reading courses; youtube_url
// becomes nullable since a reading-kind row has none). See
// docs/superpowers/specs/2026-08-13-pharmacist-tag-design.md.
// Safe to re-run (add-if-not-exists / drop not null is idempotent).
import { pool } from '../src/config/db.js';

async function main() {
  await pool.query(`alter table staff_roster add column if not exists is_pharmacist boolean not null default false`);
  await pool.query(`alter table video_trainings alter column youtube_url drop not null`);
  await pool.query(`alter table video_trainings add column if not exists kind text not null default 'video'`);
  await pool.query(`alter table video_trainings add column if not exists pharmacist_only boolean not null default false`);
  await pool.query(`alter table video_trainings add column if not exists body text`);
  console.log('Migration complete: staff_roster.is_pharmacist, video_trainings.kind/pharmacist_only/body added, youtube_url nullable.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
