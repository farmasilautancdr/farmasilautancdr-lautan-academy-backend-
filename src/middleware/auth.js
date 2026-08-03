import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export function issueToken(scopeType, scopeKey) {
  return jwt.sign({ scopeType, scopeKey }, env.jwtSecret, { expiresIn: '12h' });
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
