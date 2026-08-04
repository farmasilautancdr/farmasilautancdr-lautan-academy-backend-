import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth, requireScope } from '../middleware/auth.js';

export const contentRouter = Router();

// Company-wide, not outlet-scoped — any authenticated role can read.
contentRouter.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query('select id, topic, category, title, body, link, created_at from content order by topic, title');
  res.json({
    content: rows.map(c => ({ ID: c.id, Topic: c.topic, Category: c.category, Title: c.title, Body: c.body, Link: c.link, Timestamp: c.created_at })),
  });
});

// Matches GAS's handleSaveContent gating — Supervisor only.
contentRouter.post('/', requireAuth, requireScope('supervisor'), async (req, res) => {
  const topic = (req.body.topic || '').toString().trim();
  const category = (req.body.category || '').toString().trim();
  const title = (req.body.title || '').toString().trim();
  const body = (req.body.body || '').toString().trim();
  const link = (req.body.link || '').toString().trim();
  if (!topic || !title || !body) {
    return res.status(400).json({ status: 'error', error: 'Topic, title, and body are required.' });
  }
  const { rows } = await pool.query(
    'insert into content (topic, category, title, body, link) values ($1,$2,$3,$4,$5) returning id',
    [topic, category, title, body, link]
  );
  res.json({ status: 'ok', id: rows[0].id });
});

contentRouter.delete('/:id', requireAuth, requireScope('supervisor'), async (req, res) => {
  await pool.query('delete from content where id = $1', [req.params.id]);
  res.json({ status: 'ok' });
});
