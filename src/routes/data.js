import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
export async function outletsForArea(areaId) {
  const { rows } = await pool.query('select code from store_outlets where area_id = $1 and active', [areaId]);
  return rows.map(r => r.code);
}

export const dataRouter = Router();

function isSameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// CPD hours this calendar year, summed across all three sources:
// - results rows whose topic matches a video_trainings topic: that
//   video's real hours, every attempt counts (retakes stack).
// - results rows whose topic does NOT match a video_trainings topic
//   (i.e. Module Quiz): flat 1hr, but capped to the first attempt per
//   topic per year — count(distinct topic) rather than count(*), since
//   the rate is flat this is equivalent to "only the first attempt
//   counts" without needing to pick out which row is literally first.
//   Retaking the same topic on a different day still no-ops CPD hours,
//   it just isn't blocked from re-attempting (see POST /results'
//   same-day dedup for the separate once-a-day submission guard).
// - ai_results rows (always AI Practice, no topic check needed): flat
//   0.25hr each.
// See docs/superpowers/specs/2026-08-13-cpd-hours-revision-design.md.
async function cpdHoursThisYear(outlet, name) {
  const [video, moduleQuiz, aiPractice] = await Promise.all([
    pool.query(
      `select coalesce(sum(coalesce(vt.hours, 1)), 0) as hours
       from results r
       join video_trainings vt on vt.topic = r.topic
       where r.outlet = $1 and r.name = $2
         and extract(year from r.created_at) = extract(year from now())`,
      [outlet, name]
    ),
    pool.query(
      `select count(distinct r.topic) as topics
       from results r
       where r.outlet = $1 and r.name = $2
         and extract(year from r.created_at) = extract(year from now())
         and not exists (select 1 from video_trainings vt where vt.topic = r.topic)`,
      [outlet, name]
    ),
    pool.query(
      `select count(*) * 0.25 as hours
       from ai_results
       where outlet = $1 and name = $2
         and extract(year from created_at) = extract(year from now())`,
      [outlet, name]
    ),
  ]);
  return Number(video.rows[0].hours) + Number(moduleQuiz.rows[0].topics) + Number(aiPractice.rows[0].hours);
}

// Mirrors GAS's buildScopedData, minus reports/content/referenceDocs
// (still served from GAS — see CLAUDE.md / migration notes for why).
dataRouter.get('/scoped-data', requireAuth, async (req, res) => {
  const { scopeType, scopeKey } = req.session;
  const empty = { results: [], wrongAnswers: [], aiResults: [], aiWrongAnswers: [] };

  if (scopeType === 'staff_retail') {
    const [outlet, name] = scopeKey.split('|');
    const [results, wrong, aiResults, aiWrong, reports, hours] = await Promise.all([
      pool.query('select * from results where outlet=$1 and name=$2 order by created_at desc', [outlet, name]),
      pool.query('select * from wrong_answers where outlet=$1 and staff_name=$2 order by created_at desc', [outlet, name]),
      pool.query('select * from ai_results where outlet=$1 and name=$2 order by created_at desc', [outlet, name]),
      pool.query('select * from ai_wrong_answers where outlet=$1 and staff_name=$2 order by created_at desc', [outlet, name]),
      pool.query('select * from reports where outlet=$1 and staff_name=$2 order by created_at desc', [outlet, name]),
      cpdHoursThisYear(outlet, name),
    ]);
    return res.json({ ...toResponse(results.rows, wrong.rows, aiResults.rows, aiWrong.rows, reports.rows), cpdHoursThisYear: hours });
  }

  if (scopeType === 'staff_warehouse') {
    const [outlet, name] = scopeKey.split('|');
    const [aiResults, aiWrong, hours] = await Promise.all([
      pool.query('select * from ai_results where outlet=$1 and name=$2 order by created_at desc', [outlet, name]),
      pool.query('select * from ai_wrong_answers where outlet=$1 and staff_name=$2 order by created_at desc', [outlet, name]),
      cpdHoursThisYear(outlet, name),
    ]);
    return res.json({ ...toResponse([], [], aiResults.rows, aiWrong.rows), cpdHoursThisYear: hours });
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
    const outlets = await outletsForArea(scopeKey);
    const [results, wrong, aiResults, reports] = await Promise.all([
      pool.query('select * from results where outlet = ANY($1) order by created_at desc', [outlets]),
      pool.query('select * from wrong_answers where outlet = ANY($1) order by created_at desc', [outlets]),
      // Was hardcoded [] — Area Manager never got AI Practice data at all,
      // an existing gap this CPD hours feature needs fixed to count AI
      // Practice hours for this role too. No ai_wrong_answers query added
      // — nothing on this page reads AI Practice wrong-answer detail, out
      // of scope beyond unblocking the CPD summary (see the 2026-08-13
      // revision spec).
      pool.query('select * from ai_results where outlet = ANY($1) order by created_at desc', [outlets]),
      pool.query('select * from reports where outlet = ANY($1) order by created_at desc', [outlets]),
    ]);
    return res.json(toResponse(results.rows, wrong.rows, aiResults.rows, [], reports.rows));
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
// r.Outlet, r["Staff Name"], r["Question Text En"], etc. verbatim. Reports
// uses "Fluency" for the competency column — matches GAS's v1.34 relabel
// (UI calls it "Competency", sheet column name stayed "Fluency"). Wrong-
// answer fields are bilingual (En/Ms) so Quiz History can render a past
// wrong answer in whichever language is currently active — see
// scripts/migrate-wrong-answers-bilingual.js; Ms may be null for rows
// written before that migration.
function toResponse(results, wrong, aiResults, aiWrong, reports = []) {
  return {
    authorized: true,
    results: results.map(r => ({ Timestamp: r.created_at, AttemptID: r.attempt_id, Name: r.name, Outlet: r.outlet, Score: r.score, Percentage: r.percentage, Topic: r.topic })),
    wrongAnswers: wrong.map(w => ({
      Timestamp: w.created_at, AttemptID: w.attempt_id, 'Staff Name': w.staff_name, Outlet: w.outlet, Topic: w.topic,
      'Question Text En': w.question_en, 'Question Text Ms': w.question_ms,
      'User Choice En': w.chosen_en, 'User Choice Ms': w.chosen_ms,
      'Correct Answer En': w.correct_en, 'Correct Answer Ms': w.correct_ms,
    })),
    aiResults: aiResults.map(r => ({ Timestamp: r.created_at, AttemptID: r.attempt_id, Name: r.name, Outlet: r.outlet, Score: r.score, Percentage: r.percentage, Topic: r.topic, Passcode: r.passcode })),
    aiWrongAnswers: aiWrong.map(w => ({
      Timestamp: w.created_at, AttemptID: w.attempt_id, 'Staff Name': w.staff_name, Outlet: w.outlet, Topic: w.topic,
      'Question Text En': w.question_en, 'Question Text Ms': w.question_ms,
      'User Choice En': w.chosen_en, 'User Choice Ms': w.chosen_ms,
      'Correct Answer En': w.correct_en, 'Correct Answer Ms': w.correct_ms,
    })),
    reports: reports.map(r => ({
      Timestamp: r.created_at, Manager: r.manager, Outlet: r.outlet, 'Staff Name': r.staff_name,
      'Quiz Score': r.quiz_score, 'Training Title': r.topic, 'Skill Level': r.skill_level,
      'Performance Gaps': r.performance_gaps, Recommendations: r.recommendations,
      Fluency: r.competency, 'Product Knowledge Comments': r.product_knowledge_comments,
    })),
  };
}

// Staff-triggered: save a completed Standard Quiz attempt. Grades
// server-side against the topic's *actual* full question set — not the
// client-submitted answers array, which is untrusted both for content
// (chosen index) and for shape (which/how many questions it claims to
// cover). Submitting a subset (e.g. only known-correct answers) or a
// duplicated id can't inflate the score: `total` and the iteration are
// both driven by the real bank, and the client is only ever consulted for
// "what did they pick for question X", never "how many questions were
// there" or "which questions counted".
dataRouter.post('/results', requireAuth, async (req, res) => {
  const name = (req.body.name || '').toString().trim().toUpperCase();
  const outlet = (req.body.outlet || '').toString().trim().toUpperCase();
  const topic = (req.body.topic || 'N/A').toString().trim();
  const answers = Array.isArray(req.body.answers) ? req.body.answers : [];

  if (req.session.scopeType !== 'staff_retail' || req.session.scopeKey !== `${outlet}|${name}`) {
    return res.status(403).json({ status: 'unauthorized' });
  }

  const { rows } = await pool.query(
    'select created_at, score, percentage from results where name=$1 and outlet=$2 and topic=$3 order by created_at desc limit 1',
    [name, outlet, topic]
  );
  const alreadyToday = rows[0] && isSameCalendarDay(new Date(rows[0].created_at), new Date());
  if (alreadyToday) {
    const [prevScore, prevTotal] = (rows[0].score || '0/0').split('/').map(Number);
    return res.json({ status: 'ok', score: prevScore, total: prevTotal, percentage: parseInt(rows[0].percentage) || 0 });
  }

  const { rows: questions } = await pool.query("select * from standard_questions where topic = $1 and status = 'active' order by id", [topic]);
  if (!questions.length) return res.status(404).json({ status: 'error', error: 'No questions found for this module.' });

  // bigserial comes back as a string from node-pg — normalize to number.
  // Last submission for a given id wins if the client sent duplicates.
  const chosenById = new Map();
  for (const a of answers) chosenById.set(parseInt(a.id), parseInt(a.chosen));

  let score = 0;
  const wrongRows = [];
  for (const q of questions) {
    const chosen = chosenById.get(parseInt(q.id));
    if (chosen === q.correct) {
      score++;
    } else {
      const optsEn = [q.opt1_en, q.opt2_en, q.opt3_en, q.opt4_en];
      const optsMs = [q.opt1_ms, q.opt2_ms, q.opt3_ms, q.opt4_ms];
      wrongRows.push({
        questionEn: q.question_en, questionMs: q.question_ms,
        chosenEn: optsEn[chosen] ?? '(no answer)', chosenMs: optsMs[chosen] ?? '(tiada jawapan)',
        correctEn: optsEn[q.correct] ?? '', correctMs: optsMs[q.correct] ?? '',
      });
    }
  }
  const total = questions.length;
  const percentage = Math.round((score / total) * 100);
  // Own id (not shared with ai_results' "AI..." ids) so a retaken topic's
  // wrong answers can be scoped to this specific attempt in Quiz History,
  // instead of matched by topic alone — see migrate-add-attempt-id.js.
  const attemptId = `STD${Date.now()}`;

  await pool.query(
    'insert into results (attempt_id, outlet, name, topic, score, percentage) values ($1,$2,$3,$4,$5,$6)',
    [attemptId, outlet, name, topic, `${score}/${total}`, `${percentage}%`]
  );
  for (const w of wrongRows) {
    await pool.query(
      'insert into wrong_answers (attempt_id, outlet, staff_name, topic, question_en, question_ms, chosen_en, chosen_ms, correct_en, correct_ms) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [attemptId, outlet, name, topic, w.questionEn, w.questionMs, w.chosenEn, w.chosenMs, w.correctEn, w.correctMs]
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

  const { rows } = await pool.query(
    'select created_at, score, percentage from ai_results where name=$1 and outlet=$2 and passcode=$3 order by created_at desc limit 1',
    [name, outlet, passcode]
  );
  const alreadyToday = rows[0] && isSameCalendarDay(new Date(rows[0].created_at), new Date());
  if (alreadyToday) {
    const [prevScore, prevTotal] = (rows[0].score || '0/0').split('/').map(Number);
    return res.json({ status: 'ok', score: prevScore, total: prevTotal, percentage: parseInt(rows[0].percentage) || 0 });
  }

  const { rows: quizRows } = await pool.query('select questions_json from ai_quizzes where outlet=$1 and passcode=$2', [outlet, passcode]);
  const stored = quizRows[0]?.questions_json;
  if (!stored || !stored.length) return res.status(410).json({ status: 'error', error: 'This code has expired or been replaced — your progress could not be graded. Ask your manager for a fresh code.' });

  // Graded against the quiz's real, full question set — total and the
  // iteration are driven by `stored`, not by what the client claims it
  // submitted. Same reasoning as POST /results: a subset or duplicated
  // index in `answers` can't inflate the score.
  const chosenByIndex = new Map();
  for (const a of answers) chosenByIndex.set(parseInt(a.index), parseInt(a.chosen));

  let score = 0;
  const wrongRows = [];
  stored.forEach((q, i) => {
    const chosen = chosenByIndex.get(i);
    if (chosen === q.correct) {
      score++;
    } else {
      const optsEn = [q.opt1_en, q.opt2_en, q.opt3_en, q.opt4_en];
      const optsMs = [q.opt1_ms, q.opt2_ms, q.opt3_ms, q.opt4_ms];
      wrongRows.push({
        questionEn: q.question_en, questionMs: q.question_ms,
        chosenEn: optsEn[chosen] ?? '(no answer)', chosenMs: optsMs[chosen] ?? '(tiada jawapan)',
        correctEn: optsEn[q.correct] ?? '', correctMs: optsMs[q.correct] ?? '',
      });
    }
  });
  const total = stored.length;
  const percentage = Math.round((score / total) * 100);

  await pool.query(
    'insert into ai_results (attempt_id, outlet, name, topic, score, percentage, passcode) values ($1,$2,$3,$4,$5,$6,$7)',
    [attemptId, outlet, name, topic, `${score}/${total}`, `${percentage}%`, passcode]
  );
  for (const w of wrongRows) {
    await pool.query(
      'insert into ai_wrong_answers (attempt_id, outlet, staff_name, topic, question_en, question_ms, chosen_en, chosen_ms, correct_en, correct_ms) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [attemptId, outlet, name, topic, w.questionEn, w.questionMs, w.chosenEn, w.chosenMs, w.correctEn, w.correctMs]
    );
  }
  res.json({ status: 'ok', score, total, percentage });
});

// Staff-triggered: save a completed video-training quiz attempt. Mirrors
// POST /results exactly (server-authoritative grading against the real
// question bank, same-day no-op, same wrong_answers write) except it reads
// from video_questions instead of standard_questions, and writes into the
// same `results` table Module Quiz uses — topic alone distinguishes a
// video-training attempt in Quiz History/the dashboard average, no new
// table or column needed.
dataRouter.post('/video-results', requireAuth, async (req, res) => {
  const name = (req.body.name || '').toString().trim().toUpperCase();
  const outlet = (req.body.outlet || '').toString().trim().toUpperCase();
  const topic = (req.body.topic || 'N/A').toString().trim();
  const answers = Array.isArray(req.body.answers) ? req.body.answers : [];

  if (req.session.scopeType !== 'staff_retail' || req.session.scopeKey !== `${outlet}|${name}`) {
    return res.status(403).json({ status: 'unauthorized' });
  }

  const { rows } = await pool.query(
    'select created_at, score, percentage from results where name=$1 and outlet=$2 and topic=$3 order by created_at desc limit 1',
    [name, outlet, topic]
  );
  const alreadyToday = rows[0] && isSameCalendarDay(new Date(rows[0].created_at), new Date());
  if (alreadyToday) {
    const [prevScore, prevTotal] = (rows[0].score || '0/0').split('/').map(Number);
    return res.json({ status: 'ok', score: prevScore, total: prevTotal, percentage: parseInt(rows[0].percentage) || 0 });
  }

  const { rows: questions } = await pool.query("select * from video_questions where topic = $1 and status = 'active' order by id", [topic]);
  if (!questions.length) return res.status(404).json({ status: 'error', error: 'No questions found for this video.' });

  const chosenById = new Map();
  for (const a of answers) chosenById.set(parseInt(a.id), parseInt(a.chosen));

  let score = 0;
  const wrongRows = [];
  for (const q of questions) {
    const chosen = chosenById.get(parseInt(q.id));
    if (chosen === q.correct) {
      score++;
    } else {
      const optsEn = [q.opt1_en, q.opt2_en, q.opt3_en, q.opt4_en];
      const optsMs = [q.opt1_ms, q.opt2_ms, q.opt3_ms, q.opt4_ms];
      wrongRows.push({
        questionEn: q.question_en, questionMs: q.question_ms,
        chosenEn: optsEn[chosen] ?? '(no answer)', chosenMs: optsMs[chosen] ?? '(tiada jawapan)',
        correctEn: optsEn[q.correct] ?? '', correctMs: optsMs[q.correct] ?? '',
      });
    }
  }
  const total = questions.length;
  const percentage = Math.round((score / total) * 100);
  const attemptId = `VID${Date.now()}`;

  await pool.query(
    'insert into results (attempt_id, outlet, name, topic, score, percentage) values ($1,$2,$3,$4,$5,$6)',
    [attemptId, outlet, name, topic, `${score}/${total}`, `${percentage}%`]
  );
  for (const w of wrongRows) {
    await pool.query(
      'insert into wrong_answers (attempt_id, outlet, staff_name, topic, question_en, question_ms, chosen_en, chosen_ms, correct_en, correct_ms) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [attemptId, outlet, name, topic, w.questionEn, w.questionMs, w.chosenEn, w.chosenMs, w.correctEn, w.correctMs]
    );
  }
  res.json({ status: 'ok', score, total, percentage });
});

// Staff-triggered: save a completed Browse-Courses reading-quiz attempt.
// Direct copy of POST /video-results (server-authoritative grading,
// same-day no-op, same wrong_answers write) except it reads from
// content_questions instead of video_questions. Writes into the same
// `results` table Module Quiz/Video Training already share — topic
// membership in `content` (where quiz_required) is the third
// discriminator. Retail-only, same as Module Quiz/Video Training. See
// docs/superpowers/specs/2026-08-17-content-reading-quiz-design.md.
dataRouter.post('/content-results', requireAuth, async (req, res) => {
  const name = (req.body.name || '').toString().trim().toUpperCase();
  const outlet = (req.body.outlet || '').toString().trim().toUpperCase();
  const topic = (req.body.topic || 'N/A').toString().trim();
  const answers = Array.isArray(req.body.answers) ? req.body.answers : [];

  if (req.session.scopeType !== 'staff_retail' || req.session.scopeKey !== `${outlet}|${name}`) {
    return res.status(403).json({ status: 'unauthorized' });
  }

  const { rows } = await pool.query(
    'select created_at, score, percentage from results where name=$1 and outlet=$2 and topic=$3 order by created_at desc limit 1',
    [name, outlet, topic]
  );
  const alreadyToday = rows[0] && isSameCalendarDay(new Date(rows[0].created_at), new Date());
  if (alreadyToday) {
    const [prevScore, prevTotal] = (rows[0].score || '0/0').split('/').map(Number);
    return res.json({ status: 'ok', score: prevScore, total: prevTotal, percentage: parseInt(rows[0].percentage) || 0 });
  }

  const { rows: questions } = await pool.query("select * from content_questions where topic = $1 and status = 'active' order by id", [topic]);
  if (!questions.length) return res.status(404).json({ status: 'error', error: 'No questions found for this material.' });

  const chosenById = new Map();
  for (const a of answers) chosenById.set(parseInt(a.id), parseInt(a.chosen));

  let score = 0;
  const wrongRows = [];
  for (const q of questions) {
    const chosen = chosenById.get(parseInt(q.id));
    if (chosen === q.correct) {
      score++;
    } else {
      const optsEn = [q.opt1_en, q.opt2_en, q.opt3_en, q.opt4_en];
      const optsMs = [q.opt1_ms, q.opt2_ms, q.opt3_ms, q.opt4_ms];
      wrongRows.push({
        questionEn: q.question_en, questionMs: q.question_ms,
        chosenEn: optsEn[chosen] ?? '(no answer)', chosenMs: optsMs[chosen] ?? '(tiada jawapan)',
        correctEn: optsEn[q.correct] ?? '', correctMs: optsMs[q.correct] ?? '',
      });
    }
  }
  const total = questions.length;
  const percentage = Math.round((score / total) * 100);
  const attemptId = `CNT${Date.now()}`;

  await pool.query(
    'insert into results (attempt_id, outlet, name, topic, score, percentage) values ($1,$2,$3,$4,$5,$6)',
    [attemptId, outlet, name, topic, `${score}/${total}`, `${percentage}%`]
  );
  for (const w of wrongRows) {
    await pool.query(
      'insert into wrong_answers (attempt_id, outlet, staff_name, topic, question_en, question_ms, chosen_en, chosen_ms, correct_en, correct_ms) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [attemptId, outlet, name, topic, w.questionEn, w.questionMs, w.chosenEn, w.chosenMs, w.correctEn, w.correctMs]
    );
  }
  res.json({ status: 'ok', score, total, percentage });
});
