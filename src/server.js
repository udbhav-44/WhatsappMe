// src/server.js
'use strict';

const express = require('express');
const session = require('express-session');
const path = require('path');

// Trigger DB migration on startup
require('./db/index');

const app = express();

// Session store
const SQLiteStore = require('connect-sqlite3')(session);

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: './data' }),
  secret: process.env.SESSION_SECRET || 'wa-scheduler-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));

// Parse JSON bodies
app.use(express.json());

// Serve static files from src/web/
app.use(express.static(path.join(__dirname, 'web')));

// Auth middleware — protects all /api/* except /api/auth/* and /api/setup
let authMiddleware;
try {
  ({ authMiddleware } = require('./api/auth'));
} catch (err) {
  console.warn(`Warning: could not load authMiddleware: ${err.message}`);
  authMiddleware = (req, res, next) => next();
}

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth') || req.path.startsWith('/setup')) return next();
  authMiddleware(req, res, next);
});

// Mount API routers (graceful degradation if files are missing)
const apiRoutes = [
  { path: '/api/auth', module: './api/auth', destructure: true },
  { path: '/api/contacts', module: './api/contacts' },
  { path: '/api/templates', module: './api/templates' },
  { path: '/api/schedules', module: './api/schedules' },
  { path: '/api/logs', module: './api/logs' },
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

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WhatsApp Scheduler running at http://localhost:${PORT}`);
});

module.exports = app;
