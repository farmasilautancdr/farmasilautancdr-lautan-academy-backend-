import { Router } from 'express';
import bcrypt from 'bcrypt';
import { pool } from '../config/db.js';
import { issueToken } from '../middleware/auth.js';
import { isLockedOut, recordFailure, clearFailures } from '../middleware/rateLimit.js';
import { outletsForArea } from '../config/areas.js';

export const authRouter = Router();

// Public — names only, no pin_hash, no auth required. Mirrors GAS's
// getPublicStaffRoster: needed so a login picker can list names before
// anyone's authenticated. Never returns pin_hash in either direction.
authRouter.get('/staff-roster', async (req, res) => {
  const division = (req.query.division || '').toString().trim().toLowerCase();
  const outlet = (req.query.outlet || '').toString().trim().toUpperCase();
  if (!division || !outlet) return res.json({ staff: [] });

  const { rows } = await pool.query(
    'select name from staff_roster where division = $1 and outlet = $2 order by name',
    [division, outlet]
  );
  res.json({ staff: rows.map(r => r.name) });
});

// Staff: division + outlet + name + PIN -> JWT scoped to staff_retail/staff_warehouse
authRouter.post('/staff-login', async (req, res) => {
  const division = (req.body.division || '').toString().trim().toLowerCase();
  const outlet = (req.body.outlet || '').toString().trim().toUpperCase();
  const name = (req.body.name || '').toString().trim().toUpperCase();
  const pin = (req.body.pin || '').toString().trim();

  const failKey = `staff_${division}_${outlet}_${name}`;
  if (isLockedOut(failKey)) {
    return res.status(429).json({ authorized: false, error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  const { rows } = await pool.query(
    'select pin_hash from staff_roster where division = $1 and outlet = $2 and name = $3',
    [division, outlet, name]
  );
  const match = rows[0];
  const ok = match && pin && await bcrypt.compare(pin, match.pin_hash);
  if (!ok) {
    recordFailure(failKey);
    return res.json({ authorized: false });
  }

  clearFailures(failKey);
  const scopeType = division === 'warehouse' ? 'staff_warehouse' : 'staff_retail';
  const scopeKey = `${outlet}|${name}`;
  const token = issueToken(scopeType, scopeKey);
  res.json({ authorized: true, token });
});

// Manager: role + PIN (+ outlet, unless supervisor) -> JWT
authRouter.post('/manager-login', async (req, res) => {
  const role = (req.body.role || '').toString();
  const pin = (req.body.pin || '').toString();
  const validRoles = ['outlet_manager', 'warehouse_manager', 'area_manager', 'supervisor'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ authorized: false, error: 'Unknown role.' });
  }

  const failKey = `mgr_${role}`;
  if (isLockedOut(failKey)) {
    return res.status(429).json({ authorized: false, error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  const { rows } = await pool.query('select pin_hash from manager_pins where role = $1', [role]);
  const match = rows[0];
  const ok = match && pin && await bcrypt.compare(pin, match.pin_hash);
  if (!ok) {
    recordFailure(failKey);
    return res.json({ authorized: false, error: 'Incorrect password.' });
  }
  clearFailures(failKey);

  // area_manager reuses the "outlet" field to carry the area id instead —
  // scope is the whole region's outlets, not one. Not uppercased: area ids
  // are mixed-case ("R1 - AMIRUL") and must match areas.js exactly.
  let scopeKey;
  if (role === 'supervisor') {
    scopeKey = 'ALL';
  } else if (role === 'area_manager') {
    const areaId = (req.body.outlet || '').toString().trim();
    if (!areaId || !outletsForArea(areaId)) {
      return res.status(400).json({ authorized: false, error: 'Select a valid area.' });
    }
    scopeKey = areaId;
  } else {
    scopeKey = (req.body.outlet || '').toString().trim().toUpperCase();
    if (!scopeKey) return res.status(400).json({ authorized: false, error: 'Select an outlet/location first.' });
  }

  const token = issueToken(role, scopeKey);
  res.json({ authorized: true, token });
});
