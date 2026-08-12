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
    select vt.id, vt.title, vt.topic, vt.youtube_url
    from video_trainings vt
    where exists (
      select 1 from video_questions vq
      where vq.topic = vt.topic and vq.status = 'active'
    )
    order by vt.title
  `);
  res.json({
    videoTrainings: rows.map(v => ({ id: v.id, title: v.title, topic: v.topic, youtubeUrl: v.youtube_url })),
  });
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
