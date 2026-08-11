import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { pool } from '../config/db.js';
import { isRevoked } from '../services/sessionRevocationCache.js';

// 12h matches this project's existing staff/manager JWT lifetime — kept as
// one constant so the DB row's expires_at and the JWT's own expiresIn can
// never drift apart. Expressed in minutes (not hours) so Master Subsystem
// H's shorter 30-minute impersonation lifetime uses the exact same
// interval/expiresIn construction — jsonwebtoken's expiresIn string is
// parsed by the `ms` package, which does not reliably parse a fractional-
// hour string like "0.5h".
const SESSION_TTL_MINUTES = 12 * 60;

// opts.expiresInMinutes / opts.impersonatedBy are used only by Master
// Subsystem H's impersonation flow (routes/masterImpersonate.js) — every
// existing caller passes neither and gets the same 12h/untagged behavior
// as before. See docs/superpowers/specs/2026-08-11-master-subsystem-h-design.md.
export async function issueToken(scopeType, scopeKey, opts = {}) {
  const ttlMinutes = opts.expiresInMinutes || SESSION_TTL_MINUTES;
  const impersonatedBy = opts.impersonatedBy || null;
  const { rows } = await pool.query(
    `insert into sessions (scope_type, scope_key, expires_at, impersonated_by)
     values ($1, $2, now() + interval '${ttlMinutes} minutes', $3)
     returning id`,
    [scopeType, scopeKey, impersonatedBy]
  );
  // bigserial comes back as a JS string from node-pg — keep it a string all
  // the way through (JWT claim, revocation cache, revoke-route params). See
  // this file's Global Constraints note on the standard_questions.id bug.
  const sid = rows[0].id;
  const claims = { scopeType, scopeKey, sid };
  if (impersonatedBy) claims.impersonated = true;
  return jwt.sign(claims, env.jwtSecret, { expiresIn: `${ttlMinutes}m` });
}

// Separate signer from issueToken: shorter expiry since this is an
// elevated-privilege session, not a daily-driver login. See
// docs/superpowers/specs/2026-08-10-master-admin-subsystem-a-design.md.
export function issueMasterToken(username) {
  return jwt.sign({ scopeType: 'master', scopeKey: username }, env.jwtSecret, { expiresIn: '2h' });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.body.token;
  if (!token) return res.status(401).json({ authorized: false, error: 'No session token.' });
  try {
    req.session = jwt.verify(token, env.jwtSecret);
    // Master tokens carry no sid and are never tracked/revocable (see
    // Global Constraints) — same 401 shape as natural expiry, so a
    // force-logged-out client needs no new frontend error handling.
    if (req.session.scopeType !== 'master' && isRevoked(req.session.sid)) {
      return res.status(401).json({ authorized: false, error: 'Your session has expired — please log in again.' });
    }
    // Master Subsystem H: impersonation tokens are view-only. This is the
    // single enforcement point — every authenticated route already runs
    // through requireAuth, so no per-route edits are needed. See
    // docs/superpowers/specs/2026-08-11-master-subsystem-h-design.md.
    if (req.session.impersonated && req.method !== 'GET') {
      return res.status(403).json({ authorized: false, error: 'View-only — action not permitted while impersonating.' });
    }
    next();
  } catch (e) {
    res.status(401).json({ authorized: false, error: 'Your session has expired — please log in again.' });
  }
}

// Restricts to a set of scopeTypes, and optionally checks scopeKey matches
// an outlet taken from the request (query/body), mirroring the GAS
// checkManagerScope pattern.
export function requireScope(...allowedScopeTypes) {
  return (req, res, next) => {
    if (!allowedScopeTypes.includes(req.session.scopeType)) {
      return res.status(403).json({ authorized: false, error: 'Not authorized for this action.' });
    }
    next();
  };
}

// Strict single-scope check for Master-only routes (subsystems B-H build
// on this). requireScope('master') would also work, but this reads more
// clearly at every Master-only call site.
export function requireMaster(req, res, next) {
  if (req.session?.scopeType !== 'master') {
    return res.status(403).json({ authorized: false, error: 'Not authorized for this action.' });
  }
  next();
}

// Global kill-switch check, applied to every router except /auth and
// /master/* (Master must always be able to log in and turn this back off).
// Fails open on a DB error — a hiccup reading this flag must not become a
// second outage on top of whatever the switch was meant to guard against.
// See docs/superpowers/specs/2026-08-11-master-subsystem-d-design.md.
export async function checkMaintenance(req, res, next) {
  try {
    const { rows } = await pool.query(`select value from system_settings where key = 'maintenance'`);
    const value = rows[0]?.value;
    if (value?.enabled === true) {
      return res.status(503).json({
        authorized: false,
        maintenance: true,
        message: value.message || '',
      });
    }
    next();
  } catch (err) {
    console.error('checkMaintenance query failed, failing open:', err.message);
    next();
  }
}
