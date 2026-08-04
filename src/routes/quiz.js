import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth, requireScope } from '../middleware/auth.js';
import { hitRateLimit } from '../middleware/rateLimit.js';
import { generateQuiz } from '../services/gemini.js';

export const quizRouter = Router();

const ONE_HOUR_MS = 60 * 60 * 1000;

function generatePasscode() {
  return String(Math.floor(Math.random() * 1000)).padStart(3, '0');
}

// Manager-triggered: generate a quiz, store it, hand back a passcode.
// One active quiz per outlet — creating a new one overwrites the previous.
quizRouter.post('/create', requireAuth, requireScope('outlet_manager', 'warehouse_manager'), async (req, res) => {
  const outlet = (req.body.outlet || '').toString().trim().toUpperCase();
  if (req.session.scopeKey !== outlet) {
    return res.status(403).json({ error: 'Your session has expired — please log in again.' });
  }

  const sourceType = (req.body.sourceType || 'topic').toString();
  const sourceValue = (req.body.sourceValue || '').toString().trim();
  const topicLabel = (req.body.topicLabel || sourceValue || 'General').toString().trim();
  const count = Math.min(Math.max(parseInt(req.body.count) || 10, 1), 25);
  const extraNotes = (req.body.extraNotes || '').toString().trim();

  let context = '';
  if (sourceType !== 'resource') {
    const { rows } = await pool.query(
      'select title, body from content where topic = $1',
      [sourceValue]
    );
    context = rows.map(r => `# ${r.title}\n${r.body}`).join('\n\n');
  }
  context = (context || '').slice(0, 8000);
  if (!context) {
    context = `No specific reference material has been uploaded for "${topicLabel}" yet. Use general best-practice retail pharmacy knowledge for this topic instead.`;
  }

  let questions;
  try {
    questions = await generateQuiz(topicLabel, context, count, extraNotes);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  // Codes unique across active outlets, same guarantee as GAS version.
  const { rows: activeRows } = await pool.query(
    'select passcode from ai_quizzes where created_at > now() - interval \'1 hour\''
  );
  const activeCodes = new Set(activeRows.map(r => r.passcode));
  let passcode = generatePasscode();
  let attempts = 0;
  while (activeCodes.has(passcode) && attempts < 30) { passcode = generatePasscode(); attempts++; }

  await pool.query(
    `insert into ai_quizzes (outlet, passcode, topic, count, questions_json, created_by, created_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (outlet) do update set
       passcode = excluded.passcode, topic = excluded.topic, count = excluded.count,
       questions_json = excluded.questions_json, created_by = excluded.created_by, created_at = now()`,
    [outlet, passcode, topicLabel, questions.length, JSON.stringify(questions), req.body.manager || '']
  );

  res.json({ passcode, count: questions.length, topic: topicLabel, expiresInMinutes: 60, createdAt: new Date().toISOString() });
});

// Staff-triggered: resolve outlet + passcode to the stored question set.
quizRouter.post('/redeem', async (req, res) => {
  const outlet = (req.body.outlet || '').toString().trim().toUpperCase();
  const passcode = (req.body.passcode || '').toString().trim();

  const { rows } = await pool.query(
    'select topic, questions_json, created_at from ai_quizzes where outlet = $1 and passcode = $2',
    [outlet, passcode]
  );
  const match = rows[0];
  if (!match) return res.status(404).json({ error: 'Invalid code for this outlet.' });

  const ageMs = Date.now() - new Date(match.created_at).getTime();
  if (ageMs > ONE_HOUR_MS) {
    return res.status(410).json({ error: 'This code expired (codes last 1 hour). Ask your outlet manager for a fresh one.' });
  }

  // `correct` withheld — server grades attempts itself (see POST
  // /data/ai-results and /quiz/:outlet/check), matches Standard Quiz.
  const questions = match.questions_json.map(({ correct, ...q }) => q);
  res.json({ topic: match.topic, questions, passcode });
});

// Live per-question reveal for AI Practice, same role as
// POST /questions/:id/check for Module Quiz — not authoritative, the final
// save independently re-grades from the same stored questions_json.
// index is the question's position in that stored array (AI-generated
// quizzes have no other stable per-question id). Authenticated + rate
// limited for the same reason as the Standard Quiz check endpoint — staff
// are always already logged in by the time they reach quiz-taking, so this
// costs nothing for real use, and it closes off unauthenticated enumeration
// of a quiz's full answer key one call at a time.
quizRouter.post('/:outlet/check', requireAuth, async (req, res) => {
  if (await hitRateLimit(`check_ai_${req.session.scopeKey}`, 80, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many checks — slow down and try again shortly.' });
  }
  const outlet = req.params.outlet.toUpperCase();
  const passcode = (req.body.passcode || '').toString().trim();
  const index = parseInt(req.body.index);
  const chosen = parseInt(req.body.chosen);

  const { rows } = await pool.query(
    'select questions_json from ai_quizzes where outlet = $1 and passcode = $2',
    [outlet, passcode]
  );
  const q = rows[0]?.questions_json?.[index];
  if (!q) return res.status(404).json({ error: 'Question not found — this code may have expired or been replaced.' });
  res.json({ correct: chosen === q.correct, correctIndex: q.correct });
});

// Manager dashboard: current code + timer for their outlet.
quizRouter.get('/:outlet/active', requireAuth, requireScope('outlet_manager', 'warehouse_manager'), async (req, res) => {
  const outlet = req.params.outlet.toUpperCase();
  if (req.session.scopeKey !== outlet) {
    return res.status(403).json({ error: 'Your session has expired — please log in again.' });
  }

  const { rows } = await pool.query(
    'select passcode, topic, count, created_at from ai_quizzes where outlet = $1',
    [outlet]
  );
  const match = rows[0];
  if (!match) return res.json({ active: false });

  const ageMs = Date.now() - new Date(match.created_at).getTime();
  if (ageMs > ONE_HOUR_MS) return res.json({ active: false });

  res.json({ active: true, passcode: match.passcode, topic: match.topic, count: match.count, createdAt: match.created_at });
});

// Manager taps "End This Code Now" — deletes the row so it stops resolving.
quizRouter.post('/:outlet/end', requireAuth, requireScope('outlet_manager', 'warehouse_manager'), async (req, res) => {
  const outlet = req.params.outlet.toUpperCase();
  if (req.session.scopeKey !== outlet) {
    return res.status(403).json({ error: 'Your session has expired — please log in again.' });
  }
  await pool.query('delete from ai_quizzes where outlet = $1', [outlet]);
  res.json({ ended: true });
});
