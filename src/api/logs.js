'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/logs
router.get('/logs', (req, res) => {
  const userId = req.session.userId;
  const { scheduleId, contactId, status } = req.query;

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;

  const conditions = ['l.user_id = ?'];
  const params = [userId];

  if (scheduleId) {
    conditions.push('l.schedule_id = ?');
    params.push(Number(scheduleId));
  }
  if (contactId) {
    conditions.push('l.contact_id = ?');
    params.push(Number(contactId));
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
