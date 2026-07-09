// src/scheduler/manager.js
'use strict';

const cron = require('node-cron');

// In-memory state: crons[userId] = Map<scheduleId, cronJob>
const crons = {};

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const IST_OFFSET = 19800; // Asia/Kolkata = UTC+05:30, no DST

// Match a single cron field (already split) against a numeric value.
// range = { min, max } for the field (used by '*' steps and open-ended steps).
function matchField(field, value, range) {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    if (part.startsWith('*/')) {
      const step = Number(part.slice(2));
      if ((value - range.min) % step === 0) return true;
    } else if (part.includes('/')) {
      const [base, stepStr] = part.split('/');
      const step = Number(stepStr);
      let lo, hi;
      if (base === '*') { lo = range.min; hi = range.max; }
      else if (base.includes('-')) { [lo, hi] = base.split('-').map(Number); }
      else { lo = Number(base); hi = range.max; }
      if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      if (value >= lo && value <= hi) return true;
    } else if (Number(part) === value) {
      return true;
    }
  }
  return false;
}

// Next matching minute strictly after the minute containing fromSec, whose IST wall-clock satisfies cronExpr.
// Walks minute-by-minute (cheap; only runs at schedule create/fire/startup).
function nextRunFor(cronExpr, fromSec) {
  const parts = cronExpr.split(' ');
  const start = (fromSec === undefined ? Math.floor(Date.now() / 1000) : fromSec);
  let t = start - (start % 60) + 60; // next whole minute
  const maxT = t + 366 * 24 * 3600;
  for (; t <= maxT; t += 60) {
    const d = new Date((t + IST_OFFSET) * 1000);
    const min = d.getUTCMinutes();
    const hour = d.getUTCHours();
    const dom = d.getUTCDate();
    const dow = d.getUTCDay();
    // Month field (parts[3]) intentionally unchecked: this app only ever generates '*' for month.
    // dom is always '*' in generated expressions, so AND-ing dom & dow matches cron's dom/dow OR semantics in practice.
    if (
      matchField(parts[0], min, { min: 0, max: 59 }) &&
      matchField(parts[1], hour, { min: 0, max: 23 }) &&
      matchField(parts[2], dom, { min: 1, max: 31 }) &&
      matchField(parts[4], dow, { min: 0, max: 6 })
    ) {
      return t;
    }
  }
  return start + 24 * 3600; // fallback: never expected for our expressions
}

function estimateNextRun(cronExpr) {
  return nextRunFor(cronExpr);
}

function getRecipients(schedule) {
  const db = require('../db');
  if (schedule.recipient_type === 'contact') {
    const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(schedule.recipient_id);
    return c ? [c] : [];
  } else {
    return db.prepare(`
      SELECT c.* FROM contacts c
      JOIN group_contacts gc ON gc.contact_id = c.id
      WHERE gc.group_id = ?
    `).all(schedule.recipient_id);
  }
}

async function fireSchedule(schedule) {
  const db = require('../db');
  const waManager = require('../whatsapp/manager');
  const { render } = require('../templates/renderer');

  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(schedule.template_id);
  if (!template) {
    console.warn(`[Scheduler] Schedule ${schedule.id} references deleted template ${schedule.template_id} — skipping send`);
    db.prepare('UPDATE schedules SET last_run = unixepoch(), next_run = ? WHERE id = ?')
      .run(estimateNextRun(schedule.cron_expr), schedule.id);
    return;
  }
  const contacts = getRecipients(schedule);

  for (const contact of contacts) {
    try {
      const message = render(template.body, contact);
      const ok = await waManager.sendText(schedule.user_id, contact.phone, message);
      const status = ok ? 'sent' : 'failed';
      console.log(`[Scheduler] Schedule "${schedule.name}" (id:${schedule.id}) → ${contact.name} ${contact.phone}: ${status}`);
      db.prepare(`
        INSERT INTO logs (user_id, schedule_id, contact_id, phone, message_body, sent_at, status)
        VALUES (?, ?, ?, ?, ?, unixepoch(), ?)
      `).run(
        schedule.user_id,
        schedule.id,
        contact.id,
        contact.phone,
        message,
        status
      );
    } catch (err) {
      console.error(`[Scheduler] Error firing schedule ${schedule.id} for contact ${contact.id}:`, err.message);
      try {
        db.prepare(`
          INSERT INTO logs (user_id, schedule_id, contact_id, phone, message_body, sent_at, status)
          VALUES (?, ?, ?, ?, ?, unixepoch(), 'failed')
        `).run(
          schedule.user_id,
          schedule.id,
          contact.id,
          contact.phone,
          '[error]'
        );
      } catch (_) {}
    }
  }

  // Update last_run and set estimated next_run for missed-message recovery
  db.prepare('UPDATE schedules SET last_run = unixepoch(), next_run = ? WHERE id = ?')
    .run(estimateNextRun(schedule.cron_expr), schedule.id);
}

function logMissed(schedule) {
  const db = require('../db');
  const contacts = getRecipients(schedule);
  for (const contact of contacts) {
    try {
      db.prepare(`
        INSERT INTO logs (user_id, schedule_id, contact_id, phone, message_body, sent_at, status)
        VALUES (?, ?, ?, ?, ?, unixepoch(), 'missed')
      `).run(schedule.user_id, schedule.id, contact.id, contact.phone, '[missed]');
    } catch (err) {
      console.error(`[Scheduler] Error logging missed for schedule ${schedule.id}:`, err.message);
    }
  }
}

function startJob(schedule) {
  const job = cron.schedule(schedule.cron_expr, async () => {
    await fireSchedule(schedule).catch(err =>
      console.error(`[Scheduler] Uncaught error in schedule ${schedule.id}:`, err.message)
    );
  }, {
    scheduled: true,
    timezone: 'Asia/Kolkata', // IST — hardcoded for this family use case
  });

  if (!crons[schedule.user_id]) crons[schedule.user_id] = new Map();
  crons[schedule.user_id].set(schedule.id, job);
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

async function init() {
  const db = require('../db');
  const schedules = db.prepare('SELECT * FROM schedules WHERE active = 1').all();

  for (const schedule of schedules) {
    // Handle missed schedules
    if (schedule.next_run && schedule.next_run < Math.floor(Date.now() / 1000)) {
      const overdueSecs = Math.floor(Date.now() / 1000) - schedule.next_run;
      if (overdueSecs < 6 * 3600) {
        console.log(`[Scheduler] Firing missed schedule ${schedule.id} (overdue ${overdueSecs}s)`);
        await fireSchedule(schedule).catch(console.error);
      } else {
        console.log(`[Scheduler] Marking schedule ${schedule.id} as missed (overdue ${overdueSecs}s)`);
        logMissed(schedule);
      }
    }

    startJob(schedule);
  }

  console.log(`[Scheduler] Initialized ${schedules.length} active schedule(s)`);
}

async function reload(userId) {
  const db = require('../db');
  let schedules;
  try {
    schedules = db.prepare('SELECT * FROM schedules WHERE user_id=? AND active=1').all(userId);
  } catch (err) {
    console.error(`[Scheduler] reload failed for user ${userId} (DB error): ${err.message} — keeping existing jobs`);
    return;
  }
  // Only stop old jobs after successful DB read
  if (crons[userId]) {
    for (const job of crons[userId].values()) job.stop();
  }
  crons[userId] = new Map();
  for (const schedule of schedules) {
    startJob(schedule);
  }
  console.log(`[Scheduler] Reloaded ${schedules.length} active schedule(s) for user ${userId}`);
}

module.exports = { init, reload, matchField, nextRunFor };
