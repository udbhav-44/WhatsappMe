'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/logs
router.get('/logs', (req, res) => {
  const userId = req.session.userId;
  const scheduleId = req.query.scheduleId ? parseInt(req.query.scheduleId, 10) : null;
  const contactId = req.query.contactId ? parseInt(req.query.contactId, 10) : null;
  const status = req.query.status || null;

  if (req.query.scheduleId && (isNaN(scheduleId) || scheduleId <= 0)) {
    return res.status(400).json({ error: 'Invalid scheduleId' });
  }
  if (req.query.contactId && (isNaN(contactId) || contactId <= 0)) {
    return res.status(400).json({ error: 'Invalid contactId' });
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;

  const conditions = ['l.user_id = ?'];
  const params = [userId];

  if (scheduleId) {
    conditions.push('l.schedule_id = ?');
    params.push(scheduleId);
  }
  if (contactId) {
    conditions.push('l.contact_id = ?');
    params.push(contactId);
  }
  if (status && ['sent', 'failed', 'missed'].includes(status)) {
    conditions.push('l.status = ?');
    params.push(status);
  }

  const where = conditions.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM logs l WHERE ${where}`).get(...params).cnt;

  const logs = db.prepare(`
    SELECT l.id, l.schedule_id, l.contact_id, l.phone, l.message_body, l.sent_at, l.status,
           s.name AS schedule_name
    FROM logs l
    LEFT JOIN schedules s ON s.id = l.schedule_id
    WHERE ${where}
    ORDER BY l.sent_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const pages = Math.ceil(total / limit) || 1;

  return res.json({ logs, total, page, pages });
});

module.exports = router;
