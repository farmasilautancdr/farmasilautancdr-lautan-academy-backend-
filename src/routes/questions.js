import { Router } from 'express';
import { pool } from '../config/db.js';

export const questionsRouter = Router();

// Public, no auth — matches GAS's doGet(), which served the whole question
// bank before login too. Returns every row (including any future
// status='inactive' ones); the client filters, same as vanilla index.html.
questionsRouter.get('/', async (req, res) => {
  const { rows } = await pool.query('select * from standard_questions order by id');
  res.json({
    questions: rows.map((q) => ({
      topic: q.topic,
      question_en: q.question_en,
      question_ms: q.question_ms,
      opt1_en: q.opt1_en, opt2_en: q.opt2_en, opt3_en: q.opt3_en, opt4_en: q.opt4_en,
      opt1_ms: q.opt1_ms, opt2_ms: q.opt2_ms, opt3_ms: q.opt3_ms, opt4_ms: q.opt4_ms,
      correct: q.correct,
      status: q.status,
    })),
  });
});
