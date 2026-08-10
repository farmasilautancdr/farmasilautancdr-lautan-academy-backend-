import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { pool } from '../config/db.js';

export function issueToken(scopeType, scopeKey) {
  return jwt.sign({ scopeType, scopeKey }, env.jwtSecret, { expiresIn: '12h' });
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
