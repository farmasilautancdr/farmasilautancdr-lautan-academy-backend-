import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth, requireMaster } from '../middleware/auth.js';

export const masterPurgeRouter = Router();

// Every delete route in this file runs its cascade + its master_delete_log
// write inside one transaction, so a mid-cascade failure can't leave a
// partial delete with no trace of what happened. See
// docs/superpowers/specs/2026-08-11-master-subsystem-c-design.md.
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

async function logDelete(client, masterUsername, entityType, summary, deletedCount) {
  await client.query(
    'insert into master_delete_log (master_username, entity_type, summary, deleted_count) values ($1,$2,$3,$4)',
    [masterUsername, entityType, summary, deletedCount]
  );
}

// staff_roster has no FK to results/wrong_answers/ai_results/ai_wrong_answers/
// reports — every query in this codebase matches those by outlet+name text,
// so this cascade does the same.
masterPurgeRouter.get('/staff/search', requireAuth, requireMaster, async (req, res) => {
  const outlet = (req.query.outlet || '').toString().trim().toUpperCase();
  const name = (req.query.name || '').toString().trim().toUpperCase();

  const conditions = [];
  const params = [];
  if (outlet) { params.push(outlet); conditions.push(`outlet = $${params.length}`); }
  if (name) { params.push(`%${name}%`); conditions.push(`name like $${params.length}`); }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';

  const { rows } = await pool.query(
    `select id, division, outlet, name, id_note, created_at from staff_roster ${where} order by outlet, name limit 200`,
    params
  );

  const staff = await Promise.all(rows.map(async (s) => {
    const { rows: countRows } = await pool.query(
      `select
        (select count(*) from results where outlet=$1 and name=$2) as results,
        (select count(*) from wrong_answers where outlet=$1 and staff_name=$2) as wrong_answers,
        (select count(*) from ai_results where outlet=$1 and name=$2) as ai_results,
        (select count(*) from ai_wrong_answers where outlet=$1 and staff_name=$2) as ai_wrong_answers,
        (select count(*) from reports where outlet=$1 and staff_name=$2) as reports`,
      [s.outlet, s.name]
    );
    const c = countRows[0];
    return {
      id: s.id, division: s.division, outlet: s.outlet, name: s.name, idNote: s.id_note, createdAt: s.created_at,
      relatedCounts: {
        results: Number(c.results), wrongAnswers: Number(c.wrong_answers),
        aiResults: Number(c.ai_results), aiWrongAnswers: Number(c.ai_wrong_answers), reports: Number(c.reports),
      },
    };
  }));

  res.json({ staff });
});

masterPurgeRouter.post('/staff/delete', requireAuth, requireMaster, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ status: 'error', error: 'No staff selected.' });

  try {
    const result = await withTransaction(async (client) => {
      const { rows: staffRows } = await client.query(
        'select id, outlet, name from staff_roster where id = ANY($1::bigint[])',
        [ids]
      );
      if (!staffRows.length) throw new Error('No matching staff accounts found.');

      let totalDeleted = 0;
      const names = [];
      for (const s of staffRows) {
        const r1 = await client.query('delete from results where outlet=$1 and name=$2', [s.outlet, s.name]);
        const r2 = await client.query('delete from wrong_answers where outlet=$1 and staff_name=$2', [s.outlet, s.name]);
        const r3 = await client.query('delete from ai_results where outlet=$1 and name=$2', [s.outlet, s.name]);
        const r4 = await client.query('delete from ai_wrong_answers where outlet=$1 and staff_name=$2', [s.outlet, s.name]);
        const r5 = await client.query('delete from reports where outlet=$1 and staff_name=$2', [s.outlet, s.name]);
        const r6 = await client.query('delete from staff_roster where id=$1', [s.id]);
        totalDeleted += r1.rowCount + r2.rowCount + r3.rowCount + r4.rowCount + r5.rowCount + r6.rowCount;
        names.push(`${s.outlet}/${s.name}`);
      }

      const summary = `Deleted ${staffRows.length} staff account(s): ${names.join(', ')}`;
      await logDelete(client, req.session.scopeKey, 'staff', summary, totalDeleted);
      return { deletedCount: totalDeleted };
    });

    res.json({ status: 'ok', deletedCount: result.deletedCount });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message || 'Delete failed.' });
  }
});

masterPurgeRouter.get('/quiz-attempts/search', requireAuth, requireMaster, async (req, res) => {
  const type = req.query.type === 'ai' ? 'ai' : 'standard';
  const table = type === 'ai' ? 'ai_results' : 'results';
  const outlet = (req.query.outlet || '').toString().trim().toUpperCase();
  const name = (req.query.name || '').toString().trim().toUpperCase();
  const topic = (req.query.topic || '').toString().trim();
  const dateFrom = (req.query.dateFrom || '').toString().trim();
  const dateTo = (req.query.dateTo || '').toString().trim();

  const conditions = [];
  const params = [];
  if (outlet) { params.push(outlet); conditions.push(`outlet = $${params.length}`); }
  if (name) { params.push(`%${name}%`); conditions.push(`name like $${params.length}`); }
  if (topic) { params.push(`%${topic}%`); conditions.push(`topic like $${params.length}`); }
  if (dateFrom) { params.push(dateFrom); conditions.push(`created_at >= $${params.length}`); }
  if (dateTo) { params.push(dateTo); conditions.push(`created_at <= $${params.length}`); }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';

  const { rows } = await pool.query(
    `select id, attempt_id, outlet, name, topic, score, percentage, created_at from ${table} ${where} order by created_at desc limit 200`,
    params
  );
  res.json({
    attempts: rows.map(r => ({
      id: r.id, attemptId: r.attempt_id, outlet: r.outlet, name: r.name, topic: r.topic,
      score: r.score, percentage: r.percentage, createdAt: r.created_at, hasAttemptId: !!r.attempt_id,
    })),
  });
});

masterPurgeRouter.post('/quiz-attempts/delete', requireAuth, requireMaster, async (req, res) => {
  const type = req.body.type === 'ai' ? 'ai' : 'standard';
  const resultsTable = type === 'ai' ? 'ai_results' : 'results';
  const wrongTable = type === 'ai' ? 'ai_wrong_answers' : 'wrong_answers';
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ status: 'error', error: 'No attempts selected.' });

  try {
    const result = await withTransaction(async (client) => {
      const { rows: attemptRows } = await client.query(
        `select id, attempt_id, outlet, name, topic from ${resultsTable} where id = ANY($1::bigint[])`,
        [ids]
      );
      if (!attemptRows.length) throw new Error('No matching attempts found.');

      let totalDeleted = 0;
      let legacyCount = 0;
      for (const a of attemptRows) {
        if (a.attempt_id) {
          const rw = await client.query(`delete from ${wrongTable} where attempt_id=$1`, [a.attempt_id]);
          totalDeleted += rw.rowCount;
        } else {
          legacyCount += 1;
        }
        const rr = await client.query(`delete from ${resultsTable} where id=$1`, [a.id]);
        totalDeleted += rr.rowCount;
      }

      const summary = `Deleted ${attemptRows.length} ${type} quiz attempt(s)` + (legacyCount ? ` (${legacyCount} legacy, wrong answers left in place)` : '');
      await logDelete(client, req.session.scopeKey, 'quiz_attempt', summary, totalDeleted);
      return { deletedCount: totalDeleted };
    });

    res.json({ status: 'ok', deletedCount: result.deletedCount });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message || 'Delete failed.' });
  }
});
