// One-time migration: pulls full historical data out of GAS (via the
// Supervisor scope, the one role with unscoped company-wide access) and
// loads it into Postgres. Safe to re-run — truncates the target tables
// first, so it's always a clean full resync rather than an incremental one.
//
// Does NOT migrate Reports (schema mismatch — GAS has ~15 columns, this
// backend's `reports` table is a 3-column stub) or Resources/referenceDocs
// (lives in Google Drive, not a sheet). Both still served from GAS directly.
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
  const token = login.token;

  console.log('Fetching full scoped data (windowMonths: 0 = all time)...');
  const data = await gasPost({ action: 'get_scoped_data', token, windowMonths: 0 });
  if (!data.authorized) throw new Error('get_scoped_data failed: ' + (data.error || 'unknown'));

  const results = [...(data.results || []), ...(data.archiveResults || [])];
  const wrongAnswers = data.wrongAnswers || [];
  const aiResults = data.aiResults || [];
  const aiWrongAnswers = data.aiWrongAnswers || [];
  const content = data.content || [];

  console.log(`Pulled: ${results.length} results, ${wrongAnswers.length} wrong answers, ${aiResults.length} AI results, ${aiWrongAnswers.length} AI wrong answers, ${content.length} content rows.`);

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('truncate results, wrong_answers, ai_results, ai_wrong_answers, content');

    for (const r of results) {
      await client.query(
        `insert into results (outlet, name, topic, score, percentage, created_at) values ($1,$2,$3,$4,$5,$6)`,
        [r.Outlet || '', r.Name || '', r.Topic || '', (r.Score || '').toString(), (r.Percentage || '').toString(), r.Timestamp ? new Date(r.Timestamp) : new Date()]
      );
    }

    for (const w of wrongAnswers) {
      await client.query(
        `insert into wrong_answers (outlet, staff_name, topic, question, chosen, correct, created_at) values ($1,$2,$3,$4,$5,$6,$7)`,
        [w.Outlet || '', w['Staff Name'] || '', w.Topic || '', w['Question Text'] || '', w['User Choice'] || '', w['Correct Answer'] || '', w.Timestamp ? new Date(w.Timestamp) : new Date()]
      );
    }

    for (const r of aiResults) {
      await client.query(
        `insert into ai_results (attempt_id, outlet, name, topic, score, percentage, passcode, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.AttemptID || '', r.Outlet || '', r.Name || '', r.Topic || '', (r.Score || '').toString(), (r.Percentage || '').toString(), r.Passcode || '', r.Timestamp ? new Date(r.Timestamp) : new Date()]
      );
    }

    for (const w of aiWrongAnswers) {
      await client.query(
        `insert into ai_wrong_answers (attempt_id, outlet, staff_name, topic, question, chosen, correct, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [w.AttemptID || '', w.Outlet || '', w['Staff Name'] || '', w.Topic || '', w['Question Text'] || '', w['User Choice'] || '', w['Correct Answer'] || '', w.Timestamp ? new Date(w.Timestamp) : new Date()]
      );
    }

    for (const c of content) {
      await client.query(
        `insert into content (topic, category, title, body, link, created_at) values ($1,$2,$3,$4,$5,$6)`,
        [c.Topic || '', c.Category || '', c.Title || '', c.Body || '', c.Link || '', c.Timestamp ? new Date(c.Timestamp) : new Date()]
      );
    }

    await client.query('commit');
    console.log('Migration committed.');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
