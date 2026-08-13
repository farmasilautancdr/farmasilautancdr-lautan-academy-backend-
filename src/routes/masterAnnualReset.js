import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth, requireMaster } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';

export const masterAnnualResetRouter = Router();

// Same pattern as masterSessions.js's own copy — file-local, not shared,
// matching this codebase's existing convention of small per-file helpers
// over a shared utility module. See
// docs/superpowers/specs/2026-08-14-annual-data-reset-design.md.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Always Jan 1 of the current calendar year — never a rolling window. Lines
// up with CPD Hours' own existing Jan-1 reset (cpdHoursThisYear() in
// data.js already only ever looks at the current year).
const CUTOFF_SQL = "date_trunc('year', now())";

async function countBeforeCutoff(db) {
  const [results, wrongAnswers, aiResults, aiWrongAnswers, reports, auditLog] = await Promise.all([
    db.query(`select count(*) from results where created_at < ${CUTOFF_SQL}`),
    db.query(`select count(*) from wrong_answers where created_at < ${CUTOFF_SQL}`),
    db.query(`select count(*) from ai_results where created_at < ${CUTOFF_SQL}`),
    db.query(`select count(*) from ai_wrong_answers where created_at < ${CUTOFF_SQL}`),
    db.query(`select count(*) from reports where created_at < ${CUTOFF_SQL}`),
    db.query(`select count(*) from audit_log where created_at < ${CUTOFF_SQL}`),
  ]);
  return {
    results: Number(results.rows[0].count),
    wrongAnswers: Number(wrongAnswers.rows[0].count),
    aiResults: Number(aiResults.rows[0].count),
    aiWrongAnswers: Number(aiWrongAnswers.rows[0].count),
    reports: Number(reports.rows[0].count),
    auditLog: Number(auditLog.rows[0].count),
  };
}

masterAnnualResetRouter.get('/preview', requireAuth, requireMaster, async (req, res) => {
  const { rows } = await pool.query(`select ${CUTOFF_SQL} as cutoff`);
  const counts = await countBeforeCutoff(pool);
  res.json({ cutoff: rows[0].cutoff, counts });
});

masterAnnualResetRouter.post('/', requireAuth, requireMaster, async (req, res) => {
  try {
    const result = await withTransaction(async (client) => {
      const beforeCounts = await countBeforeCutoff(client);

      const [rResults, rWrong, rAi, rAiWrong, rReports, rAudit] = await Promise.all([
        client.query(`delete from results where created_at < ${CUTOFF_SQL}`),
        client.query(`delete from wrong_answers where created_at < ${CUTOFF_SQL}`),
        client.query(`delete from ai_results where created_at < ${CUTOFF_SQL}`),
        client.query(`delete from ai_wrong_answers where created_at < ${CUTOFF_SQL}`),
        client.query(`delete from reports where created_at < ${CUTOFF_SQL}`),
        client.query(`delete from audit_log where created_at < ${CUTOFF_SQL}`),
      ]);

      const counts = {
        results: rResults.rowCount,
        wrongAnswers: rWrong.rowCount,
        aiResults: rAi.rowCount,
        aiWrongAnswers: rAiWrong.rowCount,
        reports: rReports.rowCount,
        auditLog: rAudit.rowCount,
      };
      const deletedTotal = Object.values(counts).reduce((a, b) => a + b, 0);

      // Dated now() by the table's own default — always this calendar
      // year, so this row survives the very cutoff it describes.
      await logAudit(client, {
        actorType: 'master',
        actorKey: req.session.scopeKey,
        action: 'master.annual_reset',
        summary: `Annual reset: ${JSON.stringify(counts)} (expected pre-cutoff: ${JSON.stringify(beforeCounts)})`,
        affectedCount: deletedTotal,
      });

      return { counts, deletedTotal };
    });

    res.json({ status: 'ok', counts: result.counts, deletedTotal: result.deletedTotal });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message || 'Reset failed.' });
  }
});
