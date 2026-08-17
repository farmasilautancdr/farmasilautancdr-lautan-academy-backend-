import { Router } from 'express';
import multer from 'multer';
import { pool } from '../config/db.js';
import { requireAuth, requireScope } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { logAuditSafe } from '../services/auditLog.js';

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
  if (!topic || !title || !body) {
    return res.status(400).json({ status: 'error', error: 'Topic, title, and body are required.' });
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
    summary: `Added content "${title}" (${topic})${quizRequired ? ` [quiz required, ${hours}h]` : ''}`,
  });
  res.json({ status: 'ok', id: rows[0].id });
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
