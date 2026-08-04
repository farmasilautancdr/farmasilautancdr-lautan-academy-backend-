// Syncs historical Reports from GAS. Safe to re-run — this backend's own
// POST /reports has only ever been used for testing (cleaned up after each
// test), so a truncate+reload here can't lose real data created through
// this backend. If that stops being true (real reports start getting filed
// here), switch this to an incremental sync instead.
import 'dotenv/config';
import pg from 'pg';
import { env } from '../src/config/env.js';

const GAS_URL = process.env.GAS_URL;
const SUPERVISOR_PIN = process.env.SUPERVISOR_PIN;
if (!GAS_URL) throw new Error('GAS_URL is not set in .env');
if (!SUPERVISOR_PIN) throw new Error('SUPERVISOR_PIN is not set in .env');

const pool = new pg.Pool({ connectionString: env.databaseUrl, ssl: { rejectUnauthorized: false } });

async function gasPost(body) {
  const res = await fetch(GAS_URL, { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('Logging in as Supervisor...');
  const login = await gasPost({ action: 'establish_session', role: 'supervisor', outlet: '', pin: SUPERVISOR_PIN });
  if (!login.authorized) throw new Error('Supervisor login failed: ' + (login.error || 'unknown'));

  console.log('Fetching reports (windowMonths: 0 = all time)...');
  const data = await gasPost({ action: 'get_scoped_data', token: login.token, windowMonths: 0 });
  if (!data.authorized) throw new Error('get_scoped_data failed: ' + (data.error || 'unknown'));
  const reports = data.reports || [];
  console.log(`Pulled ${reports.length} report rows.`);

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('truncate reports');
    let skipped = 0;
    for (const r of reports) {
      const outlet = (r.Outlet || '').toString().trim().toUpperCase();
      const staffName = (r['Staff Name'] || '').toString().trim().toUpperCase();
      const topic = (r['Training Title'] || '').toString().trim();
      // The unique(outlet, staff_name, topic) constraint mirrors GAS's own
      // one-report-per-combo rule, so any GAS row missing one of these three
      // (shouldn't happen, but historical sheets can have stray blank rows)
      // is skipped rather than crashing the whole sync.
      if (!outlet || !staffName || !topic) { skipped++; continue; }
      const competency = r.Fluency !== '' && r.Fluency != null ? parseInt(r.Fluency) : null;
      await client.query(
        `insert into reports (outlet, staff_name, manager, topic, quiz_score, skill_level, performance_gaps, recommendations, competency, product_knowledge_comments, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
         on conflict (outlet, staff_name, topic) do nothing`,
        [outlet, staffName, r.Manager || '', topic, r['Quiz Score'] || '', r['Skill Level'] || '',
         r['Performance Gaps'] || '', r.Recommendations || '', competency, r['Product Knowledge Comments'] || '',
         r.Timestamp ? new Date(r.Timestamp) : new Date()]
      );
    }
    await client.query('commit');
    console.log(`Reports sync committed. Skipped ${skipped} row(s) missing outlet/staff/topic.`);
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(e => {
  console.error('Reports sync failed:', e.message);
  process.exit(1);
});
