// src/api/whatsapp.js
'use strict';

const express = require('express');
const waManager = require('../whatsapp/manager');

const router = express.Router();

// GET /api/whatsapp/status
// Returns: { connected: boolean, qr?: string }
router.get('/status', (req, res) => {
  const status = waManager.getStatus(req.session.userId);
  res.json(status);
});

// POST /api/whatsapp/disconnect
// Stops the current user's WhatsApp session
router.post('/disconnect', async (req, res) => {
  await waManager.stopSession(req.session.userId);
  res.json({ ok: true });
});

// POST /api/whatsapp/reconnect
// Starts (or restarts) the current user's WhatsApp session
router.post('/reconnect', async (req, res) => {
  const userId = req.session.userId;
  await waManager.stopSession(userId);
  await waManager.startSession(userId);
  res.json({ ok: true });
});

module.exports = router;
