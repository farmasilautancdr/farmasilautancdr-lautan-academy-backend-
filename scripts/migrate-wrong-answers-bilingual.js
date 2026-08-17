// One-off: makes wrong_answers/ai_wrong_answers bilingual (question/chosen/
// correct each split into _en + _ms). Grading previously always snapshotted
// the English question/option text into these tables regardless of which
// language the staff was actually viewing the quiz in — QuizView.vue
// already switches display by locale, but that choice never reached these
// insert statements, so Quiz History's wrong-answer review was permanently
// frozen to English. Renames the existing single-language columns to *_en
// (preserves existing data, correctly labeled since English was all that
// was ever written) and adds new nullable *_ms columns. Safe to re-run.
import { pool } from '../src/config/db.js';

async function renameIfPresent(table, oldCol, newCol) {
  const { rows } = await pool.query(
    `select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2`,
    [table, oldCol]
  );
  if (rows.length) {
    await pool.query(`alter table ${table} rename column ${oldCol} to ${newCol}`);
    console.log(`  ${table}.${oldCol} -> ${newCol}`);
  }
}

async function main() {
  for (const table of ['wrong_answers', 'ai_wrong_answers']) {
    await renameIfPresent(table, 'question', 'question_en');
    await renameIfPresent(table, 'chosen', 'chosen_en');
    await renameIfPresent(table, 'correct', 'correct_en');
    await pool.query(`alter table ${table} add column if not exists question_ms text`);
    await pool.query(`alter table ${table} add column if not exists chosen_ms text`);
    await pool.query(`alter table ${table} add column if not exists correct_ms text`);
  }
  console.log('Migration complete: wrong_answers/ai_wrong_answers now bilingual (question/chosen/correct, _en + _ms).');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
