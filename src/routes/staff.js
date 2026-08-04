import { Router } from 'express';
import bcrypt from 'bcrypt';
import { pool } from '../config/db.js';
import { requireAuth, requireScope } from '../middleware/auth.js';

export const staffRouter = Router();

function checkOutletScope(req, res, division, outlet) {
  const expectedType = division === 'warehouse' ? 'warehouse_manager' : 'outlet_manager';
  if (req.session.scopeType !== expectedType || req.session.scopeKey !== outlet) {
    res.status(403).json({ status: 'unauthorized', error: 'Your session has expired — please log in again.' });
    return false;
  }
  return true;
}

// Manager-facing roster list — names + when added, never the PIN (hashed,
// can't be shown even if we wanted to). GAS's equivalent lets a manager
// look up a forgotten passcode in plaintext; that's not possible with
// hashed storage, so the UI offers "Reset PIN" instead — see POST /reset-pin.
staffRouter.get('/full', requireAuth, requireScope('outlet_manager', 'warehouse_manager'), async (req, res) => {
  const division = (req.query.division || '').toString().trim().toLowerCase();
  const outlet = (req.query.outlet || '').toString().trim().toUpperCase();
  if (!checkOutletScope(req, res, division, outlet)) return;

  const { rows } = await pool.query(
    'select name, added_by, created_at from staff_roster where division=$1 and outlet=$2 order by name',
    [division, outlet]
  );
  res.json({
    authorized: true,
    staff: rows.map(r => ({ Name: r.name, AddedBy: r.added_by, Timestamp: r.created_at })),
  });
});

staffRouter.post('/', requireAuth, requireScope('outlet_manager', 'warehouse_manager'), async (req, res) => {
  const division = (req.body.division || '').toString().trim().toLowerCase();
  const outlet = (req.body.outlet || '').toString().trim().toUpperCase();
  const name = (req.body.name || '').toString().trim().toUpperCase();
  const pin = (req.body.pin || '').toString().trim();
  const addedBy = (req.body.addedBy || '').toString().trim();
  if (!checkOutletScope(req, res, division, outlet)) return;

  if (!name || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ status: 'error', error: 'Name and a 4-digit passcode are both required.' });
  }

  const { rows } = await pool.query(
    'select 1 from staff_roster where division=$1 and outlet=$2 and name=$3',
    [division, outlet, name]
  );
  if (rows.length) {
    return res.status(409).json({ status: 'error', error: 'Someone with that exact name is already on this list — add an ID/Note to tell them apart, or reset their PIN if it\'s the same person.' });
  }

  const pinHash = await bcrypt.hash(pin, 10);
  await pool.query(
    'insert into staff_roster (division, outlet, name, pin_hash, added_by) values ($1,$2,$3,$4,$5)',
    [division, outlet, name, pinHash, addedBy]
  );
  res.json({ status: 'ok' });
});

// Explicit reset, not a lookup — the manager sets a new known PIN for an
// existing staff member rather than being shown their old one.
staffRouter.post('/reset-pin', requireAuth, requireScope('outlet_manager', 'warehouse_manager'), async (req, res) => {
  const division = (req.body.division || '').toString().trim().toLowerCase();
  const outlet = (req.body.outlet || '').toString().trim().toUpperCase();
  const name = (req.body.name || '').toString().trim().toUpperCase();
  const pin = (req.body.pin || '').toString().trim();
  if (!checkOutletScope(req, res, division, outlet)) return;

  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).json({ status: 'error', error: 'Enter a 4-digit passcode.' });
  }

  const pinHash = await bcrypt.hash(pin, 10);
  const { rowCount } = await pool.query(
    'update staff_roster set pin_hash=$4 where division=$1 and outlet=$2 and name=$3',
    [division, outlet, name, pinHash]
  );
  if (!rowCount) return res.status(404).json({ status: 'error', error: 'Staff member not found.' });
  res.json({ status: 'ok' });
});

staffRouter.delete('/', requireAuth, requireScope('outlet_manager', 'warehouse_manager'), async (req, res) => {
  const division = (req.body.division || '').toString().trim().toLowerCase();
  const outlet = (req.body.outlet || '').toString().trim().toUpperCase();
  const name = (req.body.name || '').toString().trim().toUpperCase();
  if (!checkOutletScope(req, res, division, outlet)) return;

  await pool.query('delete from staff_roster where division=$1 and outlet=$2 and name=$3', [division, outlet, name]);
  res.json({ status: 'ok' });
});
