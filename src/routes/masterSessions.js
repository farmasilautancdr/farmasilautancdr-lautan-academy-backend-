import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth, requireMaster } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';
import { addRevokedSid } from '../services/sessionRevocationCache.js';

export const masterSessionsRouter = Router();

// Same pattern as masterPurge.js's withTransaction — file-local, not
// shared, matching this codebase's existing convention of small per-file
// helpers over a shared utility module.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

masterSessionsRouter.get('/search', requireAuth, requireMaster, async (req, res) => {
  const scopeType = (req.query.scopeType || '').toString().trim();
  const scopeKey = (req.query.scopeKey || '').toString().trim();
  const activeOnly = req.query.activeOnly !== 'false';

  const conditions = [];
  const params = [];
  if (scopeType) { params.push(scopeType); conditions.push(`scope_type = $${params.length}`); }
  if (scopeKey) { params.push(`%${scopeKey}%`); conditions.push(`scope_key ilike $${params.length}`); }
  if (activeOnly) { conditions.push(`revoked_at is null and expires_at > now()`); }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';

  const { rows } = await pool.query(
    `select id, scope_type, scope_key, issued_at, expires_at, revoked_at from sessions ${where} order by issued_at desc limit 200`,
    params
  );
  res.json({
    sessions: rows.map(r => ({
      id: r.id, scopeType: r.scope_type, scopeKey: r.scope_key,
      issuedAt: r.issued_at, expiresAt: r.expires_at, revokedAt: r.revoked_at,
    })),
  });
});

// Single {ids: [...]} bulk endpoint covers both single-session and
// filtered-multi-select force-logout — matches every other Master
// subsystem's bulk-delete shape (see Global Constraints).
masterSessionsRouter.post('/revoke', requireAuth, requireMaster, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ status: 'error', error: 'No sessions selected.' });

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `update sessions set revoked_at = now(), revoked_by = $1
         where id = ANY($2::bigint[]) and revoked_at is null
         returning id, scope_type, scope_key`,
        [req.session.scopeKey, ids]
      );
      if (!rows.length) throw new Error('No matching active sessions found.');

      for (const r of rows) addRevokedSid(r.id);

      const summary = `Force-logged-out ${rows.length} session(s): ${rows.map(r => `${r.scope_type}/${r.scope_key}`).join(', ')}`;
      await logAudit(client, { actorType: 'master', actorKey: req.session.scopeKey, action: 'session.force_logout', summary, affectedCount: rows.length });
      return { revokedCount: rows.length };
    });
    res.json({ status: 'ok', revokedCount: result.revokedCount });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message || 'Revoke failed.' });
  }
});
