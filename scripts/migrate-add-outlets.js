// One-off: creates areas + store_outlets tables and seeds them with the
// current hardcoded region/outlet structure (previously duplicated across
// lautan-academy-backend/src/config/areas.js and 10+ frontend files). See
// docs/superpowers/specs/2026-08-11-outlet-management-design.md.
// Table is named store_outlets, not outlets — this Supabase project already
// has an unrelated `outlets` table (with dependent staff/quizzes/attempts/
// manager_reviews tables belonging to a different app entirely, none of
// which match this codebase's own schema.sql) sharing the same DB. Not
// touched, same reasoning as schema.sql's standard_questions comment.
// Safe to re-run — table creation is if-not-exists, seed rows use
// on-conflict-do-nothing so re-running never clobbers a Master edit made
// after the first run.
import { pool } from '../src/config/db.js';

const AREAS = [
  { id: 'R1', label: 'AMIRUL', outlets: ['DG', 'DGD', 'KMD', 'KMN', 'KMSK', 'MR'] },
  { id: 'R2', label: 'HAZWANI', outlets: ['AJ', 'BJR', 'BP', 'HQCT', 'KB', 'WM', 'PDM'] },
  { id: 'R3', label: 'HARIS', outlets: ['B6', 'BB', 'CDR', 'HL', 'HQ', 'KL', 'PK'] },
  { id: 'R4', label: 'RAIHAN', outlets: ['GB', 'GBD', 'JTH', 'RJ', 'ST', 'TPOH'] },
  { id: 'R5', label: 'ADNIN', outlets: ['JL', 'JLD', 'PP', 'PSPD', 'SMR'] },
  { id: 'R6', label: 'NADHIRAH', outlets: ['KS', 'MC', 'MLR', 'TM', 'TMD', 'TMT', 'MCD'] },
  { id: 'R7', label: 'HASANUL', outlets: ['KBKK', 'KBKS', 'KBTJ', 'PC', 'PT'] },
  { id: 'R8', label: 'HAFSHAM', outlets: ['PM', 'SLS', 'TPT', 'KKR', 'PPK'] },
  { id: 'R9', label: 'IFFAH / RAIHAN', outlets: ['GM', 'CK'] },
];
const WAREHOUSE_LOCATIONS = ['Taskforce', 'Warehouse', 'Inventory', 'Logistic'];

async function main() {
  await pool.query(`
    create table if not exists areas (
      id text primary key,
      label text not null,
      active boolean not null default true,
      created_at timestamptz not null default now()
    )
  `);
  await pool.query(`
    create table if not exists store_outlets (
      code text primary key,
      division text not null,
      area_id text references areas(id),
      active boolean not null default true,
      created_at timestamptz not null default now()
    )
  `);
  await pool.query(`create index if not exists store_outlets_area_idx on store_outlets (area_id)`);

  for (const area of AREAS) {
    await pool.query(
      'insert into areas (id, label) values ($1, $2) on conflict (id) do nothing',
      [area.id, area.label]
    );
    for (const code of area.outlets) {
      await pool.query(
        `insert into store_outlets (code, division, area_id) values ($1, 'retail', $2) on conflict (code) do nothing`,
        [code, area.id]
      );
    }
  }
  for (const code of WAREHOUSE_LOCATIONS) {
    await pool.query(
      `insert into store_outlets (code, division, area_id) values ($1, 'warehouse', null) on conflict (code) do nothing`,
      [code]
    );
  }

  console.log('Migration complete: areas + store_outlets tables created and seeded.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
