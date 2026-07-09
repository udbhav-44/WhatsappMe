'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

// ──────────────────────────────────────────────────────────────────────────────
// Cron helpers
// ──────────────────────────────────────────────────────────────────────────────

function toCron(schedule) {
  const { scheduleType, timeHour, timeMinute, days, intervalValue, intervalUnit } = schedule;
  if (scheduleType === 'daily') {
    return `${timeMinute} ${timeHour} * * *`;
  }
  if (scheduleType === 'weekly') {
    const dayList = days.sort().join(',');
    return `${timeMinute} ${timeHour} * * ${dayList}`;
  }
  if (scheduleType === 'interval') {
    if (intervalUnit === 'hours') return `0 */${intervalValue} * * *`;
    if (intervalUnit === 'days') return `0 0 */${intervalValue} * *`;
  }
  throw new Error('Invalid scheduleType');
}

function fromCron(cronExpr, scheduleType) {
  const parts = cronExpr.split(' ');
  if (scheduleType === 'daily') {
    return {
      scheduleType: 'daily',
      timeMinute: Number(parts[0]),
      timeHour: Number(parts[1]),
    };
  }
  if (scheduleType === 'weekly') {
    return {
      scheduleType: 'weekly',
      timeMinute: Number(parts[0]),
      timeHour: Number(parts[1]),
      days: parts[4].split(',').map(Number),
    };
  }
  if (scheduleType === 'interval') {
    if (parts[1].startsWith('*/')) {
      return {
        scheduleType: 'interval',
        intervalValue: Number(parts[1].slice(2)),
        intervalUnit: 'hours',
      };
    }
    if (parts[2].startsWith('*/')) {
      return {
        scheduleType: 'interval',
        intervalValue: Number(parts[2].slice(2)),
        intervalUnit: 'days',
      };
    }
  }
  return { scheduleType, cronExpr };
}

// ──────────────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────────────

function validateScheduleBody(body, userId, skipRequired = false) {
  const {
    name, templateId, recipientType, recipientId,
    scheduleType, timeHour, timeMinute, days, intervalValue, intervalUnit,
  } = body;

  if (!skipRequired) {
    if (!name || !String(name).trim()) return 'name is required';
    if (!templateId) return 'templateId is required';
    if (!recipientType) return 'recipientType is required';
    if (recipientId === undefined || recipientId === null) return 'recipientId is required';
    if (!scheduleType) return 'scheduleType is required';
  }

  if (templateId !== undefined) {
    const tmpl = db.prepare('SELECT id FROM templates WHERE id = ? AND user_id = ?').get(templateId, userId);
    if (!tmpl) return 'templateId not found or does not belong to user';
  }

  if (recipientType !== undefined && !['contact', 'group'].includes(recipientType)) {
    return 'recipientType must be contact or group';
  }

  if (recipientId !== undefined && recipientType !== undefined) {
    if (recipientType === 'contact') {
      const c = db.prepare('SELECT id FROM contacts WHERE id = ? AND user_id = ?').get(recipientId, userId);
      if (!c) return 'recipientId contact not found or does not belong to user';
    } else {
      const g = db.prepare('SELECT id FROM groups WHERE id = ? AND user_id = ?').get(recipientId, userId);
      if (!g) return 'recipientId group not found or does not belong to user';
    }
  }

  if (scheduleType !== undefined) {
    if (!['daily', 'weekly', 'interval'].includes(scheduleType)) {
      return 'scheduleType must be daily, weekly, or interval';
    }
    if (scheduleType === 'daily' || scheduleType === 'weekly') {
      if (timeHour === undefined || timeMinute === undefined) {
        return 'timeHour and timeMinute are required for daily/weekly schedules';
      }
      const h = Number(timeHour);
      const m = Number(timeMinute);
      if (!Number.isInteger(h) || h < 0 || h > 23) return 'timeHour must be 0-23';
      if (!Number.isInteger(m) || m < 0 || m > 59) return 'timeMinute must be 0-59';
    }
    if (scheduleType === 'weekly') {
      if (!Array.isArray(days) || days.length === 0) return 'days array must have at least one entry';
      if (days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return 'days entries must be 0-6';
    }
    if (scheduleType === 'interval') {
      if (!intervalValue || !Number.isInteger(Number(intervalValue)) || Number(intervalValue) <= 0) {
        return 'intervalValue must be a positive integer';
      }
      if (!['hours', 'days'].includes(intervalUnit)) return 'intervalUnit must be hours or days';
    }
  }

  return null; // valid
}

// ──────────────────────────────────────────────────────────────────────────────
// Scheduler reload helper
// ──────────────────────────────────────────────────────────────────────────────

function reloadScheduler(userId) {
  try {
    const { reload } = require('../scheduler/manager');
    reload(userId).catch(console.error);
  } catch (_) { /* scheduler not yet initialized */ }
}

// ──────────────────────────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/schedules
router.get('/schedules', (req, res) => {
  const userId = req.session.userId;
  const rows = db.prepare(`
    SELECT s.id, s.name, s.template_id, s.recipient_type, s.recipient_id,
           s.cron_expr, s.active, s.last_run, s.next_run,
           t.name AS template_name
    FROM schedules s
    LEFT JOIN templates t ON t.id = s.template_id
    WHERE s.user_id = ?
    ORDER BY s.name
  `).all(userId);
  return res.json(rows);
});

// POST /api/schedules
router.post('/schedules', (req, res) => {
  const userId = req.session.userId;
  const body = req.body;

  const err = validateScheduleBody(body, userId);
  if (err) return res.status(400).json({ error: err });

  let cronExpr;
  try {
    cronExpr = toCron(body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const info = db.prepare(`
    INSERT INTO schedules (user_id, name, template_id, recipient_type, recipient_id, cron_expr, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(userId, String(body.name).trim(), body.templateId, body.recipientType, body.recipientId, cronExpr);

  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(info.lastInsertRowid);
  reloadScheduler(userId);
  return res.status(201).json(schedule);
});

// PUT /api/schedules/:id
router.put('/schedules/:id', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const body = req.body;

  const existing = db.prepare('SELECT * FROM schedules WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) {
    return res.status(404).json({ error: 'Schedule not found' });
  }

  const err = validateScheduleBody(body, userId, true);
  if (err) return res.status(400).json({ error: err });

  // Merge with existing values
  const merged = {
    name: body.name !== undefined ? String(body.name).trim() : existing.name,
    templateId: body.templateId !== undefined ? body.templateId : existing.template_id,
    recipientType: body.recipientType !== undefined ? body.recipientType : existing.recipient_type,
    recipientId: body.recipientId !== undefined ? body.recipientId : existing.recipient_id,
    scheduleType: body.scheduleType,
    timeHour: body.timeHour,
    timeMinute: body.timeMinute,
    days: body.days,
    intervalValue: body.intervalValue,
    intervalUnit: body.intervalUnit,
  };

  let cronExpr = existing.cron_expr;
  if (body.scheduleType) {
    try {
      cronExpr = toCron(merged);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  db.prepare(`
    UPDATE schedules
    SET name = ?, template_id = ?, recipient_type = ?, recipient_id = ?, cron_expr = ?
    WHERE id = ? AND user_id = ?
  `).run(merged.name, merged.templateId, merged.recipientType, merged.recipientId, cronExpr, id, userId);

  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
  reloadScheduler(userId);
  return res.json(schedule);
});

// DELETE /api/schedules/:id
router.delete('/schedules/:id', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;

  const existing = db.prepare('SELECT id FROM schedules WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) {
    return res.status(404).json({ error: 'Schedule not found' });
  }

  db.prepare('DELETE FROM schedules WHERE id = ? AND user_id = ?').run(id, userId);
  reloadScheduler(userId);
  return res.json({ ok: true });
});

// PATCH /api/schedules/:id/toggle
router.patch('/schedules/:id/toggle', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;

  const existing = db.prepare('SELECT id, active FROM schedules WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) {
    return res.status(404).json({ error: 'Schedule not found' });
  }

  const newActive = existing.active === 1 ? 0 : 1;
  db.prepare('UPDATE schedules SET active = ? WHERE id = ? AND user_id = ?').run(newActive, id, userId);
  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
  reloadScheduler(userId);
  return res.json(schedule);
});

module.exports = { router, toCron, fromCron };
