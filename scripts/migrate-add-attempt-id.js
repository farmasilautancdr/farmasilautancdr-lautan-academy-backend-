// One-off: adds attempt_id to results + wrong_answers so Standard/Module
// Quiz wrong-answer review can be scoped per-attempt instead of matched by
// topic alone (which mixed every retake's wrong answers together in Quiz
// History — see CLAUDE.md/SCOPE_TRACKER known-fragility notes). Mirrors the
// column ai_results/ai_wrong_answers already had. Safe to re-run.
import { pool } from '../src/config/db.js';

async function main() {
  await pool.query('alter table results add column if not exists attempt_id text');
  await pool.query('alter table wrong_answers add column if not exists attempt_id text');
  console.log('Migration complete: results.attempt_id, wrong_answers.attempt_id');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
