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
  if (await isLockedOut(failKey)) {
    return res.status(429).json({ authorized: false, error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  const { rows } = await pool.query(
    'select pin_hash from staff_roster where division = $1 and outlet = $2 and name = $3',
    [division, outlet, name]
  );
  const match = rows[0];
  const ok = match && pin && await bcrypt.compare(pin, match.pin_hash);
  if (!ok) {
    await recordFailure(failKey);
    return res.json({ authorized: false });
  }

  await clearFailures(failKey);
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
  if (await isLockedOut(failKey)) {
    return res.status(429).json({ authorized: false, error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  const { rows } = await pool.query('select pin_hash from manager_pins where role = $1', [role]);
  const match = rows[0];
  const ok = match && pin && await bcrypt.compare(pin, match.pin_hash);
  if (!ok) {
    await recordFailure(failKey);
    return res.json({ authorized: false, error: 'Incorrect password.' });
  }
  await clearFailures(failKey);

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

// Boolean-only PIN check, no token issued — backs vanilla index.html's two
// standalone PIN gates that never needed a scoped session: the shared
// Manager-category gate (role 'resources', unlocks the Outlet/Warehouse/
// Area Manager/Supervisor tile picker — a real role login follows
// separately) and the Knowledge Base manager unlock (role 'supervisor',
// reachable from Resources without a full Supervisor login). Same
// manager_pins table and lockout pattern as /manager-login.
authRouter.post('/verify-pin', async (req, res) => {
  const role = (req.body.role || '').toString();
  const pin = (req.body.pin || '').toString();
  const validRoles = ['outlet_manager', 'warehouse_manager', 'area_manager', 'supervisor', 'resources'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ authorized: false, error: 'Unknown role.' });
  }

  // Same key as /manager-login's failKey for this role, deliberately — a
  // separate counter would let an attacker double their real attempt
  // budget (or bypass lockout entirely) by alternating between the two
  // endpoints for the same PIN. One shared lockout per role, not two.
  const failKey = `mgr_${role}`;
  if (await isLockedOut(failKey)) {
    return res.status(429).json({ authorized: false, error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  const { rows } = await pool.query('select pin_hash from manager_pins where role = $1', [role]);
  const match = rows[0];
  const ok = match && pin && await bcrypt.compare(pin, match.pin_hash);
  if (!ok) {
    await recordFailure(failKey);
    return res.json({ authorized: false });
  }
  await clearFailures(failKey);
  res.json({ authorized: true });
});
