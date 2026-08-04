import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';

export const dataRouter = Router();

function isSameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Mirrors GAS's buildScopedData, minus reports/content/referenceDocs
// (still served from GAS — see CLAUDE.md / migration notes for why).
dataRouter.get('/scoped-data', requireAuth, async (req, res) => {
  const { scopeType, scopeKey } = req.session;
  const empty = { results: [], wrongAnswers: [], aiResults: [], aiWrongAnswers: [] };

  if (scopeType === 'staff_retail') {
    const [outlet, name] = scopeKey.split('|');
    const [results, wrong, aiResults, aiWrong, reports] = await Promise.all([
      pool.query('select * from results where outlet=$1 and name=$2 order by created_at desc', [outlet, name]),
      pool.query('select * from wrong_answers where outlet=$1 and staff_name=$2 order by created_at desc', [outlet, name]),
      pool.query('select * from ai_results where outlet=$1 and name=$2 order by created_at desc', [outlet, name]),
      pool.query('select * from ai_wrong_answers where outlet=$1 and staff_name=$2 order by created_at desc', [outlet, name]),
      pool.query('select * from reports where outlet=$1 and staff_name=$2 order by created_at desc', [outlet, name]),
    ]);
    return res.json(toResponse(results.rows, wrong.rows, aiResults.rows, aiWrong.rows, reports.rows));
  }

  if (scopeType === 'staff_warehouse') {
    const [outlet, name] = scopeKey.split('|');
    const [aiResults, aiWrong] = await Promise.all([
      pool.query('select * from ai_results where outlet=$1 and name=$2 order by created_at desc', [outlet, name]),
      pool.query('select * from ai_wrong_answers where outlet=$1 and staff_name=$2 order by created_at desc', [outlet, name]),
    ]);
    return res.json(toResponse([], [], aiResults.rows, aiWrong.rows));
  }

  if (scopeType === 'outlet_manager') {
    const outlet = scopeKey;
    const [results, wrong, aiResults, aiWrong, reports] = await Promise.all([
      pool.query('select * from results where outlet=$1 order by created_at desc', [outlet]),
      pool.query('select * from wrong_answers where outlet=$1 order by created_at desc', [outlet]),
      pool.query('select * from ai_results where outlet=$1 order by created_at desc', [outlet]),
      pool.query('select * from ai_wrong_answers where outlet=$1 order by created_at desc', [outlet]),
      pool.query('select * from reports where outlet=$1 order by created_at desc', [outlet]),
    ]);
    return res.json(toResponse(results.rows, wrong.rows, aiResults.rows, aiWrong.rows, reports.rows));
  }

  if (scopeType === 'warehouse_manager') {
    const outlet = scopeKey;
    const [aiResults, aiWrong] = await Promise.all([
      pool.query('select * from ai_results where outlet=$1 order by created_at desc', [outlet]),
      pool.query('select * from ai_wrong_answers where outlet=$1 order by created_at desc', [outlet]),
    ]);
    return res.json(toResponse([], [], aiResults.rows, aiWrong.rows));
  }

  if (scopeType === 'area_manager') {
    const outlet = scopeKey;
    const [results, wrong, reports] = await Promise.all([
      pool.query('select * from results where outlet=$1 order by created_at desc', [outlet]),
      pool.query('select * from wrong_answers where outlet=$1 order by created_at desc', [outlet]),
      pool.query('select * from reports where outlet=$1 order by created_at desc', [outlet]),
    ]);
    return res.json(toResponse(results.rows, wrong.rows, [], [], reports.rows));
  }

  if (scopeType === 'supervisor') {
    const windowMonths = parseInt(req.query.windowMonths) || 0;
    const params = [];
    let cutoffClause = '';
    if (windowMonths > 0) {
      params.push(`${windowMonths} months`);
      cutoffClause = ` where created_at > now() - $1::interval`;
    }
    const [results, wrong, aiResults, aiWrong, reports] = await Promise.all([
      pool.query(`select * from results${cutoffClause} order by created_at desc`, params),
      pool.query(`select * from wrong_answers${cutoffClause} order by created_at desc`, params),
      pool.query(`select * from ai_results${cutoffClause} order by created_at desc`, params),
      pool.query(`select * from ai_wrong_answers${cutoffClause} order by created_at desc`, params),
      pool.query(`select * from reports${cutoffClause} order by created_at desc`, params),
    ]);
    return res.json(toResponse(results.rows, wrong.rows, aiResults.rows, aiWrong.rows, reports.rows));
  }

  res.json({ authorized: true, ...empty, reports: [] });
});

// Field names match GAS's Sheet-header casing exactly — the frontend reads
// r.Outlet, r["Staff Name"], r["Question Text"], etc. verbatim. Reports uses
// "Fluency" for the competency column — matches GAS's v1.34 relabel (UI
// calls it "Competency", sheet column name stayed "Fluency").
function toResponse(results, wrong, aiResults, aiWrong, reports = []) {
  return {
    authorized: true,
    results: results.map(r => ({ Timestamp: r.created_at, Name: r.name, Outlet: r.outlet, Score: r.score, Percentage: r.percentage, Topic: r.topic })),
    wrongAnswers: wrong.map(w => ({ Timestamp: w.created_at, 'Staff Name': w.staff_name, Outlet: w.outlet, Topic: w.topic, 'Question Text': w.question, 'User Choice': w.chosen, 'Correct Answer': w.correct })),
    aiResults: aiResults.map(r => ({ Timestamp: r.created_at, AttemptID: r.attempt_id, Name: r.name, Outlet: r.outlet, Score: r.score, Percentage: r.percentage, Topic: r.topic, Passcode: r.passcode })),
    aiWrongAnswers: aiWrong.map(w => ({ Timestamp: w.created_at, AttemptID: w.attempt_id, 'Staff Name': w.staff_name, Outlet: w.outlet, Topic: w.topic, 'Question Text': w.question, 'User Choice': w.chosen, 'Correct Answer': w.correct })),
    reports: reports.map(r => ({
      Timestamp: r.created_at, Manager: r.manager, Outlet: r.outlet, 'Staff Name': r.staff_name,
      'Quiz Score': r.quiz_score, 'Training Title': r.topic, 'Skill Level': r.skill_level,
      'Performance Gaps': r.performance_gaps, Recommendations: r.recommendations,
      Fluency: r.competency, 'Product Knowledge Comments': r.product_knowledge_comments,
    })),
  };
}

// Staff-triggered: save a completed Standard Quiz attempt.
dataRouter.post('/results', requireAuth, async (req, res) => {
  const name = (req.body.name || '').toString().trim().toUpperCase();
  const outlet = (req.body.outlet || '').toString().trim().toUpperCase();
  const topic = (req.body.topic || 'N/A').toString().trim();
  const score = (req.body.score || '').toString();
  const perc = (req.body.perc || '').toString();
  const wrongAnswers = Array.isArray(req.body.wrongAnswers) ? req.body.wrongAnswers : [];

  if (req.session.scopeType !== 'staff_retail' || req.session.scopeKey !== `${outlet}|${name}`) {
    return res.status(403).json({ status: 'unauthorized' });
  }

  const { rows } = await pool.query(
    'select created_at from results where name=$1 and outlet=$2 and topic=$3 order by created_at desc limit 1',
    [name, outlet, topic]
  );
  const alreadyToday = rows[0] && isSameCalendarDay(new Date(rows[0].created_at), new Date());
  if (alreadyToday) return res.json({ status: 'ok' });

  await pool.query(
    'insert into results (outlet, name, topic, score, percentage) values ($1,$2,$3,$4,$5)',
    [outlet, name, topic, score, perc]
  );
  for (const item of wrongAnswers) {
    await pool.query(
      'insert into wrong_answers (outlet, staff_name, topic, question, chosen, correct) values ($1,$2,$3,$4,$5,$6)',
      [outlet, name, topic, (item.qText || '').toString().trim(), item.userChoice || '', item.correctText || '']
    );
  }
  res.json({ status: 'ok' });
});

// Staff-triggered: save a completed AI Practice attempt.
dataRouter.post('/ai-results', requireAuth, async (req, res) => {
  const name = (req.body.name || '').toString().trim().toUpperCase();
  const outlet = (req.body.outlet || '').toString().trim().toUpperCase();
  const topic = (req.body.topic || 'N/A').toString().trim();
  const score = (req.body.score || '').toString();
  const perc = (req.body.perc || '').toString();
  const passcode = (req.body.passcode || '').toString().trim();
  const attemptId = (req.body.attemptId || `AI${Date.now()}`).toString();
  const wrongAnswers = Array.isArray(req.body.wrongAnswers) ? req.body.wrongAnswers : [];

  const validScope = ['staff_retail', 'staff_warehouse'].includes(req.session.scopeType) && req.session.scopeKey === `${outlet}|${name}`;
  if (!validScope) return res.status(403).json({ status: 'unauthorized' });

  const { rows } = await pool.query(
    'select created_at from ai_results where name=$1 and outlet=$2 and passcode=$3 order by created_at desc limit 1',
    [name, outlet, passcode]
  );
  const alreadyToday = rows[0] && isSameCalendarDay(new Date(rows[0].created_at), new Date());
  if (alreadyToday) return res.json({ status: 'ok' });

  await pool.query(
    'insert into ai_results (attempt_id, outlet, name, topic, score, percentage, passcode) values ($1,$2,$3,$4,$5,$6,$7)',
    [attemptId, outlet, name, topic, score, perc, passcode]
  );
  for (const item of wrongAnswers) {
    await pool.query(
      'insert into ai_wrong_answers (attempt_id, outlet, staff_name, topic, question, chosen, correct) values ($1,$2,$3,$4,$5,$6,$7)',
      [attemptId, outlet, name, topic, (item.qText || '').toString().trim(), item.userChoice || '', item.correctText || '']
    );
  }
  res.json({ status: 'ok' });
});
