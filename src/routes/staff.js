import { Router } from 'express';
import bcrypt from 'bcrypt';
import { pool } from '../config/db.js';
import { requireAuth, requireScope } from '../middleware/auth.js';
import { logAuditSafe } from '../services/auditLog.js';

export const staffRouter = Router();

// Same pattern as masterPurge.js's withTransaction — file-local, not shared,
// per existing convention in this backend.
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
    'select name, id_note, added_by, created_at from staff_roster where division=$1 and outlet=$2 order by name',
    [division, outlet]
  );
  res.json({
    authorized: true,
    staff: rows.map(r => ({ Name: r.name, IDNote: r.id_note, AddedBy: r.added_by, Timestamp: r.created_at })),
  });
});

staffRouter.post('/', requireAuth, requireScope('outlet_manager', 'warehouse_manager'), async (req, res) => {
  const division = (req.body.division || '').toString().trim().toLowerCase();
  const outlet = (req.body.outlet || '').toString().trim().toUpperCase();
  const name = (req.body.name || '').toString().trim().toUpperCase();
  const pin = (req.body.pin || '').toString().trim();
  const idNote = (req.body.idNote || '').toString().trim();
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
    'insert into staff_roster (division, outlet, name, pin_hash, id_note, added_by) values ($1,$2,$3,$4,$5,$6)',
    [division, outlet, name, pinHash, idNote, addedBy]
  );
  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'staff.add',
    summary: `Added staff ${outlet}/${name}`,
  });
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
  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'staff.reset_pin',
    summary: `Reset PIN for ${outlet}/${name}`,
  });
  res.json({ status: 'ok' });
});

// Corrects a wrongly-typed name. staff_roster has no FK to results/
// wrong_answers/ai_results/ai_wrong_answers/reports — every query in this
// codebase matches those by outlet+name text (same reasoning as
// masterPurge.js's cascade delete) — so the rename cascades to them too,
// inside one transaction, to keep a staff member's history under one name
// instead of splitting it across old/new.
staffRouter.patch('/rename', requireAuth, requireScope('outlet_manager', 'warehouse_manager'), async (req, res) => {
  const division = (req.body.division || '').toString().trim().toLowerCase();
  const outlet = (req.body.outlet || '').toString().trim().toUpperCase();
  const oldName = (req.body.oldName || '').toString().trim().toUpperCase();
  const newName = (req.body.newName || '').toString().trim().toUpperCase();
  if (!checkOutletScope(req, res, division, outlet)) return;

  if (!newName) {
    return res.status(400).json({ status: 'error', error: 'Enter a name.' });
  }
  if (newName === oldName) {
    return res.status(400).json({ status: 'error', error: 'That\'s already their name.' });
  }

  const { rows } = await pool.query(
    'select 1 from staff_roster where division=$1 and outlet=$2 and name=$3',
    [division, outlet, newName]
  );
  if (rows.length) {
    return res.status(409).json({ status: 'error', error: 'Someone with that exact name is already on this list — add an ID/Note to tell them apart instead.' });
  }

  try {
    await withTransaction(async (client) => {
      const upd = await client.query(
        'update staff_roster set name=$4 where division=$1 and outlet=$2 and name=$3',
        [division, outlet, oldName, newName]
      );
      if (!upd.rowCount) throw new Error('not_found');
      await client.query('update results set name=$2 where outlet=$1 and name=$3', [outlet, newName, oldName]);
      await client.query('update wrong_answers set staff_name=$2 where outlet=$1 and staff_name=$3', [outlet, newName, oldName]);
      await client.query('update ai_results set name=$2 where outlet=$1 and name=$3', [outlet, newName, oldName]);
      await client.query('update ai_wrong_answers set staff_name=$2 where outlet=$1 and staff_name=$3', [outlet, newName, oldName]);
      await client.query('update reports set staff_name=$2 where outlet=$1 and staff_name=$3', [outlet, newName, oldName]);
    });
  } catch (err) {
    if (err.message === 'not_found') {
      return res.status(404).json({ status: 'error', error: 'Staff member not found.' });
    }
    return res.status(500).json({ status: 'error', error: 'Could not rename staff — nothing was changed.' });
  }

  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'staff.rename',
    summary: `Renamed staff ${outlet}/${oldName} -> ${newName}`,
  });
  res.json({ status: 'ok' });
});

staffRouter.delete('/', requireAuth, requireScope('outlet_manager', 'warehouse_manager'), async (req, res) => {
  const division = (req.body.division || '').toString().trim().toLowerCase();
  const outlet = (req.body.outlet || '').toString().trim().toUpperCase();
  const name = (req.body.name || '').toString().trim().toUpperCase();
  if (!checkOutletScope(req, res, division, outlet)) return;

  await pool.query('delete from staff_roster where division=$1 and outlet=$2 and name=$3', [division, outlet, name]);
  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'staff.delete',
    summary: `Removed staff ${outlet}/${name}`,
  });
  res.json({ status: 'ok' });
});

// Company-wide (not outlet-scoped) — Supervisor tags staff Pharmacist from
// here. No other role can see or set this. See
// docs/superpowers/specs/2026-08-13-pharmacist-tag-design.md.
staffRouter.get('/all', requireAuth, requireScope('supervisor'), async (req, res) => {
  const { rows } = await pool.query(
    'select id, division, outlet, name, id_note, is_pharmacist from staff_roster order by outlet, name'
  );
  res.json({
    staff: rows.map(r => ({
      id: r.id,
      division: r.division,
      outlet: r.outlet,
      name: r.name,
      idNote: r.id_note,
      isPharmacist: r.is_pharmacist,
    })),
  });
});

staffRouter.patch('/:id/pharmacist', requireAuth, requireScope('supervisor'), async (req, res) => {
  const id = parseInt(req.params.id);
  const isPharmacist = !!req.body.isPharmacist;
  const { rows } = await pool.query('select outlet, name from staff_roster where id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ status: 'error', error: 'Staff member not found.' });

  await pool.query('update staff_roster set is_pharmacist = $1 where id = $2', [isPharmacist, id]);
  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'staff.pharmacist_tag',
    summary: `${isPharmacist ? 'Tagged' : 'Untagged'} ${rows[0].outlet}/${rows[0].name} as Pharmacist`,
  });
  res.json({ status: 'ok' });
});
