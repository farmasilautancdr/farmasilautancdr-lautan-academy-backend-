import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { hitRateLimit } from '../middleware/rateLimit.js';

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
