import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth, requireMaster } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';

export const masterOutletsRouter = Router();

// Plain `order by id` sorts text lexicographically — "R10" lands right
// after "R1" and before "R2", not after "R9" like a human expects. Local
// duplication of routes/outlets.js's same fix — file-local, not shared,
// matches this codebase's existing per-file convention.
const AREA_NATURAL_SORT = `
  case when regexp_replace(id, '[^0-9]', '', 'g') = '' then 2147483647
       else regexp_replace(id, '[^0-9]', '', 'g')::int end,
  id
`;

// Same shape as the public GET /outlets + GET /areas, but includes
// inactive rows — Master's panel needs to see and reactivate deactivated
// entries, not just the active ones the public dropdowns show.
masterOutletsRouter.get('/', requireAuth, requireMaster, async (req, res) => {
  const [areasResult, outletsResult] = await Promise.all([
    pool.query(`select id, label, active from areas order by ${AREA_NATURAL_SORT}`),
    pool.query('select code, division, area_id, active from store_outlets order by division, code'),
  ]);
  res.json({
    areas: areasResult.rows.map(a => ({ id: a.id, label: a.label, active: a.active })),
    outlets: outletsResult.rows.map(o => ({ code: o.code, division: o.division, areaId: o.area_id, active: o.active })),
  });
});

masterOutletsRouter.post('/areas', requireAuth, requireMaster, async (req, res) => {
  const id = (req.body.id || '').toString().trim();
  const label = (req.body.label || '').toString().trim();
  if (!id || !label) {
    return res.status(400).json({ status: 'error', error: 'Area id and label are required.' });
  }

  try {
    await pool.query('insert into areas (id, label) values ($1, $2)', [id, label]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ status: 'error', error: `Area '${id}' already exists.` });
    throw err;
  }
  await logAudit(pool, { actorType: 'master', actorKey: req.session.scopeKey, action: 'area.create', summary: `Created area ${id} - ${label}` });
  res.json({ status: 'ok' });
});

// Also the reactivate endpoint — {active: true} on a deactivated area is
// the only way back, no separate "restore" route (see design spec).
masterOutletsRouter.patch('/areas/:id', requireAuth, requireMaster, async (req, res) => {
  const id = req.params.id;
  const { rows } = await pool.query('select id, label, active from areas where id = $1', [id]);
  const existing = rows[0];
  if (!existing) return res.status(404).json({ status: 'error', error: 'Area not found.' });

  const label = req.body.label !== undefined ? req.body.label.toString().trim() : existing.label;
  const active = req.body.active !== undefined ? !!req.body.active : existing.active;

  if (active === false && existing.active === true) {
    const { rows: activeOutlets } = await pool.query('select code from store_outlets where area_id = $1 and active', [id]);
    if (activeOutlets.length) {
      return res.status(400).json({ status: 'error', error: `Deactivate or reassign this area's ${activeOutlets.length} active outlet(s) first.` });
    }
  }

  await pool.query('update areas set label = $1, active = $2 where id = $3', [label, active, id]);
  await logAudit(pool, { actorType: 'master', actorKey: req.session.scopeKey, action: 'area.update', summary: `Updated area ${id}: label='${label}', active=${active}` });
  res.json({ status: 'ok' });
});

masterOutletsRouter.post('/', requireAuth, requireMaster, async (req, res) => {
  const code = (req.body.code || '').toString().trim();
  const division = (req.body.division || '').toString().trim();
  const areaId = req.body.areaId ? req.body.areaId.toString().trim() : null;

  if (!code || !['retail', 'warehouse'].includes(division)) {
    return res.status(400).json({ status: 'error', error: 'Outlet code and a valid division (retail/warehouse) are required.' });
  }
  if (division === 'retail' && !areaId) {
    return res.status(400).json({ status: 'error', error: 'Retail outlets must belong to an area.' });
  }
  if (division === 'warehouse' && areaId) {
    return res.status(400).json({ status: 'error', error: 'Warehouse locations cannot belong to an area.' });
  }
  if (areaId) {
    const { rows } = await pool.query('select id from areas where id = $1', [areaId]);
    if (!rows.length) return res.status(400).json({ status: 'error', error: 'Unknown area.' });
  }

  try {
    await pool.query('insert into store_outlets (code, division, area_id) values ($1, $2, $3)', [code, division, areaId]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ status: 'error', error: `Outlet '${code}' already exists.` });
    throw err;
  }
  await logAudit(pool, { actorType: 'master', actorKey: req.session.scopeKey, action: 'outlet.create', summary: `Created outlet ${code} (${division}${areaId ? ', area ' + areaId : ''})` });
  res.json({ status: 'ok' });
});

// {active: true|false} — covers both deactivate and reactivate, no rename
// (see Global Constraints: outlets.code is referenced by free text
// elsewhere, renaming it would silently break those joins).
masterOutletsRouter.patch('/:code', requireAuth, requireMaster, async (req, res) => {
  const code = req.params.code;
  const { rows } = await pool.query('select code, active from store_outlets where code = $1', [code]);
  if (!rows[0]) return res.status(404).json({ status: 'error', error: 'Outlet not found.' });
  const active = req.body.active !== undefined ? !!req.body.active : rows[0].active;

  await pool.query('update store_outlets set active = $1 where code = $2', [active, code]);
  await logAudit(pool, {
    actorType: 'master',
    actorKey: req.session.scopeKey,
    action: active ? 'outlet.reactivate' : 'outlet.deactivate',
    summary: `${active ? 'Reactivated' : 'Deactivated'} outlet ${code}`,
  });
  res.json({ status: 'ok' });
});
