import { Router } from 'express';
import bcrypt from 'bcrypt';
import { pool } from '../config/db.js';
import { issueToken, issueMasterToken, requireAuth, requireMaster, requireScope } from '../middleware/auth.js';
import { isLockedOut, recordFailure, clearFailures } from '../middleware/rateLimit.js';
import { outletsForArea } from '../config/areas.js';
import { logAuditSafe } from '../services/auditLog.js';

export const authRouter = Router();

// Public — names only, no pin_hash, no auth required. Mirrors GAS's
// getPublicStaffRoster: needed so a login picker can list names before
// anyone's authenticated. Never returns pin_hash in either direction.
authRouter.get('/staff-roster', async (req, res) => {
  const division = (req.query.division || '').toString().trim().toLowerCase();
  const outlet = (req.query.outlet || '').toString().trim().toUpperCase();
  if (!division || !outlet) return res.json({ staff: [] });

  const { rows } = await pool.query(
    'select name, id_note from staff_roster where division = $1 and outlet = $2 order by name',
    [division, outlet]
  );
  res.json({ staff: rows.map(r => ({ name: r.name, idNote: r.id_note || null })) });
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

// Manager: role + PIN/password (+ outlet, unless supervisor) -> JWT.
// Outlet/Warehouse/Area Manager may have a personal per-outlet/per-region
// password registered (manager_credentials, see /manager-register below) —
// if so, that takes priority. Falls back to the shared master PIN in
// manager_pins if this scope hasn't registered one yet (or always, for
// supervisor, which has no registration path). See
// docs/superpowers/specs/2026-08-06-manager-auth-design.md.
authRouter.post('/manager-login', async (req, res) => {
  const role = (req.body.role || '').toString();
  const pin = (req.body.pin || '').toString();
  const validRoles = ['outlet_manager', 'warehouse_manager', 'area_manager', 'supervisor'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ authorized: false, error: 'Unknown role.' });
  }

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

  let credRow = null;
  if (role !== 'supervisor') {
    const { rows } = await pool.query(
      'select password_hash from manager_credentials where role = $1 and scope_key = $2',
      [role, scopeKey]
    );
    credRow = rows[0] || null;
  }

  // Separate lockout counters: a registered outlet's personal password is
  // its own attack surface from the shared master PIN's — sharing one
  // counter between them would let a wrong personal-password guess and a
  // wrong master-PIN guess against a DIFFERENT outlet blend together.
  const failKey = credRow ? `mgr_${role}_${scopeKey}` : `mgr_master_${role}`;
  if (await isLockedOut(failKey)) {
    return res.status(429).json({ authorized: false, error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  let ok;
  if (credRow) {
    ok = pin && await bcrypt.compare(pin, credRow.password_hash);
  } else {
    const { rows } = await pool.query('select pin_hash from manager_pins where role = $1', [role]);
    const match = rows[0];
    ok = match && pin && await bcrypt.compare(pin, match.pin_hash);
  }
  if (!ok) {
    await recordFailure(failKey);
    return res.json({ authorized: false, error: 'Incorrect password.' });
  }
  await clearFailures(failKey);

  const token = issueToken(role, scopeKey);
  res.json({ authorized: true, token });
});

// Register (or re-register) a personal password for one outlet/region.
// Requires today's master PIN as proof of legitimacy — the same action
// covers first-time signup, a forgotten password, and outlet handover to a
// new manager, since it always overwrites whatever credential row already
// existed rather than requiring it to be deleted first. supervisor has no
// registration path (single shared account, out of scope). See
// docs/superpowers/specs/2026-08-06-manager-auth-design.md.
authRouter.post('/manager-register', async (req, res) => {
  const role = (req.body.role || '').toString();
  const masterPin = (req.body.masterPin || '').toString();
  const newPassword = (req.body.newPassword || '').toString();
  const validRoles = ['outlet_manager', 'warehouse_manager', 'area_manager'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ authorized: false, error: 'Unknown role.' });
  }

  let scopeKey;
  if (role === 'area_manager') {
    const areaId = (req.body.outlet || '').toString().trim();
    if (!areaId || !outletsForArea(areaId)) {
      return res.status(400).json({ authorized: false, error: 'Select a valid area.' });
    }
    scopeKey = areaId;
  } else {
    scopeKey = (req.body.outlet || '').toString().trim().toUpperCase();
    if (!scopeKey) return res.status(400).json({ authorized: false, error: 'Select an outlet/location first.' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ authorized: false, error: 'Password must be at least 6 characters.' });
  }

  // Shares its lockout counter with manager-login's master-PIN fallback
  // path (mgr_master_${role}) — a separate counter here would let an
  // attacker double their master-PIN guess budget by alternating between
  // logging in and registering. Same reasoning as the verify-pin +
  // manager-login lockout unification fixed earlier.
  const failKey = `mgr_master_${role}`;
  if (await isLockedOut(failKey)) {
    return res.status(429).json({ authorized: false, error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  const { rows } = await pool.query('select pin_hash from manager_pins where role = $1', [role]);
  const match = rows[0];
  const ok = match && masterPin && await bcrypt.compare(masterPin, match.pin_hash);
  if (!ok) {
    await recordFailure(failKey);
    return res.json({ authorized: false, error: 'Incorrect master PIN.' });
  }
  await clearFailures(failKey);

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await pool.query(
    `insert into manager_credentials (role, scope_key, password_hash) values ($1, $2, $3)
     on conflict (role, scope_key) do update set password_hash = excluded.password_hash, updated_at = now()`,
    [role, scopeKey, passwordHash]
  );

  logAuditSafe({
    actorType: role,
    actorKey: scopeKey,
    action: 'manager.register',
    summary: `Registered manager credential for ${role}/${scopeKey}`,
  });

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

  // 'resources' has no manager-login counterpart, so it keeps its own
  // counter. The other four (outlet_manager/warehouse_manager/area_manager/
  // supervisor) verify the same manager_pins row manager-login's
  // master-PIN-fallback path checks, so they must share ITS counter
  // (mgr_master_${role}) — a separate one here would let an attacker double
  // their guess budget by alternating between the two endpoints. See the
  // matching comment on manager-login's failKey above.
  const failKey = role === 'resources' ? 'mgr_resources' : `mgr_master_${role}`;
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

// Supervisor-only: set a new master/recovery PIN for one role. Write-only
// — manager_pins only ever stores a bcrypt hash, so there is no "current
// value" this could return even if it tried. See
// docs/superpowers/specs/2026-08-06-manager-auth-design.md.
authRouter.post('/rotate-master-pin', requireAuth, requireScope('supervisor'), async (req, res) => {
  const role = (req.body.role || '').toString();
  const newMasterPin = (req.body.newMasterPin || '').toString();
  const validRoles = ['outlet_manager', 'warehouse_manager', 'area_manager'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ status: 'error', error: 'Unknown role.' });
  }
  if (!newMasterPin) {
    return res.status(400).json({ status: 'error', error: 'Enter a new master PIN.' });
  }
  if (newMasterPin.length < 6) {
    return res.status(400).json({ status: 'error', error: 'Master PIN must be at least 6 characters.' });
  }

  const pinHash = await bcrypt.hash(newMasterPin, 10);
  await pool.query(
    `insert into manager_pins (role, pin_hash) values ($1, $2)
     on conflict (role) do update set pin_hash = excluded.pin_hash`,
    [role, pinHash]
  );
  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'manager.rotate_pin',
    summary: `Rotated master PIN for role ${role}`,
  });
  res.json({ status: 'ok' });
});

// Master-only: set a new shared PIN for the Supervisor role. Supervisor is
// the one role with no existing recovery path — rotate-master-pin and
// manager-register both explicitly exclude it (Supervisor is the one who
// grants those, so it can't grant itself). Gated by requireMaster alone,
// not requireScope — Master's own auth is sufficient proof, this doesn't
// touch manager_credentials or any other role's manager_pins row. See
// docs/superpowers/specs/2026-08-11-master-subsystem-b-design.md.
authRouter.post('/master-reset-supervisor-pin', requireAuth, requireMaster, async (req, res) => {
  const newPin = (req.body.newPin || '').toString();

  // Failures here are validation failures (bad input), not a wrong-guess —
  // still counted so a leaked/compromised master token can't be hammered
  // against this endpoint indefinitely. Keyed to the master username in
  // the JWT (scopeKey on a 'master' token), not shared with any other
  // counter.
  const failKey = `master_reset_supervisor_${req.session.scopeKey}`;
  if (await isLockedOut(failKey)) {
    return res.status(429).json({ status: 'error', error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  if (newPin.length < 6) {
    await recordFailure(failKey);
    return res.status(400).json({ status: 'error', error: 'PIN must be at least 6 characters.' });
  }
  await clearFailures(failKey);

  const pinHash = await bcrypt.hash(newPin, 10);
  await pool.query(
    `insert into manager_pins (role, pin_hash) values ('supervisor', $1)
     on conflict (role) do update set pin_hash = excluded.pin_hash`,
    [pinHash]
  );
  logAuditSafe({
    actorType: 'master',
    actorKey: req.session.scopeKey,
    action: 'master.reset_supervisor_pin',
    summary: 'Reset Supervisor PIN',
  });
  res.json({ status: 'ok' });
});

// Master User login — fully independent of staff/manager auth (no
// scope_key/outlet, no relation to manager_pins/manager_credentials).
// See docs/superpowers/specs/2026-08-10-master-admin-subsystem-a-design.md.
authRouter.post('/master-login', async (req, res) => {
  const username = (req.body.username || '').toString().trim();
  const password = (req.body.password || '').toString();

  const failKey = `master_${username}`;
  if (await isLockedOut(failKey)) {
    return res.status(429).json({ authorized: false, error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  const { rows } = await pool.query('select password_hash from master_users where username = $1', [username]);
  const match = rows[0];
  const ok = match && password && await bcrypt.compare(password, match.password_hash);
  if (!ok) {
    await recordFailure(failKey);
    return res.json({ authorized: false, error: 'Incorrect username or password.' });
  }
  await clearFailures(failKey);

  logAuditSafe({
    actorType: 'master',
    actorKey: username,
    action: 'master.login',
    summary: `Master login: ${username}`,
  });

  const token = issueMasterToken(username);
  res.json({ authorized: true, token });
});
