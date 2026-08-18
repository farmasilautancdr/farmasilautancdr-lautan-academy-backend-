import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth, requireScope } from '../middleware/auth.js';
import { hitRateLimit } from '../middleware/rateLimit.js';
import { logAuditSafe } from '../services/auditLog.js';

export const questionsRouter = Router();

// Public, no auth — matches GAS's doGet(), which served the whole question
// bank before login too. `correct` is withheld now (server grades attempts
// itself, see POST /data/results) — `id` is included instead so a client
// can reference a specific question when submitting answers.
questionsRouter.get('/', async (req, res) => {
  const { rows } = await pool.query('select * from standard_questions order by id');
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

// Live per-question reveal while taking a Module Quiz — grades one answer
// against the real stored value without exposing the whole answer key
// upfront. Not authoritative on its own: POST /data/results re-grades the
// full submitted answer set independently at the end, so a tampered
// response here can't change what actually gets saved.
//
// Rate-limited: a real attempt only ever needs one check per question
// (the frontend locks a question in once answered) — without a cap,
// looping this endpoint across every id/option would just rebuild the same
// full answer key this change was meant to stop exposing, one call at a
// time instead of one response.
questionsRouter.post('/:id/check', requireAuth, async (req, res) => {
  if (await hitRateLimit(`check_std_${req.session.scopeKey}`, 80, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many checks — slow down and try again shortly.' });
  }
  const id = parseInt(req.params.id);
  const chosen = parseInt(req.body.chosen);
  const { rows } = await pool.query('select correct from standard_questions where id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Question not found.' });
  const correctIndex = rows[0].correct;
  res.json({ correct: chosen === correctIndex, correctIndex });
});

// Supervisor-only CRUD over the Module Quiz bank itself — mirrors
// video_questions' equivalent (routes/videoTraining.js) field-for-field,
// with one deliberate difference: standard_questions has no parent
// "course" table (video_trainings), so there's no topicExists() check —
// ModuleQuizView.vue derives its own topic list straight from this table's
// distinct `topic` values, meaning a topic comes into existence the moment
// its first question is added. Any non-empty topic string is valid.
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

questionsRouter.post('/', requireAuth, requireScope('supervisor'), async (req, res) => {
  const { error, row } = validateQuestionBody(req.body);
  if (error) return res.status(400).json({ status: 'error', error });

  const { rows } = await pool.query(
    `insert into standard_questions
      (topic, question_en, question_ms, opt1_en, opt2_en, opt3_en, opt4_en, opt1_ms, opt2_ms, opt3_ms, opt4_ms, correct, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active')
     returning id`,
    [row.topic, row.question_en, row.question_ms, row.opt1_en, row.opt2_en, row.opt3_en, row.opt4_en, row.opt1_ms, row.opt2_ms, row.opt3_ms, row.opt4_ms, row.correct]
  );
  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'question.add',
    summary: `Added question to topic "${row.topic}": ${row.question_en.slice(0, 60)}`,
  });
  res.json({ status: 'ok', id: rows[0].id });
});

// Full-row overwrite, not partial PATCH semantics — same reasoning as
// video_questions' equivalent (a tf-vs-mcq type change must not leave a
// stale opt3/opt4 behind).
questionsRouter.patch('/:id', requireAuth, requireScope('supervisor'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { rows: existingRows } = await pool.query('select id from standard_questions where id = $1', [id]);
  if (!existingRows[0]) return res.status(404).json({ status: 'error', error: 'Question not found.' });

  const { error, row } = validateQuestionBody(req.body);
  if (error) return res.status(400).json({ status: 'error', error });

  await pool.query(
    `update standard_questions set
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
    action: 'question.update',
    summary: `Updated question ${id} (topic "${row.topic}")`,
  });
  res.json({ status: 'ok' });
});

// Blocks deleting a topic's last remaining question — unlike video_questions
// (where this protects an orphaned video_trainings row), here it protects
// against silently wiping the whole module out of ModuleQuizView.vue's
// topic list with no warning, since a topic only exists as a byproduct of
// its questions.
questionsRouter.delete('/:id', requireAuth, requireScope('supervisor'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { rows } = await pool.query('select topic from standard_questions where id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ status: 'error', error: 'Question not found.' });
  const topic = rows[0].topic;

  const { rows: siblingRows } = await pool.query(
    'select count(*)::int as count from standard_questions where topic = $1 and id != $2',
    [topic, id]
  );
  if (siblingRows[0].count === 0) {
    return res.status(400).json({
      status: 'error',
      error: `Can't delete: this is the only question left for "${topic}" — the module would disappear from staff view.`,
    });
  }

  await pool.query('delete from standard_questions where id = $1', [id]);
  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'question.delete',
    summary: `Deleted question ${id} (topic "${topic}")`,
  });
  res.json({ status: 'ok' });
});
