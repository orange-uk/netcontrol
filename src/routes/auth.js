// netcontrol/src/routes/auth.js

import { config } from '../config.js';

// Simple session token issued after correct PIN entry
// In-memory — clears on server restart (by design, forces re-auth)
const validTokens = new Set();

export function issueToken() {
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  validTokens.add(token);
  return token;
}

export function revokeToken(token) {
  validTokens.delete(token);
}

// Middleware: require a valid token for mutating routes (POST/PUT/DELETE)
export function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!token || !validTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorised — please log in' });
  }
  next();
}

// POST /api/auth/login  { pin: '1234' }
export function loginHandler(req, res) {
  const { pin } = req.body;
  if (pin === config.pin) {
    const token = issueToken();
    return res.json({ ok: true, token });
  }
  return res.status(401).json({ ok: false, error: 'Incorrect PIN' });
}

// POST /api/auth/logout
export function logoutHandler(req, res) {
  const token = req.headers['x-auth-token'];
  if (token) revokeToken(token);
  res.json({ ok: true });
}
