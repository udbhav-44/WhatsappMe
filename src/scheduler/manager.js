// src/scheduler/manager.js
'use strict';

// In-memory state: timers[userId] = Map<scheduleId, { handle, stopped }>
// Each schedule is driven by a self-rescheduling setTimeout (not node-cron),
// so we can fire a few minutes before/after the intended time (send jitter).
const timers = {};

const MAX_TIMEOUT = 2_000_000_000; // setTimeout caps near 2^31-1 ms (~24.8 days) — chunk longer waits

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

// Approximate seconds between fires, per cron form (used to cap jitter).
function intervalSeconds(cronExpr) {
  const [min, hour, dom] = cronExpr.split(' ');
  if (min.startsWith('*/')) return Number(min.slice(2)) * 60;            // minutes interval
  if (hour.includes('/')) return Number(hour.split('/')[1]) * 3600;      // hours interval
  if (dom.startsWith('*/')) return Number(dom.slice(2)) * 86400;         // days interval
  return 86400;                                                          // daily / weekly — >= a day
}

// Max jitter magnitude (seconds) for this schedule. Reads JITTER_MINUTES from
// the environment (0/unset/invalid → no jitter). Capped to stay under half the
// interval (minus a 30s buffer) so short intervals don't overlap or reorder.
function jitterMaxSeconds(cronExpr) {
  const mins = parseFloat(process.env.JITTER_MINUTES);
  if (!Number.isFinite(mins) || mins <= 0) return 0;
  const base = mins * 60;
  const iv = intervalSeconds(cronExpr);
  if (iv >= 86400) return Math.round(base);
  const cap = Math.max(0, Math.floor(iv / 2) - 30);
  return Math.round(Math.min(base, cap));
}

// Random offset in [-J, +J] seconds for this schedule (0 when jitter disabled).
function jitterOffset(cronExpr) {
  const j = jitterMaxSeconds(cronExpr);
  if (j <= 0) return 0;
  return Math.round((Math.random() * 2 - 1) * j);
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
    db.prepare('UPDATE schedules SET last_run = unixepoch() WHERE id = ?').run(schedule.id);
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

  // next_run (for missed-message recovery) is maintained by armSchedule.
  db.prepare('UPDATE schedules SET last_run = unixepoch() WHERE id = ?').run(schedule.id);
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

function clearUserTimers(userId) {
  if (!timers[userId]) return;
  for (const rec of timers[userId].values()) {
    rec.stopped = true;
    if (rec.handle) clearTimeout(rec.handle);
  }
  timers[userId] = new Map();
}

// Arm the next fire for a schedule. `fromSec` is where the next-run search
// begins — pass now for the first arm, and (intended T + 60) after a fire so
// the just-fired occurrence isn't re-selected (which would double-fire when
// jitter fired us early).
function armSchedule(schedule, fromSec) {
  const db = require('../db');
  const nowSec = Math.floor(Date.now() / 1000);
  const T = nextRunFor(schedule.cron_expr, fromSec);        // intended fire time
  const sendAt = T + jitterOffset(schedule.cron_expr);       // jittered actual send
  const delayMs = Math.max(0, (sendAt - nowSec) * 1000);

  // Record the upcoming intended fire for missed-recovery on restart.
  try { db.prepare('UPDATE schedules SET next_run = ? WHERE id = ?').run(T, schedule.id); } catch (_) {}

  if (!timers[schedule.user_id]) timers[schedule.user_id] = new Map();
  const rec = { handle: null, stopped: false };
  timers[schedule.user_id].set(schedule.id, rec);

  if (delayMs > MAX_TIMEOUT) {
    // Wait a chunk, then re-derive the same T and arm the remaining time.
    rec.handle = setTimeout(() => { if (!rec.stopped) armSchedule(schedule, fromSec); }, MAX_TIMEOUT);
    return;
  }

  rec.handle = setTimeout(async () => {
    if (rec.stopped) return;
    await fireSchedule(schedule).catch(err =>
      console.error(`[Scheduler] Uncaught error in schedule ${schedule.id}:`, err.message));
    if (!rec.stopped) armSchedule(schedule, T + 60);         // next occurrence
  }, delayMs);
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

    armSchedule(schedule, Math.floor(Date.now() / 1000));
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
  // Only stop old timers after successful DB read
  clearUserTimers(userId);
  const nowSec = Math.floor(Date.now() / 1000);
  for (const schedule of schedules) {
    armSchedule(schedule, nowSec);
  }
  console.log(`[Scheduler] Reloaded ${schedules.length} active schedule(s) for user ${userId}`);
}

module.exports = {
  init, reload, matchField, nextRunFor,
  intervalSeconds, jitterMaxSeconds, jitterOffset,
};
