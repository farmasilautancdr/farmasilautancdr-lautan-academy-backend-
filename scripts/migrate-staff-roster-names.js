// One-time migration: pulls every staff name (all outlets/divisions, one
// unauthenticated GET — GAS's doGet() bundles the public roster with no
// passcodes exposed in bulk) and creates a row for each with a random,
// unknown-to-anyone 4-digit PIN. Nobody can log in with it — a manager must
// explicitly Reset PIN via the Manage Staff UI before that person's account
// works on the new backend. That's intentional (see the plan discussed:
// "names only" migration), not a bug.
//
// Safe to re-run: uses ON CONFLICT DO NOTHING on (division, outlet, name),
// so it never overwrites a PIN that's already been reset through real use.
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { env } from '../src/config/env.js';

const GAS_URL = process.env.GAS_URL;
if (!GAS_URL) throw new Error('GAS_URL is not set in .env');

const pool = new pg.Pool({ connectionString: env.databaseUrl, ssl: { rejectUnauthorized: false } });

function randomPin() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

async function main() {
  console.log('Fetching public roster from GAS...');
  const res = await fetch(`${GAS_URL}?_=${Date.now()}`, { cache: 'no-store' });
  const data = await res.json();
  const roster = data.staffRoster || [];
  console.log(`Pulled ${roster.length} staff rows.`);

  let added = 0, skippedBlank = 0, skippedConflict = 0;
  for (const r of roster) {
    const division = (r.Division || '').toString().trim().toLowerCase();
    const outlet = (r.Outlet || '').toString().trim().toUpperCase();
    const name = (r.Name || '').toString().trim().toUpperCase();
    if (!division || !outlet || !name) { skippedBlank++; continue; }

    const pinHash = await bcrypt.hash(randomPin(), 10);
    const { rowCount } = await pool.query(
      `insert into staff_roster (division, outlet, name, pin_hash, added_by)
       values ($1,$2,$3,$4,'migrated from GAS — needs PIN reset')
       on conflict (division, outlet, name) do nothing`,
      [division, outlet, name, pinHash]
    );
    if (rowCount) added++; else skippedConflict++;
  }

  console.log(`Added ${added} new staff. Skipped ${skippedConflict} already-present (existing PIN preserved), ${skippedBlank} blank row(s).`);
  await pool.end();
}

main().catch(e => {
  console.error('Staff roster migration failed:', e.message);
  process.exit(1);
});
