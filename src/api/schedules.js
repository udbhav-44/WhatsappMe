'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

// ──────────────────────────────────────────────────────────────────────────────
// Cron helpers
// ──────────────────────────────────────────────────────────────────────────────

// ── window + day-of-week helpers ────────────────────────────────────────────
function windowHourField(start, end) {
  if (start === 0 && end === 23) return '*';
  if (start === end) return String(start);
  return `${start}-${end}`;
}

function dowField(days) {
  if (!days || days.length === 0) return '*';
  return [...days].map(Number).sort((a, b) => a - b).join(',');
}

function parseWindow(hourField) {
  if (hourField === '*') return { windowStart: 0, windowEnd: 23 };
  if (hourField.includes('-')) {
    const [s, e] = hourField.split('-').map(Number);
    return { windowStart: s, windowEnd: e };
  }
  const h = Number(hourField);
  return { windowStart: h, windowEnd: h };
}

function parseDow(field) {
  if (!field || field === '*') return [];
  const out = [];
  for (const part of field.split(',')) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let i = a; i <= b; i++) out.push(i);
    } else {
      out.push(Number(part));
    }
  }
  return out;
}

// ── cron encode ─────────────────────────────────────────────────────────────
function toCron(schedule) {
  const {
    scheduleType, timeHour, timeMinute, days,
    intervalValue, intervalUnit, windowStart, windowEnd,
  } = schedule;

  if (scheduleType === 'daily') {
    return `${timeMinute} ${timeHour} * * *`;
  }
  if (scheduleType === 'weekly') {
    return `${timeMinute} ${timeHour} * * ${dowField(days)}`;
  }
  if (scheduleType === 'interval') {
    const ws = windowStart === undefined ? 0 : windowStart;
    const we = windowEnd === undefined ? 23 : windowEnd;
    if (intervalUnit === 'minutes') {
      return `*/${intervalValue} ${windowHourField(ws, we)} * * ${dowField(days)}`;
    }
    if (intervalUnit === 'hours') {
      const hf = windowHourField(ws, we);
      const stepField = hf === '*' ? `*/${intervalValue}` : `${hf}/${intervalValue}`;
      return `0 ${stepField} * * ${dowField(days)}`;
    }
    if (intervalUnit === 'days') {
      return `0 0 */${intervalValue} * *`;
    }
  }
  throw new Error('Invalid scheduleType');
}

// ── cron classify ───────────────────────────────────────────────────────────
function detectScheduleType(cronExpr) {
  const parts = cronExpr.split(' ');
  const [min, hour, dom] = parts;
  // interval markers must be checked before weekly: a minute/hour interval
  // may carry a day-of-week list that would otherwise look weekly.
  if (min.startsWith('*/') || hour.includes('/') || dom.startsWith('*/')) return 'interval';
  if (parts[4] && parts[4] !== '*') return 'weekly';
  if (hour && hour !== '*') return 'daily';
  return 'interval';
}

// ── cron decode ─────────────────────────────────────────────────────────────
function fromCron(cronExpr, scheduleType) {
  const parts = cronExpr.split(' ');
  if (scheduleType === 'daily') {
    return { scheduleType: 'daily', timeMinute: Number(parts[0]), timeHour: Number(parts[1]) };
  }
  if (scheduleType === 'weekly') {
    return {
      scheduleType: 'weekly',
      timeMinute: Number(parts[0]),
      timeHour: Number(parts[1]),
      days: parseDow(parts[4]),
    };
  }
  if (scheduleType === 'interval') {
    const [min, hour, dom] = parts;
    if (min.startsWith('*/')) {
      const w = parseWindow(hour);
      return {
        scheduleType: 'interval', intervalUnit: 'minutes', intervalValue: Number(min.slice(2)),
        windowStart: w.windowStart, windowEnd: w.windowEnd, days: parseDow(parts[4]),
      };
    }
    if (hour.includes('/')) {
      const [range, step] = hour.split('/');
      const w = parseWindow(range);
      return {
        scheduleType: 'interval', intervalUnit: 'hours', intervalValue: Number(step),
        windowStart: w.windowStart, windowEnd: w.windowEnd, days: parseDow(parts[4]),
      };
    }
    if (dom.startsWith('*/')) {
      return {
        scheduleType: 'interval', intervalUnit: 'days', intervalValue: Number(dom.slice(2)),
        windowStart: 0, windowEnd: 23, days: [],
      };
    }
  }
  return { scheduleType, intervalValue: 1, intervalUnit: 'hours', windowStart: 0, windowEnd: 23, days: [] };
}

// ──────────────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────────────

function validateScheduleBody(body, userId, skipRequired = false) {
  const {
    name, templateId, recipientType, recipientId,
    scheduleType, timeHour, timeMinute, days,
    intervalValue, intervalUnit, windowStart, windowEnd,
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
      if (!['minutes', 'hours', 'days'].includes(intervalUnit)) {
        return 'intervalUnit must be minutes, hours, or days';
      }
      const iv = Number(intervalValue);
      if (intervalUnit === 'minutes') {
        if (![5, 10, 15, 20, 30].includes(iv)) return 'minutes interval must be one of 5, 10, 15, 20, 30';
      } else if (intervalUnit === 'hours') {
        if (!Number.isInteger(iv) || iv < 1 || iv > 23) return 'hours interval must be 1-23';
      } else {
        if (!Number.isInteger(iv) || iv <= 0) return 'intervalValue must be a positive integer';
      }
      if (intervalUnit === 'minutes' || intervalUnit === 'hours') {
        const ws = windowStart === undefined ? 0 : Number(windowStart);
        const we = windowEnd === undefined ? 23 : Number(windowEnd);
        if (!Number.isInteger(ws) || ws < 0 || ws > 23) return 'windowStart must be 0-23';
        if (!Number.isInteger(we) || we < 0 || we > 23) return 'windowEnd must be 0-23';
        if (we < ws) return 'windowEnd must be >= windowStart';
      }
      if (days !== undefined && days !== null) {
        if (!Array.isArray(days)) return 'days must be an array';
        if (days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return 'days entries must be 0-6';
      }
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
  const decoded = rows.map(s => ({
    ...s,
    ...fromCron(s.cron_expr, detectScheduleType(s.cron_expr)),
  }));
  return res.json(decoded);
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
  const mergedRecipientType = body.recipientType || existing.recipient_type;
  const mergedRecipientId = body.recipientId !== undefined ? Number(body.recipientId) : existing.recipient_id;

  // Check ownership using EFFECTIVE type, not just body type
  if (body.recipientId !== undefined) {
    if (mergedRecipientType === 'contact') {
      const c = db.prepare('SELECT id FROM contacts WHERE id=? AND user_id=?').get(mergedRecipientId, userId);
      if (!c) return res.status(400).json({ error: 'Contact not found or does not belong to you' });
    } else {
      const g = db.prepare('SELECT id FROM groups WHERE id=? AND user_id=?').get(mergedRecipientId, userId);
      if (!g) return res.status(400).json({ error: 'Group not found or does not belong to you' });
    }
  }

  const merged = {
    name: body.name !== undefined ? String(body.name).trim() : existing.name,
    templateId: body.templateId !== undefined ? body.templateId : existing.template_id,
    recipientType: mergedRecipientType,
    recipientId: mergedRecipientId,
    scheduleType: body.scheduleType,
    timeHour: body.timeHour,
    timeMinute: body.timeMinute,
    days: body.days,
    windowStart: body.windowStart,
    windowEnd: body.windowEnd,
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

module.exports = { router, toCron, fromCron, detectScheduleType, validateScheduleBody };
