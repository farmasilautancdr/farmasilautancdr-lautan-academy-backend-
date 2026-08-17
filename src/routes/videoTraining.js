import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth, requireScope } from '../middleware/auth.js';
import { hitRateLimit } from '../middleware/rateLimit.js';
import { logAuditSafe } from '../services/auditLog.js';

export const videoTrainingsRouter = Router();
export const videoQuestionsRouter = Router();

// Only lists a video if its topic currently has >=1 active question in
// video_questions — a staff member can never finish watching a video and
// then hit "no questions found" on the quiz that follows it. Server-
// authoritative (a join/exists check), not a client-side filter.
videoTrainingsRouter.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    select vt.id, vt.title, vt.topic, vt.youtube_url, vt.hours, vt.kind, vt.body
    from video_trainings vt
    where vt.pharmacist_only = false
      and exists (
        select 1 from video_questions vq
        where vq.topic = vt.topic and vq.status = 'active'
      )
    order by vt.title
  `);
  res.json({
    videoTrainings: rows.map(v => ({
      id: v.id, title: v.title, topic: v.topic, youtubeUrl: v.youtube_url,
      hours: Number(v.hours), kind: v.kind, body: v.body,
    })),
  });
});

// Live DB check every request — the client's isPharmacist flag (set at
// login) only controls nav visibility, never authorization. See
// docs/superpowers/specs/2026-08-13-pharmacist-tag-design.md.
videoTrainingsRouter.get('/pharmacist', requireAuth, async (req, res) => {
  const scopeType = req.session.scopeType;
  // Supervisor manages this content (add-course form), so it needs to see
  // it here too — skips the per-staff tag check below, which only applies
  // to staff consuming the gated list.
  if (scopeType !== 'supervisor') {
    if (scopeType !== 'staff_retail' && scopeType !== 'staff_warehouse') {
      return res.status(403).json({ status: 'error', error: 'Not authorized.' });
    }
    const [outlet, name] = (req.session.scopeKey || '').split('|');
    const division = scopeType === 'staff_warehouse' ? 'warehouse' : 'retail';
    const { rows: staffRows } = await pool.query(
      'select is_pharmacist from staff_roster where division = $1 and outlet = $2 and name = $3',
      [division, outlet, name]
    );
    if (!staffRows[0]?.is_pharmacist) {
      return res.status(403).json({ status: 'error', error: 'Not authorized.' });
    }
  }

  const { rows } = await pool.query(`
    select vt.id, vt.title, vt.topic, vt.youtube_url, vt.hours, vt.kind, vt.body
    from video_trainings vt
    where vt.pharmacist_only = true
      and exists (
        select 1 from video_questions vq
        where vq.topic = vt.topic and vq.status = 'active'
      )
    order by vt.title
  `);
  res.json({
    videoTrainings: rows.map(v => ({
      id: v.id, title: v.title, topic: v.topic, youtubeUrl: v.youtube_url,
      hours: Number(v.hours), kind: v.kind, body: v.body,
    })),
  });
});

// Accepts youtube.com/watch?v=<id>, youtube.com/embed/<id>, or
// youtu.be/<id> — rejects anything else so a Supervisor can't get an
// arbitrary iframe embedded via this field. Parses as a real URL and
// checks the hostname exactly (not a substring/regex match against the
// raw string), so e.g. "https://evil.example/?u=youtube.com/watch?v=..."
// can't sneak past by containing the right substring anywhere.
function extractYouTubeId(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  const idPattern = /^[a-zA-Z0-9_-]{11}$/;
  if (host === 'youtube.com') {
    if (parsed.pathname === '/watch') {
      const id = parsed.searchParams.get('v');
      return id && idPattern.test(id) ? id : null;
    }
    const embedMatch = parsed.pathname.match(/^\/embed\/([a-zA-Z0-9_-]{11})$/);
    return embedMatch ? embedMatch[1] : null;
  }
  if (host === 'youtu.be') {
    const shortMatch = parsed.pathname.match(/^\/([a-zA-Z0-9_-]{11})$/);
    return shortMatch ? shortMatch[1] : null;
  }
  return null;
}

// Matches content.js's Supervisor-only add/delete gating and audit-log
// convention exactly.
videoTrainingsRouter.post('/', requireAuth, requireScope('supervisor'), async (req, res) => {
  const title = (req.body.title || '').toString().trim();
  const topic = (req.body.topic || '').toString().trim();
  const kind = (req.body.kind || 'video').toString().trim();
  const youtubeUrl = (req.body.youtubeUrl || '').toString().trim();
  const body = (req.body.body || '').toString().trim();
  const pharmacistOnly = !!req.body.pharmacistOnly;
  const hours = parseFloat(req.body.hours);

  if (!['video', 'reading'].includes(kind)) {
    return res.status(400).json({ status: 'error', error: 'Kind must be video or reading.' });
  }
  if (!title || !topic) {
    return res.status(400).json({ status: 'error', error: 'Title and topic are required.' });
  }
  if (kind === 'video') {
    if (!youtubeUrl) {
      return res.status(400).json({ status: 'error', error: 'YouTube link is required.' });
    }
    if (!extractYouTubeId(youtubeUrl)) {
      return res.status(400).json({ status: 'error', error: 'Not a recognized YouTube link (expected a youtube.com/watch?v=... or youtu.be/... URL).' });
    }
  } else if (!body) {
    return res.status(400).json({ status: 'error', error: 'Reading material body is required.' });
  }
  if (!Number.isFinite(hours) || hours <= 0) {
    return res.status(400).json({ status: 'error', error: 'Hours must be a positive number.' });
  }

  const { rows } = await pool.query(
    'insert into video_trainings (title, topic, youtube_url, hours, kind, pharmacist_only, body) values ($1,$2,$3,$4,$5,$6,$7) returning id',
    [title, topic, kind === 'video' ? youtubeUrl : null, hours, kind, pharmacistOnly, kind === 'reading' ? body : null]
  );
  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'video_training.add',
    summary: `Added ${kind} training "${title}" (${topic})${pharmacistOnly ? ', pharmacist-only' : ''}`,
  });
  res.json({ status: 'ok', id: rows[0].id });
});

videoTrainingsRouter.delete('/:id', requireAuth, requireScope('supervisor'), async (req, res) => {
  await pool.query('delete from video_trainings where id = $1', [req.params.id]);
  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'video_training.delete',
    summary: `Deleted video training id ${req.params.id}`,
  });
  res.json({ status: 'ok' });
});

// Scoped to one topic (the watch page already knows which topic it needs
// once the video ends) — mirrors GET /questions but doesn't ship the whole
// bank for every request.
videoQuestionsRouter.get('/', requireAuth, async (req, res) => {
  const topic = (req.query.topic || '').toString().trim();
  if (!topic) return res.json({ questions: [] });
  const { rows } = await pool.query(
    "select * from video_questions where topic = $1 and status = 'active' order by id",
    [topic]
  );
  res.json({
    questions: rows.map((q) => ({
      id: q.id,
      topic: q.topic,
      question_en: q.question_en,
      question_ms: q.question_ms,
      opt1_en: q.opt1_en, opt2_en: q.opt2_en, opt3_en: q.opt3_en, opt4_en: q.opt4_en,
      opt1_ms: q.opt1_ms, opt2_ms: q.opt2_ms, opt3_ms: q.opt3_ms, opt4_ms: q.opt4_ms,
      status: q.status,
    })),
  });
});

// Live per-question reveal while taking a video-training quiz — mirrors
// POST /questions/:id/check exactly, against video_questions instead of
// standard_questions. Not authoritative on its own: POST /data/video-
// results re-grades the full submitted answer set independently.
videoQuestionsRouter.post('/:id/check', requireAuth, async (req, res) => {
  if (await hitRateLimit(`check_video_${req.session.scopeKey}`, 80, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many checks — slow down and try again shortly.' });
  }
  const id = parseInt(req.params.id);
  const chosen = parseInt(req.body.chosen);
  const { rows } = await pool.query('select correct from video_questions where id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Question not found.' });
  const correctIndex = rows[0].correct;
  res.json({ correct: chosen === correctIndex, correctIndex });
});

// Supervisor-only CRUD over the quiz bank itself — GET (list by topic) and
// POST /:id/check already existed for taking a quiz; these three add
// management. `topic` is validated against real video_trainings rows (not
// just non-empty) because the topic/video_trainings join elsewhere in this
// file is a plain string match with no FK — a typo here would silently
// orphan the question with no error anywhere.
async function topicExists(topic) {
  const { rows } = await pool.query(
    'select 1 from video_trainings where topic = $1 limit 1',
    [topic]
  );
  return rows.length > 0;
}

function validateQuestionBody(body) {
  const topic = (body.topic || '').toString().trim();
  const type = (body.type || '').toString().trim();
  const question_en = (body.question_en || '').toString().trim();
  const question_ms = (body.question_ms || '').toString().trim();
  const opt1_en = (body.opt1_en || '').toString().trim();
  const opt2_en = (body.opt2_en || '').toString().trim();
  const opt3_en = (body.opt3_en || '').toString().trim();
  const opt4_en = (body.opt4_en || '').toString().trim();
  const opt1_ms = (body.opt1_ms || '').toString().trim();
  const opt2_ms = (body.opt2_ms || '').toString().trim();
  const opt3_ms = (body.opt3_ms || '').toString().trim();
  const opt4_ms = (body.opt4_ms || '').toString().trim();
  const correct = parseInt(body.correct);

  if (!['mcq', 'tf'].includes(type)) {
    return { error: 'Type must be mcq or tf.' };
  }
  if (!topic) {
    return { error: 'Topic is required.' };
  }
  if (!question_en || !question_ms) {
    return { error: 'Question text (EN and MS) is required.' };
  }
  if (type === 'mcq') {
    if (!opt1_en || !opt2_en || !opt3_en || !opt4_en || !opt1_ms || !opt2_ms || !opt3_ms || !opt4_ms) {
      return { error: 'All 4 options (EN and MS) are required for a multiple-choice question.' };
    }
    if (!Number.isInteger(correct) || correct < 0 || correct > 3) {
      return { error: 'Correct answer must be option 1-4 for a multiple-choice question.' };
    }
    return {
      row: { topic, question_en, question_ms, opt1_en, opt2_en, opt3_en, opt4_en, opt1_ms, opt2_ms, opt3_ms, opt4_ms, correct },
    };
  }
  // type === 'tf'
  if (!opt1_en || !opt2_en || !opt1_ms || !opt2_ms) {
    return { error: 'Both options (EN and MS) are required for a True/False question.' };
  }
  if (!Number.isInteger(correct) || correct < 0 || correct > 1) {
    return { error: 'Correct answer must be option 1-2 for a True/False question.' };
  }
  return {
    row: { topic, question_en, question_ms, opt1_en, opt2_en, opt3_en: '', opt4_en: '', opt1_ms, opt2_ms, opt3_ms: '', opt4_ms: '', correct },
  };
}

videoQuestionsRouter.post('/', requireAuth, requireScope('supervisor'), async (req, res) => {
  const { error, row } = validateQuestionBody(req.body);
  if (error) return res.status(400).json({ status: 'error', error });

  if (!(await topicExists(row.topic))) {
    return res.status(400).json({ status: 'error', error: `Unknown topic '${row.topic}' — no course with this topic exists.` });
  }

  const { rows } = await pool.query(
    `insert into video_questions
      (topic, question_en, question_ms, opt1_en, opt2_en, opt3_en, opt4_en, opt1_ms, opt2_ms, opt3_ms, opt4_ms, correct, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active')
     returning id`,
    [row.topic, row.question_en, row.question_ms, row.opt1_en, row.opt2_en, row.opt3_en, row.opt4_en, row.opt1_ms, row.opt2_ms, row.opt3_ms, row.opt4_ms, row.correct]
  );
  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'video_question.add',
    summary: `Added question to topic "${row.topic}": ${row.question_en.slice(0, 60)}`,
  });
  res.json({ status: 'ok', id: rows[0].id });
});

// Full-row overwrite, not partial PATCH semantics — a question's fields
// are all interdependent on `type` (tf forces opt3/opt4 blank), so
// re-validating and re-writing every field avoids a stale mismatched
// field surviving a type change.
videoQuestionsRouter.patch('/:id', requireAuth, requireScope('supervisor'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { rows: existingRows } = await pool.query('select id from video_questions where id = $1', [id]);
  if (!existingRows[0]) return res.status(404).json({ status: 'error', error: 'Question not found.' });

  const { error, row } = validateQuestionBody(req.body);
  if (error) return res.status(400).json({ status: 'error', error });

  if (!(await topicExists(row.topic))) {
    return res.status(400).json({ status: 'error', error: `Unknown topic '${row.topic}' — no course with this topic exists.` });
  }

  await pool.query(
    `update video_questions set
      topic=$1, question_en=$2, question_ms=$3,
      opt1_en=$4, opt2_en=$5, opt3_en=$6, opt4_en=$7,
      opt1_ms=$8, opt2_ms=$9, opt3_ms=$10, opt4_ms=$11,
      correct=$12
     where id=$13`,
    [row.topic, row.question_en, row.question_ms, row.opt1_en, row.opt2_en, row.opt3_en, row.opt4_en, row.opt1_ms, row.opt2_ms, row.opt3_ms, row.opt4_ms, row.correct, id]
  );
  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'video_question.update',
    summary: `Updated question ${id} (topic "${row.topic}")`,
  });
  res.json({ status: 'ok' });
});
