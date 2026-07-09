// src/server.js
'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');

// Trigger DB migration on startup
require('./db/index');

// Start WhatsApp sessions for all existing users
const waManager = require('./whatsapp/manager');
waManager.startAllSessions().catch(console.error);

// Start cron scheduler (handles missed schedules, then starts all jobs)
const schedulerManager = require('./scheduler/manager');
schedulerManager.init().catch(console.error);

const app = express();

// Behind Cloudflare Tunnel / any reverse proxy — trust X-Forwarded-* headers
app.set('trust proxy', 1);

// Refuse to run in production without a real session secret — a default would
// let anyone forge session cookies. Dev falls back with a loud warning.
if (!process.env.SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[FATAL] SESSION_SECRET is not set. Refusing to start in production.');
    process.exit(1);
  }
  console.warn('[WARN] SESSION_SECRET not set — using an insecure dev default. Set it in .env before deploying.');
}

// Session store
const SQLiteStore = require('connect-sqlite3')(session);

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, '../data') }),
  secret: process.env.SESSION_SECRET || 'insecure-dev-only-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    sameSite: 'lax',
    // 'auto' → Secure flag over HTTPS (Cloudflare tunnel), but not on the plain
    // http LAN path, so LAN login still works. Relies on trust proxy above.
    secure: 'auto',
  }
}));

// Parse JSON bodies
app.use(express.json());

// Serve static files from src/web/
app.use(express.static(path.join(__dirname, 'web')));

// Auth middleware — protects all /api/* except /api/auth/*
const { authMiddleware } = require('./api/auth');

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth')) return next();
  authMiddleware(req, res, next);
});

// Mount API routers (graceful degradation if files are missing)
// Routers that use their full path internally (e.g. router.get('/contacts', ...))
// must be mounted at /api so the full path resolves correctly.
// Routers that use short paths (e.g. router.get('/login', ...)) keep specific mounts.
const apiRoutes = [
  { path: '/api/auth',     module: './api/auth',      destructure: true },
  { path: '/api',          module: './api/contacts' },
  { path: '/api',          module: './api/templates' },
  { path: '/api',          module: './api/schedules', destructure: true },
  { path: '/api',          module: './api/logs' },
  { path: '/api/whatsapp', module: './api/whatsapp' },
];

for (const route of apiRoutes) {
  try {
    let mod = require(route.module);
    if (route.destructure) {
      mod = mod.router;
    }
    app.use(route.path, mod);
  } catch (err) {
    console.warn(`Warning: router not found for ${route.path} (${route.module}): ${err.message}`);
  }
}

// Catch-all: serve index.html for any non-API GET (SPA routing)
app.get(/^(?!\/api).*$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

// Global error handler — log details server-side, return a generic message
// (don't leak internals/stack/SQL to the client).
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WhatsApp Scheduler running at http://localhost:${PORT}`);
});

module.exports = app;
