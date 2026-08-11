import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../config/db.js';
import { issueToken, requireAuth, requireMaster } from '../middleware/auth.js';
import { logAudit, logAuditSafe } from '../services/auditLog.js';
import { addRevokedSid } from '../services/sessionRevocationCache.js';

export const masterImpersonateRouter = Router();

// Master Subsystem H — outlet/role impersonation switcher. A target is
// {scopeType, scopeKey}, the exact shape issueToken() already accepts — no
// new identity concept. Supervisor and Master are deliberately excluded
// (Supervisor has no narrower account to view as; Master-as-Master is
// meaningless). See
// docs/superpowers/specs/2026-08-11-master-subsystem-h-design.md.
const VALID_SCOPE_TYPES = ['staff_retail', 'staff_warehouse', 'outlet_manager', 'warehouse_manager', 'area_manager'];
const IMPERSONATION_TTL_MINUTES = 30;

async function isValidOutlet(division, code) {
  const { rows } = await pool.query(
    'select 1 from store_outlets where code = $1 and division = $2 and active',
    [code, division]
  );
  return rows.length > 0;
}
async function areaExists(areaId) {
  const { rows } = await pool.query('select 1 from areas where id = $1 and active', [areaId]);
  return rows.length > 0;
}

masterImpersonateRouter.post('/start', requireAuth, requireMaster, async (req, res) => {
  const scopeType = (req.body.scopeType || '').toString();
  const scopeKey = (req.body.scopeKey || '').toString().trim();
  if (!VALID_SCOPE_TYPES.includes(scopeType) || !scopeKey) {
    return res.status(400).json({ authorized: false, error: 'Invalid target.' });
  }

  if (scopeType === 'staff_retail' || scopeType === 'staff_warehouse') {
    const [outlet, name] = scopeKey.split('|');
    if (!outlet || !name) {
      return res.status(400).json({ authorized: false, error: 'Invalid staff target.' });
    }
    const division = scopeType === 'staff_warehouse' ? 'warehouse' : 'retail';
    const { rows } = await pool.query(
      'select 1 from staff_roster where division = $1 and outlet = $2 and name = $3',
      [division, outlet, name]
    );
    if (!rows.length) return res.status(400).json({ authorized: false, error: 'Staff member not found.' });
  } else if (scopeType === 'outlet_manager') {
    if (!(await isValidOutlet('retail', scopeKey))) return res.status(400).json({ authorized: false, error: 'Unknown outlet.' });
  } else if (scopeType === 'warehouse_manager') {
    if (!(await isValidOutlet('warehouse', scopeKey))) return res.status(400).json({ authorized: false, error: 'Unknown location.' });
  } else if (scopeType === 'area_manager') {
    if (!(await areaExists(scopeKey))) return res.status(400).json({ authorized: false, error: 'Unknown area.' });
  }

  const token = await issueToken(scopeType, scopeKey, {
    expiresInMinutes: IMPERSONATION_TTL_MINUTES,
    impersonatedBy: req.session.scopeKey,
  });
  const sessionId = jwt.decode(token).sid;

  await logAuditSafe({
    actorType: 'master',
    actorKey: req.session.scopeKey,
    action: 'impersonation.start',
    summary: `Started viewing as ${scopeType}/${scopeKey}`,
  });

  res.json({ authorized: true, token, sessionId, scopeType, scopeKey });
});

masterImpersonateRouter.post('/end', requireAuth, requireMaster, async (req, res) => {
  const sessionId = (req.body.sessionId || '').toString();
  if (!sessionId) return res.status(400).json({ status: 'error', error: 'No session specified.' });

  const { rows } = await pool.query(
    `update sessions set revoked_at = now(), revoked_by = $1
     where id = $2 and revoked_at is null
     returning id, scope_type, scope_key`,
    [req.session.scopeKey, sessionId]
  );
  if (!rows.length) return res.status(404).json({ status: 'error', error: 'Session not found or already ended.' });

  addRevokedSid(rows[0].id);
  await logAudit(pool, {
    actorType: 'master',
    actorKey: req.session.scopeKey,
    action: 'impersonation.end',
    summary: `Ended impersonation of ${rows[0].scope_type}/${rows[0].scope_key}`,
  });

  res.json({ status: 'ok' });
});
