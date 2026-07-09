// src/api/auth.js
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const db = require('../db');

const router = express.Router();

// The first account (the setup owner who sets SIGNUP_CODE) is the admin.
const ADMIN_USER_ID = 1;
function isAdmin(userId) { return userId === ADMIN_USER_ID; }

// Pure gate for removing a user (admin-only, can't remove the owner).
function canDeleteUser(requesterId, targetId) {
  if (!isAdmin(requesterId)) return { status: 403, error: 'Only the owner can remove people' };
  if (!Number.isInteger(targetId) || targetId <= 0) return { status: 400, error: 'Invalid user id' };
  if (targetId === ADMIN_USER_ID) return { status: 400, error: "The owner account can't be removed" };
  return { ok: true };
}

// In-memory rate limiter for login attempts
const loginAttempts = {}; // { userId: { count, lockedUntil } }

// POST /api/auth/login
router.post('/login', (req, res) => {
  const userId = parseInt(req.body.userId, 10);
  if (!userId || isNaN(userId)) return res.status(400).json({ error: 'Invalid userId' });
  const { pin } = req.body;
  if (!pin) {
    return res.status(400).json({ error: 'userId and pin are required' });
  }

  // Evict expired entries if map is large
  if (Object.keys(loginAttempts).length > 500) {
    const now = Date.now();
    for (const k of Object.keys(loginAttempts)) {
      if ((loginAttempts[k].lockedUntil || 0) < now) delete loginAttempts[k];
    }
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const attempts = loginAttempts[userId] || { count: 0, lockedUntil: 0 };
  if (attempts.lockedUntil > Date.now()) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  const match = bcrypt.compareSync(String(pin), user.pin_hash);
  if (!match) {
    attempts.count = (attempts.count || 0) + 1;
    if (attempts.count >= 5) {
      attempts.lockedUntil = Date.now() + 30 * 60 * 1000; // 30 min lockout
      attempts.count = 0;
    }
    loginAttempts[userId] = attempts;
    return res.status(401).json({ error: 'Invalid PIN' });
  }

  delete loginAttempts[userId];
  req.session.userId = user.id;
  return res.status(200).json({ ok: true, user: { id: user.id, name: user.name } });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.status(200).json({ ok: true });
  });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (req.session && req.session.userId) {
    const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(req.session.userId);
    if (user) {
      return res.status(200).json({ id: user.id, name: user.name, isAdmin: isAdmin(user.id) });
    }
  }
  return res.status(401).json({ error: 'Not authenticated' });
});

// DELETE /api/auth/users/:id — admin removes a user and all their data
router.delete('/users/:id', authMiddleware, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const gate = canDeleteUser(req.session.userId, targetId);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Log out + drop the WhatsApp session, then remove its files.
  try { await require('../whatsapp/manager').stopSession(targetId); } catch (_) {}
  try {
    fs.rmSync(path.join(process.cwd(), 'sessions', `user-${targetId}`), { recursive: true, force: true });
  } catch (_) {}

  // FK ON DELETE CASCADE wipes their contacts, groups, templates, schedules, logs.
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);

  // Clear any timers armed for the removed user (reads 0 active schedules now).
  // Awaited so cleanup completes before we respond.
  try { await require('../scheduler/manager').reload(targetId); } catch (_) {}

  return res.json({ ok: true });
});

// GET /api/auth/users — public, returns user list for login screen
router.get('/users', (req, res) => {
  const users = db.prepare('SELECT id, name FROM users ORDER BY name').all();
  return res.status(200).json(users);
});

// POST /api/auth/setup — public, creates first user (only if users table is empty)
router.post('/setup', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM users').get();
  if (count.cnt > 0) {
    return res.status(409).json({ error: 'Setup already complete' });
  }

  const { name, pin } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!pin || !/^\d{4}$/.test(String(pin))) {
    return res.status(400).json({ error: 'pin must be exactly 4 digits' });
  }

  const pin_hash = bcrypt.hashSync(String(pin), 10);

  // Insert with a placeholder session_dir; update after we get the id
  const stmt = db.prepare(
    'INSERT INTO users (name, pin_hash, session_dir) VALUES (?, ?, ?)'
  );
  const info = stmt.run(String(name).trim(), pin_hash, 'sessions/user-tmp');

  const id = info.lastInsertRowid;
  db.prepare("UPDATE users SET session_dir = ? WHERE id = ?").run(
    `sessions/user-${id}`, id
  );

  const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(id);
  return res.status(201).json({ ok: true, user: { id: user.id, name: user.name } });
});

// Pure gate for self-signup — decides the response without touching db/session.
// Returns { status, ok?, error?, attempts } where attempts is the next throttle state.
function evaluateSignup({ envCode, providedCode, name, pin, attempts, now }) {
  const code = (envCode || '').trim();
  if (!code) return { status: 403, error: 'Signup is disabled', attempts };
  if (attempts.lockedUntil > now) {
    return { status: 429, error: 'Too many attempts. Try again later.', attempts };
  }
  if ((providedCode || '').toString().trim() !== code) {
    const count = attempts.count + 1;
    const next = count >= 10
      ? { count: 0, lockedUntil: now + 15 * 60 * 1000 }
      : { count, lockedUntil: attempts.lockedUntil };
    return { status: 401, error: 'Wrong invite code', attempts: next };
  }
  const reset = { count: 0, lockedUntil: 0 };
  if (!name || !String(name).trim()) return { status: 400, error: 'name is required', attempts: reset };
  if (!pin || !/^\d{4}$/.test(String(pin))) return { status: 400, error: 'pin must be exactly 4 digits', attempts: reset };
  return { status: 201, ok: true, attempts: reset };
}

// In-memory throttle for signup-code attempts (global bucket — no user yet)
let signupAttempts = { count: 0, lockedUntil: 0 };

// POST /api/auth/signup — public self-signup gated by a shared invite code
router.post('/signup', (req, res) => {
  const result = evaluateSignup({
    envCode: process.env.SIGNUP_CODE,
    providedCode: req.body.code,
    name: req.body.name,
    pin: req.body.pin,
    attempts: signupAttempts,
    now: Date.now(),
  });
  signupAttempts = result.attempts;
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  const pin_hash = bcrypt.hashSync(String(req.body.pin), 10);
  const info = db.prepare('INSERT INTO users (name, pin_hash, session_dir) VALUES (?, ?, ?)').run(
    String(req.body.name).trim(), pin_hash, ''
  );
  const id = info.lastInsertRowid;
  db.prepare('UPDATE users SET session_dir = ? WHERE id = ?').run(`sessions/user-${id}`, id);

  req.session.userId = id; // auto-login the new user
  const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(id);
  return res.status(201).json({ ok: true, user: { id: user.id, name: user.name } });
});

// POST /api/auth/users — create additional user (must be logged in)
router.post('/users', authMiddleware, async (req, res) => {
  const { name, pin } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name required' });
  }
  if (!pin || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
  }
  const pin_hash = bcrypt.hashSync(pin.toString(), 10);
  const result = db.prepare('INSERT INTO users (name, pin_hash, session_dir) VALUES (?, ?, ?)').run(
    name.trim(), pin_hash, ''
  );
  const newId = result.lastInsertRowid;
  db.prepare('UPDATE users SET session_dir = ? WHERE id = ?').run(`sessions/user-${newId}`, newId);
  res.status(201).json({ ok: true, user: { id: newId, name: name.trim() } });
});

// Auth middleware — applied in server.js to protect /api/* except /api/auth/*.
// Verifies the user still exists so a removed user's stale session is rejected
// (their tab then 401s and the frontend redirects to the login screen).
function authMiddleware(req, res, next) {
  if (req.session && req.session.userId) {
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(req.session.userId);
    if (u) return next();
    return req.session.destroy(() => res.status(401).json({ error: 'Not authenticated' }));
  }
  res.status(401).json({ error: 'Not authenticated' });
}

module.exports = { router, authMiddleware, evaluateSignup, canDeleteUser };
