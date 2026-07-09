// src/scheduler/manager.js
'use strict';

const cron = require('node-cron');

// In-memory state: crons[userId] = Map<scheduleId, cronJob>
const crons = {};

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function estimateNextRun(cronExpr) {
  const parts = cronExpr.split(' ');
  const now = Math.floor(Date.now() / 1000);
  // Interval hours: "0 */H * * *"
  if (parts[1] && parts[1].startsWith('*/')) {
    const hours = parseInt(parts[1].slice(2), 10);
    return isNaN(hours) ? now + 3600 : now + hours * 3600;
  }
  // Interval days: "0 0 */D * *"
  if (parts[2] && parts[2].startsWith('*/')) {
    const days = parseInt(parts[2].slice(2), 10);
    return isNaN(days) ? now + 86400 : now + days * 86400;
  }
  // Daily or weekly — minimum 23h ahead
  return now + 23 * 3600;
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
  const contacts = getRecipients(schedule);

  for (const contact of contacts) {
    try {
      const message = render(template ? template.body : '', contact);
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

module.exports = { init, reload };
