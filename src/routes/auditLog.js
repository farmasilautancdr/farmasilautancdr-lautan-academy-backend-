import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth, requireMaster } from '../middleware/auth.js';

export const auditLogRouter = Router();

auditLogRouter.get('/search', requireAuth, requireMaster, async (req, res) => {
  const actorType = (req.query.actorType || '').toString().trim();
  const actorKey = (req.query.actorKey || '').toString().trim();
  const action = (req.query.action || '').toString().trim();
  const dateFrom = (req.query.dateFrom || '').toString().trim();
  const dateTo = (req.query.dateTo || '').toString().trim();

  const conditions = [];
  const params = [];
  if (actorType) { params.push(actorType); conditions.push(`actor_type = $${params.length}`); }
  if (actorKey) { params.push(`%${actorKey}%`); conditions.push(`actor_key ilike $${params.length}`); }
  if (action) { params.push(`%${action}%`); conditions.push(`action ilike $${params.length}`); }
  if (dateFrom) { params.push(dateFrom); conditions.push(`created_at >= $${params.length}`); }
  if (dateTo) { params.push(dateTo); conditions.push(`created_at <= $${params.length}`); }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';

  const { rows } = await pool.query(
    `select id, actor_type, actor_key, action, summary, affected_count, created_at from audit_log ${where} order by created_at desc limit 200`,
    params
  );
  res.json({
    entries: rows.map(r => ({
      id: r.id, actorType: r.actor_type, actorKey: r.actor_key, action: r.action,
      summary: r.summary, affectedCount: r.affected_count, createdAt: r.created_at,
    })),
  });
});
