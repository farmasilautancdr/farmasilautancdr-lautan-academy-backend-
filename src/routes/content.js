import { Router } from 'express';
import multer from 'multer';
import { pool } from '../config/db.js';
import { requireAuth, requireScope } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { logAuditSafe } from '../services/auditLog.js';
import { hitRateLimit } from '../middleware/rateLimit.js';

export const contentRouter = Router();

const BUCKET = 'content-files';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = /^(application\/(pdf|msword|vnd\.openxmlformats-officedocument\.|vnd\.ms-)|image\/(jpeg|png|webp))/;
    cb(null, allowed.test(file.mimetype));
  },
});

// Uploads straight to Supabase Storage (same project as the DB) via its
// REST API — the service-role key never reaches the browser, only this
// server holds it. Returns a public URL that goes straight into the
// Content entry's `link` field.
contentRouter.post('/upload', requireAuth, requireScope('supervisor'), upload.single('file'), async (req, res) => {
  if (!env.supabaseUrl || !env.supabaseServiceKey) {
    return res.status(500).json({ error: 'File upload is not configured on this server.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No file received, or the file type/size was rejected (20MB max; PDF, Word, PowerPoint, or images only).' });
  }

  const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${Date.now()}-${safeName}`;

  const uploadRes = await fetch(`${env.supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.supabaseServiceKey}`,
      apikey: env.supabaseServiceKey,
      'Content-Type': req.file.mimetype,
    },
    body: req.file.buffer,
  });
  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    return res.status(502).json({ error: `Upload failed: ${errText.slice(0, 300)}` });
  }

  res.json({ url: `${env.supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}` });
});

// Company-wide, not outlet-scoped — any authenticated role can read.
// QuizReady mirrors GET /video-trainings' own exists-check: a
// quiz_required entry only becomes actionable for staff once it has
// at least one active question, so a staff member can't tap into a
// dead end (see docs/superpowers/specs/2026-08-17-content-reading-quiz-design.md).
contentRouter.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    select c.id, c.topic, c.category, c.title, c.body, c.link, c.created_at,
      c.quiz_required, c.hours,
      exists (
        select 1 from content_questions cq
        where cq.topic = c.topic and cq.status = 'active'
      ) as quiz_ready
    from content c
    order by c.topic, c.title
  `);
  res.json({
    content: rows.map(c => ({
      ID: c.id, Topic: c.topic, Category: c.category, Title: c.title, Body: c.body, Link: c.link, Timestamp: c.created_at,
      QuizRequired: c.quiz_required, Hours: Number(c.hours), QuizReady: c.quiz_ready,
    })),
  });
});

// Matches GAS's handleSaveContent gating — Supervisor only. quizRequired/
// hours are optional (default false/1) so existing callers/behavior are
// unchanged; hours is only ever read when quizRequired is true.
contentRouter.post('/', requireAuth, requireScope('supervisor'), async (req, res) => {
  const topic = (req.body.topic || '').toString().trim();
  const category = (req.body.category || '').toString().trim();
  const title = (req.body.title || '').toString().trim();
  const body = (req.body.body || '').toString().trim();
  const link = (req.body.link || '').toString().trim();
  const quizRequired = !!req.body.quizRequired;
  const hoursRaw = req.body.hours;
  const hours = hoursRaw === undefined || hoursRaw === null || hoursRaw === '' ? 1 : Number(hoursRaw);
  if (!topic) {
    return res.status(400).json({ status: 'error', error: 'Topic is required.' });
  }
  if (quizRequired && (!Number.isFinite(hours) || hours <= 0)) {
    return res.status(400).json({ status: 'error', error: 'Hours must be a positive number.' });
  }
  const { rows } = await pool.query(
    'insert into content (topic, category, title, body, link, quiz_required, hours) values ($1,$2,$3,$4,$5,$6,$7) returning id',
    [topic, category, title, body, link, quizRequired, quizRequired ? hours : 1]
  );
  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'content.add',
    summary: `Added content "${title || '(untitled)'}" (${topic})${quizRequired ? ` [quiz required, ${hours}h]` : ''}`,
  });
  res.json({ status: 'ok', id: rows[0].id });
});

// Lets Supervisor swap the attached file (or edit any field) in place —
// same topic string stays intact, so content_questions (topic-text-keyed,
// no FK — see schema.sql comment) never gets orphaned the way a
// delete-then-recreate-with-a-typo'd-topic silently would.
contentRouter.patch('/:id', requireAuth, requireScope('supervisor'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { rows: existingRows } = await pool.query('select id from content where id = $1', [id]);
  if (!existingRows[0]) return res.status(404).json({ status: 'error', error: 'Content entry not found.' });

  const topic = (req.body.topic || '').toString().trim();
  const category = (req.body.category || '').toString().trim();
  const title = (req.body.title || '').toString().trim();
  const body = (req.body.body || '').toString().trim();
  const link = (req.body.link || '').toString().trim();
  const quizRequired = !!req.body.quizRequired;
  const hoursRaw = req.body.hours;
  const hours = hoursRaw === undefined || hoursRaw === null || hoursRaw === '' ? 1 : Number(hoursRaw);
  if (!topic) {
    return res.status(400).json({ status: 'error', error: 'Topic is required.' });
  }
  if (quizRequired && (!Number.isFinite(hours) || hours <= 0)) {
    return res.status(400).json({ status: 'error', error: 'Hours must be a positive number.' });
  }

  await pool.query(
    'update content set topic=$1, category=$2, title=$3, body=$4, link=$5, quiz_required=$6, hours=$7 where id=$8',
    [topic, category, title, body, link, quizRequired, quizRequired ? hours : 1, id]
  );
  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'content.update',
    summary: `Updated content "${title || '(untitled)'}" (${topic})${quizRequired ? ` [quiz required, ${hours}h]` : ''}`,
  });
  res.json({ status: 'ok' });
});

contentRouter.delete('/:id', requireAuth, requireScope('supervisor'), async (req, res) => {
  await pool.query('delete from content where id = $1', [req.params.id]);
  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'content.delete',
    summary: `Deleted content id ${req.params.id}`,
  });
  res.json({ status: 'ok' });
});

// Content quiz bank — direct copy of video_questions' router shape in
// routes/videoTraining.js (topic validated against real content rows,
// no FK; MCQ 4-option or True/False 2-option; hard delete blocked on a
// topic's last question). See
// docs/superpowers/specs/2026-08-17-content-reading-quiz-design.md.
export const contentQuestionsRouter = Router();

contentQuestionsRouter.get('/', requireAuth, async (req, res) => {
  const topic = (req.query.topic || '').toString().trim();
  if (!topic) return res.json({ questions: [] });
  const { rows } = await pool.query(
    "select id, topic, question_en, question_ms, opt1_en, opt2_en, opt3_en, opt4_en, opt1_ms, opt2_ms, opt3_ms, opt4_ms from content_questions where topic = $1 and status = 'active' order by id",
    [topic]
  );
  res.json({ questions: rows });
});

contentQuestionsRouter.post('/:id/check', requireAuth, async (req, res) => {
  if (await hitRateLimit(`check_content_${req.session.scopeKey}`, 80, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many checks — slow down and try again shortly.' });
  }
  const id = parseInt(req.params.id);
  const chosen = parseInt(req.body.chosen);
  const { rows } = await pool.query('select correct from content_questions where id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Question not found.' });
  const correctIndex = rows[0].correct;
  res.json({ correct: chosen === correctIndex, correctIndex });
});

async function contentTopicExists(topic) {
  const { rows } = await pool.query('select 1 from content where topic = $1 limit 1', [topic]);
  return rows.length > 0;
}

function validateContentQuestionBody(body) {
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

  if (!topic) return { error: 'Topic is required.' };
  if (!['mcq', 'tf'].includes(type)) return { error: 'Type must be mcq or tf.' };
  if (!question_en || !question_ms) return { error: 'Question text (En and Ms) is required.' };
  if (!opt1_en || !opt2_en || !opt1_ms || !opt2_ms) return { error: 'At least two options (En and Ms) are required.' };
  if (type === 'mcq' && (!opt3_en || !opt4_en || !opt3_ms || !opt4_ms)) return { error: 'MCQ requires all four options (En and Ms).' };
  const maxCorrect = type === 'mcq' ? 3 : 1;
  if (!Number.isInteger(correct) || correct < 0 || correct > maxCorrect) return { error: `Correct must be an integer between 0 and ${maxCorrect} for this type.` };

  return {
    row: {
      topic, question_en, question_ms,
      opt1_en, opt2_en,
      opt3_en: type === 'mcq' ? opt3_en : '', opt4_en: type === 'mcq' ? opt4_en : '',
      opt1_ms, opt2_ms,
      opt3_ms: type === 'mcq' ? opt3_ms : '', opt4_ms: type === 'mcq' ? opt4_ms : '',
      correct,
    },
  };
}

contentQuestionsRouter.post('/', requireAuth, requireScope('supervisor'), async (req, res) => {
  const { error, row } = validateContentQuestionBody(req.body);
  if (error) return res.status(400).json({ status: 'error', error });

  if (!(await contentTopicExists(row.topic))) {
    return res.status(400).json({ status: 'error', error: `Unknown topic '${row.topic}' — no content entry with this topic exists.` });
  }

  const { rows } = await pool.query(
    `insert into content_questions
      (topic, question_en, question_ms, opt1_en, opt2_en, opt3_en, opt4_en, opt1_ms, opt2_ms, opt3_ms, opt4_ms, correct, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active')
     returning id`,
    [row.topic, row.question_en, row.question_ms, row.opt1_en, row.opt2_en, row.opt3_en, row.opt4_en, row.opt1_ms, row.opt2_ms, row.opt3_ms, row.opt4_ms, row.correct]
  );
  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'content_question.add',
    summary: `Added content question to topic "${row.topic}": ${row.question_en.slice(0, 60)}`,
  });
  res.json({ status: 'ok', id: rows[0].id });
});

contentQuestionsRouter.patch('/:id', requireAuth, requireScope('supervisor'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { rows: existingRows } = await pool.query('select id from content_questions where id = $1', [id]);
  if (!existingRows[0]) return res.status(404).json({ status: 'error', error: 'Question not found.' });

  const { error, row } = validateContentQuestionBody(req.body);
  if (error) return res.status(400).json({ status: 'error', error });

  if (!(await contentTopicExists(row.topic))) {
    return res.status(400).json({ status: 'error', error: `Unknown topic '${row.topic}' — no content entry with this topic exists.` });
  }

  await pool.query(
    `update content_questions set
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
    action: 'content_question.update',
    summary: `Updated content question ${id} (topic "${row.topic}")`,
  });
  res.json({ status: 'ok' });
});

contentQuestionsRouter.delete('/:id', requireAuth, requireScope('supervisor'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { rows } = await pool.query('select topic from content_questions where id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ status: 'error', error: 'Question not found.' });
  const topic = rows[0].topic;

  const { rows: siblingRows } = await pool.query(
    'select count(*)::int as count from content_questions where topic = $1 and id != $2',
    [topic, id]
  );
  if (siblingRows[0].count === 0) {
    return res.status(400).json({
      status: 'error',
      error: `Can't delete: this is the only question left for "${topic}" — the quiz would disappear from staff view.`,
    });
  }

  await pool.query('delete from content_questions where id = $1', [id]);
  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'content_question.delete',
    summary: `Deleted content question ${id} (topic "${topic}")`,
  });
  res.json({ status: 'ok' });
});
