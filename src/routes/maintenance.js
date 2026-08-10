import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth, requireMaster } from '../middleware/auth.js';

export const maintenanceRouter = Router();

// Public — blocked staff/managers need to read this too (the overlay's
// retry button and App.vue's on-load check both call it unauthenticated).
// See docs/superpowers/specs/2026-08-11-master-subsystem-d-design.md.
maintenanceRouter.get('/maintenance-status', async (req, res) => {
  const { rows } = await pool.query(`select value from system_settings where key = 'maintenance'`);
  const value = rows[0]?.value || {};
  res.json({ enabled: value.enabled === true, message: value.message || '' });
});

maintenanceRouter.post('/master/maintenance', requireAuth, requireMaster, async (req, res) => {
  const enabled = req.body.enabled;
  const message = (req.body.message || '').toString();
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ status: 'error', error: 'enabled must be true or false.' });
  }
  await pool.query(
    `insert into system_settings (key, value, updated_by, updated_at)
     values ('maintenance', $1, $2, now())
     on conflict (key) do update set value = $1, updated_by = $2, updated_at = now()`,
    [JSON.stringify({ enabled, message }), req.session.scopeKey]
  );
  res.json({ status: 'ok' });
});
