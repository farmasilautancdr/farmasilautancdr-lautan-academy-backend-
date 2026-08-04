import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { outletsForArea } from '../config/areas.js';

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
    // scopeKey is the area id now, not one outlet — the manager sees every
    // outlet in their assigned region.
    const outlets = outletsForArea(scopeKey) || [];
    const [results, wrong, reports] = await Promise.all([
      pool.query('select * from results where outlet = ANY($1) order by created_at desc', [outlets]),
      pool.query('select * from wrong_answers where outlet = ANY($1) order by created_at desc', [outlets]),
      pool.query('select * from reports where outlet = ANY($1) order by created_at desc', [outlets]),
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

// Staff-triggered: save a completed Standard Quiz attempt. Grades
// server-side from a raw {id, chosen} answer array — the client never gets
// to assert its own score. `standard_questions` is looked up by id AND
// topic together so an id can't be reused to claim a different topic's
// question was part of this attempt.
dataRouter.post('/results', requireAuth, async (req, res) => {
  const name = (req.body.name || '').toString().trim().toUpperCase();
  const outlet = (req.body.outlet || '').toString().trim().toUpperCase();
  const topic = (req.body.topic || 'N/A').toString().trim();
  const answers = Array.isArray(req.body.answers) ? req.body.answers : [];

  if (req.session.scopeType !== 'staff_retail' || req.session.scopeKey !== `${outlet}|${name}`) {
    return res.status(403).json({ status: 'unauthorized' });
  }
  if (!answers.length) return res.status(400).json({ status: 'error', error: 'No answers submitted.' });

  const { rows } = await pool.query(
    'select created_at from results where name=$1 and outlet=$2 and topic=$3 order by created_at desc limit 1',
    [name, outlet, topic]
  );
  const alreadyToday = rows[0] && isSameCalendarDay(new Date(rows[0].created_at), new Date());
  if (alreadyToday) return res.json({ status: 'ok' });

  const ids = answers.map((a) => parseInt(a.id)).filter((n) => !isNaN(n));
  const { rows: questions } = await pool.query('select * from standard_questions where id = any($1) and topic = $2', [ids, topic]);
  // bigserial comes back as a string from node-pg — normalize to number so
  // Map lookups below (also parseInt'd) actually match.
  const byId = new Map(questions.map((q) => [parseInt(q.id), q]));

  let score = 0;
  const wrongRows = [];
  for (const a of answers) {
    const q = byId.get(parseInt(a.id));
    if (!q) continue; // unknown id or topic mismatch — counts as unanswered, not trusted
    const chosen = parseInt(a.chosen);
    if (chosen === q.correct) {
      score++;
    } else {
      const opts = [q.opt1_en, q.opt2_en, q.opt3_en, q.opt4_en];
      wrongRows.push({ question: q.question_en, chosen: opts[chosen] ?? '', correct: opts[q.correct] ?? '' });
    }
  }
  const total = answers.length;
  const percentage = Math.round((score / total) * 100);

  await pool.query(
    'insert into results (outlet, name, topic, score, percentage) values ($1,$2,$3,$4,$5)',
    [outlet, name, topic, `${score}/${total}`, `${percentage}%`]
  );
  for (const w of wrongRows) {
    await pool.query(
      'insert into wrong_answers (outlet, staff_name, topic, question, chosen, correct) values ($1,$2,$3,$4,$5,$6)',
      [outlet, name, topic, w.question, w.chosen, w.correct]
    );
  }
  res.json({ status: 'ok', score, total, percentage });
});

// Staff-triggered: save a completed AI Practice attempt. Grades server-side
// from a raw {index, chosen} answer array against the quiz's own stored
// questions_json (index = position in that array, AI-generated quizzes have
// no other stable per-question id). If the outlet's quiz row has since been
// overwritten by a new one (manager regenerated mid-attempt) or ended, this
// fails with a clear error instead of silently accepting a client-asserted
// score for a quiz that may no longer match what was actually taken.
dataRouter.post('/ai-results', requireAuth, async (req, res) => {
  const name = (req.body.name || '').toString().trim().toUpperCase();
  const outlet = (req.body.outlet || '').toString().trim().toUpperCase();
  const topic = (req.body.topic || 'N/A').toString().trim();
  const passcode = (req.body.passcode || '').toString().trim();
  const attemptId = (req.body.attemptId || `AI${Date.now()}`).toString();
  const answers = Array.isArray(req.body.answers) ? req.body.answers : [];

  const validScope = ['staff_retail', 'staff_warehouse'].includes(req.session.scopeType) && req.session.scopeKey === `${outlet}|${name}`;
  if (!validScope) return res.status(403).json({ status: 'unauthorized' });
  if (!answers.length) return res.status(400).json({ status: 'error', error: 'No answers submitted.' });

  const { rows } = await pool.query(
    'select created_at from ai_results where name=$1 and outlet=$2 and passcode=$3 order by created_at desc limit 1',
    [name, outlet, passcode]
  );
  const alreadyToday = rows[0] && isSameCalendarDay(new Date(rows[0].created_at), new Date());
  if (alreadyToday) return res.json({ status: 'ok' });

  const { rows: quizRows } = await pool.query('select questions_json from ai_quizzes where outlet=$1 and passcode=$2', [outlet, passcode]);
  const stored = quizRows[0]?.questions_json;
  if (!stored) return res.status(410).json({ status: 'error', error: 'This code has expired or been replaced — your progress could not be graded. Ask your manager for a fresh code.' });

  let score = 0;
  const wrongRows = [];
  for (const a of answers) {
    const q = stored[parseInt(a.index)];
    if (!q) continue;
    const chosen = parseInt(a.chosen);
    if (chosen === q.correct) {
      score++;
    } else {
      const opts = [q.opt1_en, q.opt2_en, q.opt3_en, q.opt4_en];
      wrongRows.push({ question: q.question_en, chosen: opts[chosen] ?? '', correct: opts[q.correct] ?? '' });
    }
  }
  const total = answers.length;
  const percentage = Math.round((score / total) * 100);

  await pool.query(
    'insert into ai_results (attempt_id, outlet, name, topic, score, percentage, passcode) values ($1,$2,$3,$4,$5,$6,$7)',
    [attemptId, outlet, name, topic, `${score}/${total}`, `${percentage}%`, passcode]
  );
  for (const w of wrongRows) {
    await pool.query(
      'insert into ai_wrong_answers (attempt_id, outlet, staff_name, topic, question, chosen, correct) values ($1,$2,$3,$4,$5,$6,$7)',
      [attemptId, outlet, name, topic, w.question, w.chosen, w.correct]
    );
  }
  res.json({ status: 'ok', score, total, percentage });
});
