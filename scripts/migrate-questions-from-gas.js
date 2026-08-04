// One-time pull of the Standard Quiz question bank from GAS's public doGet()
// endpoint into standard_questions. Safe to re-run — nothing else writes to
// this table, so it truncates and reinserts (same pattern as
// sync-content-from-gas.js), rather than trying to diff/upsert.
import 'dotenv/config';
import pg from 'pg';
import { env } from '../src/config/env.js';

const GAS_URL = process.env.GAS_URL;
if (!GAS_URL) throw new Error('GAS_URL is not set in .env');

const pool = new pg.Pool({ connectionString: env.databaseUrl, ssl: { rejectUnauthorized: false } });

async function main() {
  const res = await fetch(GAS_URL + '?_=' + Date.now(), { cache: 'no-store' });
  const data = await res.json();
  const questions = data.questions || [];
  if (!questions.length) {
    console.log('No questions returned from GAS — aborting, not touching the table.');
    process.exit(1);
  }

  await pool.query('truncate table standard_questions restart identity');

  for (const q of questions) {
    await pool.query(
      `insert into standard_questions
       (topic, question_en, question_ms, opt1_en, opt2_en, opt3_en, opt4_en, opt1_ms, opt2_ms, opt3_ms, opt4_ms, correct, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        q.topic, q.question_en, q.question_ms,
        String(q.opt1_en ?? ''), String(q.opt2_en ?? ''), String(q.opt3_en ?? ''), String(q.opt4_en ?? ''),
        String(q.opt1_ms ?? ''), String(q.opt2_ms ?? ''), String(q.opt3_ms ?? ''), String(q.opt4_ms ?? ''),
        parseInt(q.correct) || 0,
        (q.status || 'active').toString().trim().toLowerCase(),
      ]
    );
  }

  const { rows } = await pool.query('select count(*) from standard_questions');
  console.log(`Migrated ${questions.length} questions from GAS. Table now has ${rows[0].count} rows.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
