# Interval Messages Within a Daytime Window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let interval schedules fire only within a chosen daytime hour-window, at sub-hour or hour granularity, optionally restricted to days of the week — all encoded in the existing `cron_expr`, no DB migration.

**Architecture:** Cron string stays the single source of truth. The pure encode/decode helpers in `src/api/schedules.js` are extended to carry window + minute-step + day-of-week. The scheduler's `estimateNextRun` is rewritten to compute the true next fire time (used for missed-message recovery). The Alpine form in `src/web/app.html` gains window inputs, a minutes unit, and day chips for interval schedules.

**Tech Stack:** Node.js 20 (CommonJS), Express, node-cron@4, better-sqlite3, Alpine.js (no build step). Tests: built-in `node:test` runner (zero new deps).

## Global Constraints

- Node.js 20+, CommonJS (`require`/`module.exports`).
- Timezone is hardcoded `Asia/Kolkata` (IST, fixed +05:30, no DST).
- No new npm dependencies. Tests use `node:test` + `node:assert`.
- No database migration; `schedules.cron_expr` remains the only stored form.
- Window bounds are whole hours, end-inclusive. Empty days = every day.
- Minutes interval restricted to {5,10,15,20,30} (divides 60 → even spacing).
- Backward compatibility: existing crons (`0 */2 * * *`, `0 0 */3 * *`, daily `M H * * *`, weekly `M H * * D`) must still decode and classify correctly.

---

## File Structure

- `src/api/schedules.js` — MODIFY: extend `toCron`, `fromCron`, `detectScheduleType`; add window/dow helpers; extend `validateScheduleBody`; thread window fields through PUT merge; widen `module.exports`.
- `src/scheduler/manager.js` — MODIFY: replace `estimateNextRun` with a cron-matcher-based next-run computer (`matchField` + `nextRunFor`); export them for tests.
- `src/web/app.html` — MODIFY: interval form UI (minutes unit, window row, day chips), form state, `validateComposer`, `describe`, save payload.
- `test/cron-encode.test.js` — CREATE: round-trip + classification tests.
- `test/cron-validate.test.js` — CREATE: validation tests.
- `test/next-run.test.js` — CREATE: `matchField`/`nextRunFor` tests + node-cron acceptance smoke.
- `package.json` — MODIFY: `test` script → `node --test`.

---

### Task 1: Cron encode / decode / classify

**Files:**
- Modify: `src/api/schedules.js` (functions `toCron` ~12-26, `detectScheduleType` ~28-36, `fromCron` ~38-72, exports ~292)
- Test: `test/cron-encode.test.js`

**Interfaces:**
- Produces:
  - `toCron(schedule) -> string` where `schedule` may include `{ scheduleType, timeHour, timeMinute, days, intervalValue, intervalUnit, windowStart, windowEnd }`. `intervalUnit ∈ {'minutes','hours','days'}`.
  - `fromCron(cronExpr, scheduleType) -> object` returning interval objects shaped `{ scheduleType:'interval', intervalUnit, intervalValue, windowStart, windowEnd, days }`.
  - `detectScheduleType(cronExpr) -> 'daily'|'weekly'|'interval'`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test**

Create `test/cron-encode.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { toCron, fromCron, detectScheduleType } = require('../src/api/schedules');

const cases = [
  { in: { scheduleType:'interval', intervalUnit:'minutes', intervalValue:30, windowStart:9, windowEnd:18, days:[] }, cron: '*/30 9-18 * * *' },
  { in: { scheduleType:'interval', intervalUnit:'minutes', intervalValue:15, windowStart:8, windowEnd:20, days:[1,2,3,4,5] }, cron: '*/15 8-20 * * 1,2,3,4,5' },
  { in: { scheduleType:'interval', intervalUnit:'hours', intervalValue:2, windowStart:9, windowEnd:18, days:[1,2,3,4,5] }, cron: '0 9-18/2 * * 1,2,3,4,5' },
  { in: { scheduleType:'interval', intervalUnit:'hours', intervalValue:2, windowStart:0, windowEnd:23, days:[] }, cron: '0 */2 * * *' },
  { in: { scheduleType:'interval', intervalUnit:'days', intervalValue:3 }, cron: '0 0 */3 * *' },
  { in: { scheduleType:'daily', timeHour:8, timeMinute:30 }, cron: '30 8 * * *' },
  { in: { scheduleType:'weekly', timeHour:9, timeMinute:0, days:[1,3] }, cron: '0 9 * * 1,3' },
];

test('toCron produces expected cron for each case', () => {
  for (const c of cases) assert.strictEqual(toCron(c.in), c.cron, JSON.stringify(c.in));
});

test('detectScheduleType classifies each cron', () => {
  assert.strictEqual(detectScheduleType('*/30 9-18 * * *'), 'interval');
  assert.strictEqual(detectScheduleType('*/15 8-20 * * 1,2,3,4,5'), 'interval');
  assert.strictEqual(detectScheduleType('0 9-18/2 * * 1,2,3,4,5'), 'interval');
  assert.strictEqual(detectScheduleType('0 */2 * * *'), 'interval');
  assert.strictEqual(detectScheduleType('0 0 */3 * *'), 'interval');
  assert.strictEqual(detectScheduleType('30 8 * * *'), 'daily');
  assert.strictEqual(detectScheduleType('0 9 * * 1,3'), 'weekly');
});

test('fromCron round-trips through toCron', () => {
  for (const c of cases) {
    const decoded = fromCron(c.cron, detectScheduleType(c.cron));
    assert.strictEqual(toCron(decoded), c.cron, 'round-trip ' + c.cron);
  }
});

test('fromCron decodes interval window + days', () => {
  const d = fromCron('*/30 9-18 * * 1,2,3,4,5', 'interval');
  assert.strictEqual(d.intervalUnit, 'minutes');
  assert.strictEqual(d.intervalValue, 30);
  assert.strictEqual(d.windowStart, 9);
  assert.strictEqual(d.windowEnd, 18);
  assert.deepStrictEqual(d.days, [1,2,3,4,5]);
});

test('fromCron expands day-of-week range', () => {
  const d = fromCron('*/15 8-20 * * 1-5', 'interval');
  assert.deepStrictEqual(d.days, [1,2,3,4,5]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cron-encode.test.js`
Expected: FAIL (current `toCron` has no `minutes` unit / no window; round-trip and classification mismatch).

- [ ] **Step 3: Implement the encode/decode/classify changes**

In `src/api/schedules.js`, replace the `toCron`, `detectScheduleType`, and `fromCron` functions (lines ~12-72) with:

```js
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
```

Then update the exports line at the bottom of the file (~292) from:

```js
module.exports = { router, toCron, fromCron };
```

to:

```js
module.exports = { router, toCron, fromCron, detectScheduleType };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cron-encode.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/schedules.js test/cron-encode.test.js
git commit -m "feat: encode interval window + minute-step + day-of-week in cron

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Server-side validation + PUT merge

**Files:**
- Modify: `src/api/schedules.js` (`validateScheduleBody` ~78-137; PUT `merged` object ~227-238; exports)
- Test: `test/cron-validate.test.js`

**Interfaces:**
- Consumes: nothing from Task 1's runtime output (same file).
- Produces: `validateScheduleBody(body, userId, skipRequired) -> string|null` now validating `intervalUnit ∈ {minutes,hours,days}`, minutes set, hours range, window bounds, and optional interval `days`.

- [ ] **Step 1: Write the failing test**

Create `test/cron-validate.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateScheduleBody } = require('../src/api/schedules');

// skipRequired=true and no templateId/recipient fields → only timing rules run,
// so these tests never touch the database.
function v(body) { return validateScheduleBody(body, 1, true); }

test('accepts valid minutes interval with window and days', () => {
  assert.strictEqual(v({ scheduleType:'interval', intervalUnit:'minutes', intervalValue:30, windowStart:9, windowEnd:18, days:[1,2,3,4,5] }), null);
});

test('accepts valid hours interval with window', () => {
  assert.strictEqual(v({ scheduleType:'interval', intervalUnit:'hours', intervalValue:2, windowStart:9, windowEnd:18 }), null);
});

test('accepts minutes interval with default (omitted) window', () => {
  assert.strictEqual(v({ scheduleType:'interval', intervalUnit:'minutes', intervalValue:15 }), null);
});

test('rejects minutes not in allowed set', () => {
  assert.ok(v({ scheduleType:'interval', intervalUnit:'minutes', intervalValue:7, windowStart:9, windowEnd:18 }));
});

test('rejects hours outside 1-23', () => {
  assert.ok(v({ scheduleType:'interval', intervalUnit:'hours', intervalValue:24, windowStart:9, windowEnd:18 }));
});

test('rejects windowEnd before windowStart', () => {
  assert.ok(v({ scheduleType:'interval', intervalUnit:'minutes', intervalValue:30, windowStart:18, windowEnd:9 }));
});

test('rejects window hour out of range', () => {
  assert.ok(v({ scheduleType:'interval', intervalUnit:'minutes', intervalValue:30, windowStart:9, windowEnd:24 }));
});

test('rejects bad interval unit', () => {
  assert.ok(v({ scheduleType:'interval', intervalUnit:'weeks', intervalValue:1 }));
});

test('rejects day-of-week entry out of range', () => {
  assert.ok(v({ scheduleType:'interval', intervalUnit:'minutes', intervalValue:30, days:[7] }));
});

test('still accepts valid daily', () => {
  assert.strictEqual(v({ scheduleType:'daily', timeHour:8, timeMinute:30 }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cron-validate.test.js`
Expected: FAIL — `validateScheduleBody` is not exported yet, and current logic rejects `minutes` / has no window checks.

- [ ] **Step 3: Implement validation changes**

In `src/api/schedules.js`, update the destructure at the top of `validateScheduleBody` (~79-82) to include the window fields:

```js
  const {
    name, templateId, recipientType, recipientId,
    scheduleType, timeHour, timeMinute, days,
    intervalValue, intervalUnit, windowStart, windowEnd,
  } = body;
```

Replace the entire interval validation block (currently ~128-133):

```js
    if (scheduleType === 'interval') {
      if (!intervalValue || !Number.isInteger(Number(intervalValue)) || Number(intervalValue) <= 0) {
        return 'intervalValue must be a positive integer';
      }
      if (!['hours', 'days'].includes(intervalUnit)) return 'intervalUnit must be hours or days';
    }
```

with:

```js
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
```

Thread the window fields through the PUT `merged` object (~227-238) by adding two lines inside the object literal, after the `days:` line:

```js
    days: body.days,
    windowStart: body.windowStart,
    windowEnd: body.windowEnd,
    intervalValue: body.intervalValue,
    intervalUnit: body.intervalUnit,
```

Update the exports line (bottom of file) to add `validateScheduleBody`:

```js
module.exports = { router, toCron, fromCron, detectScheduleType, validateScheduleBody };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cron-validate.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/schedules.js test/cron-validate.test.js
git commit -m "feat: validate interval window, minutes set, and day-of-week

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Scheduler next-run computation

**Files:**
- Modify: `src/scheduler/manager.js` (`estimateNextRun` ~13-30; module.exports ~175)
- Test: `test/next-run.test.js`
- Modify: `package.json` (`scripts.test`)

**Interfaces:**
- Consumes: nothing from earlier tasks (independent module).
- Produces:
  - `matchField(field, value, range) -> boolean` where `range = { min, max }`.
  - `nextRunFor(cronExpr, fromSec) -> number` (unix seconds of the next fire ≥ `fromSec`, evaluated in IST).
  - `estimateNextRun(cronExpr) -> number` (thin wrapper: `nextRunFor(cronExpr, now)`), kept for existing callers in this file.

**Background for the implementer:** IST is a fixed +05:30 offset (19800 seconds, no daylight saving). To read the IST wall-clock minute/hour/day-of-month/day-of-week for a given unix time `t`, construct `new Date((t + 19800) * 1000)` and use its `getUTC*()` methods. `fireSchedule` and `init()` already call `estimateNextRun`; keeping that name means no other edits in this file.

- [ ] **Step 1: Write the failing test**

Create `test/next-run.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const cron = require('node-cron');
const { matchField, nextRunFor } = require('../src/scheduler/manager');

const IST = 19800;
// Helper: build a unix-seconds timestamp from IST wall-clock components.
function istTime(y, mo, d, h, mi) {
  return Math.floor(Date.UTC(y, mo, d, h, mi, 0) / 1000) - IST;
}
// Read back IST components for asserting.
function istParts(t) {
  const dt = new Date((t + IST) * 1000);
  return { h: dt.getUTCHours(), mi: dt.getUTCMinutes(), dow: dt.getUTCDay() };
}

test('matchField handles star, number, list, range, step forms', () => {
  assert.ok(matchField('*', 5, { min: 0, max: 59 }));
  assert.ok(matchField('30', 30, { min: 0, max: 59 }));
  assert.ok(!matchField('30', 31, { min: 0, max: 59 }));
  assert.ok(matchField('1,3,5', 3, { min: 0, max: 6 }));
  assert.ok(matchField('9-18', 12, { min: 0, max: 23 }));
  assert.ok(!matchField('9-18', 19, { min: 0, max: 23 }));
  assert.ok(matchField('*/30', 30, { min: 0, max: 59 }));
  assert.ok(!matchField('*/30', 15, { min: 0, max: 59 }));
  assert.ok(matchField('9-18/2', 11, { min: 0, max: 23 }));   // 9,11,13,...
  assert.ok(!matchField('9-18/2', 12, { min: 0, max: 23 }));
  assert.ok(matchField('*/3', 4, { min: 1, max: 31 }));       // day-of-month base=1 -> 1,4,7
});

test('nextRunFor: every 30 min 9-18 weekdays, from Saturday night -> Monday 09:00', () => {
  // 2026-07-11 is a Saturday. 23:00 IST.
  const from = istTime(2026, 6, 11, 23, 0);
  const next = nextRunFor('*/30 9-18 * * 1-5', from);
  const p = istParts(next);
  assert.strictEqual(p.h, 9);
  assert.strictEqual(p.mi, 0);
  assert.strictEqual(p.dow, 1); // Monday
});

test('nextRunFor: mid-window lands on next slot', () => {
  // 2026-07-13 Monday 09:10 IST -> next slot 09:30.
  const from = istTime(2026, 6, 13, 9, 10);
  const next = nextRunFor('*/30 9-18 * * 1-5', from);
  const p = istParts(next);
  assert.strictEqual(p.h, 9);
  assert.strictEqual(p.mi, 30);
});

test('nextRunFor: hourly window 9-18/2 skips night', () => {
  // Monday 19:00 IST -> next is Tuesday 09:00.
  const from = istTime(2026, 6, 13, 19, 0);
  const next = nextRunFor('0 9-18/2 * * *', from);
  const p = istParts(next);
  assert.strictEqual(p.h, 9);
  assert.strictEqual(p.mi, 0);
});

test('node-cron accepts the generated expressions', () => {
  assert.ok(cron.validate('*/30 9-18 * * 1-5'));
  assert.ok(cron.validate('*/15 8-20 * * 1,2,3,4,5'));
  assert.ok(cron.validate('0 9-18/2 * * 1,2,3,4,5'));
  assert.ok(cron.validate('0 */2 * * *'));
  assert.ok(cron.validate('0 0 */3 * *'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/next-run.test.js`
Expected: FAIL — `matchField` and `nextRunFor` are not exported / not defined.

- [ ] **Step 3: Implement the matcher and next-run computer**

In `src/scheduler/manager.js`, replace the `estimateNextRun` function (lines ~13-30) with:

```js
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

// Next unix-seconds timestamp >= fromSec whose IST wall-clock satisfies cronExpr.
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
```

Update the module.exports at the bottom (~175) from:

```js
module.exports = { init, reload };
```

to:

```js
module.exports = { init, reload, matchField, nextRunFor };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/next-run.test.js`
Expected: PASS (all tests, including the node-cron acceptance smoke check).

- [ ] **Step 5: Point the npm test script at node:test**

In `package.json`, change the `test` script from:

```json
    "test": "echo \"Error: no test specified\" && exit 1",
```

to:

```json
    "test": "node --test",
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — all three test files (`cron-encode`, `cron-validate`, `next-run`) green.

- [ ] **Step 7: Commit**

```bash
git add src/scheduler/manager.js test/next-run.test.js package.json
git commit -m "feat: compute true next fire time for windowed interval schedules

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Frontend interval form (window, minutes, day chips)

**Files:**
- Modify: `src/web/app.html` — interval form block (~232-242), `describe` (~547-553), `openComposer` form load (~563-574), `validateComposer` (~624-640), `saveComposer` payload (~659-665), `blankForm` (~835-837).

**Interfaces:**
- Consumes: server endpoints already send/accept `windowStart`, `windowEnd`, and interval `days` after Tasks 1-2. `GET /api/schedules` returns these via `fromCron`.
- Produces: no code other tasks depend on (final UI layer).

**Note:** This task is verified manually in the browser (Alpine markup, no unit harness). Each step shows the exact edit.

- [ ] **Step 1: Extend the form state (`blankForm`)**

In `src/web/app.html`, replace `blankForm` (~835-837):

```js
    function blankForm() {
      return { name: '', body: '', recipientType: 'contact', recipientId: '', scheduleType: 'daily', timeHour: 8, timeMinute: 0, days: [], intervalValue: 1, intervalUnit: 'hours' };
    }
```

with:

```js
    function blankForm() {
      return { name: '', body: '', recipientType: 'contact', recipientId: '', scheduleType: 'daily', timeHour: 8, timeMinute: 0, days: [], intervalValue: 1, intervalUnit: 'hours', windowStart: 9, windowEnd: 18 };
    }
```

- [ ] **Step 2: Load window fields when editing (`openComposer`)**

Replace the `this.form = { ... }` object inside `openComposer` (~563-574) with (adds `windowStart`/`windowEnd`, and defaults `intervalUnit` handling unchanged):

```js
            this.form = {
              name: s.name,
              body: tpl ? tpl.body : '',
              recipientType: s.recipient_type || 'contact',
              recipientId: String(s.recipient_id || ''),
              scheduleType: s.scheduleType || 'daily',
              timeHour: s.timeHour ?? 8,
              timeMinute: s.timeMinute ?? 0,
              days: s.days ? [...s.days] : [],
              intervalValue: s.intervalValue || 1,
              intervalUnit: s.intervalUnit || 'hours',
              windowStart: s.windowStart ?? 9,
              windowEnd: s.windowEnd ?? 18,
            };
```

- [ ] **Step 3: Replace the interval form markup**

Replace the interval `<template>` block (~232-242):

```html
            <!-- interval -->
            <template x-if="form.scheduleType==='interval'">
              <div class="inline-row">
                <span style="color:var(--ink-soft);font-weight:600">Every</span>
                <input class="input" type="number" min="1" step="1" x-model.number="form.intervalValue">
                <select class="input" x-model="form.intervalUnit">
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
              </div>
            </template>
```

with:

```html
            <!-- interval -->
            <template x-if="form.scheduleType==='interval'">
              <div>
                <div class="inline-row">
                  <span style="color:var(--ink-soft);font-weight:600">Every</span>
                  <template x-if="form.intervalUnit==='minutes'">
                    <select class="input" x-model.number="form.intervalValue">
                      <option :value="5">5</option>
                      <option :value="10">10</option>
                      <option :value="15">15</option>
                      <option :value="20">20</option>
                      <option :value="30">30</option>
                    </select>
                  </template>
                  <template x-if="form.intervalUnit!=='minutes'">
                    <input class="input" type="number" min="1" step="1" x-model.number="form.intervalValue">
                  </template>
                  <select class="input" x-model="form.intervalUnit">
                    <option value="minutes">minutes</option>
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                  </select>
                </div>

                <!-- daytime window (minutes/hours only) -->
                <template x-if="form.intervalUnit==='minutes' || form.intervalUnit==='hours'">
                  <div>
                    <div class="inline-row" style="margin-top:.7rem">
                      <span style="color:var(--ink-soft);font-weight:600">between</span>
                      <input class="input" type="number" min="0" max="23" x-model.number="form.windowStart">
                      <span style="color:var(--ink-soft);font-weight:600">and</span>
                      <input class="input" type="number" min="0" max="23" x-model.number="form.windowEnd">
                      <span class="hint" style="margin:0">o'clock</span>
                    </div>
                    <div class="chips" style="margin:.8rem 0 0">
                      <template x-for="(d, idx) in dayNames" :key="idx">
                        <span class="chip" :class="{ on: form.days.includes(idx) }" @click="toggleDay(idx)" x-text="d"></span>
                      </template>
                    </div>
                    <div class="hint" style="margin:.4rem 0 0">No days selected = every day.</div>
                  </div>
                </template>
              </div>
            </template>
```

- [ ] **Step 4: Update client-side validation (`validateComposer`)**

Replace the interval branch inside `validateComposer` (~635-638):

```js
          if (f.scheduleType === 'interval') {
            const v = Number(f.intervalValue);
            if (!Number.isInteger(v) || v < 1) return 'Repeat value must be a whole number.';
          }
```

with:

```js
          if (f.scheduleType === 'interval') {
            const v = Number(f.intervalValue);
            if (f.intervalUnit === 'minutes') {
              if (![5, 10, 15, 20, 30].includes(v)) return 'Minutes must be 5, 10, 15, 20, or 30.';
            } else if (f.intervalUnit === 'hours') {
              if (!Number.isInteger(v) || v < 1 || v > 23) return 'Hours must be between 1 and 23.';
            } else if (!Number.isInteger(v) || v < 1) {
              return 'Repeat value must be a whole number.';
            }
            if (f.intervalUnit === 'minutes' || f.intervalUnit === 'hours') {
              const ws = Number(f.windowStart), we = Number(f.windowEnd);
              if (!Number.isInteger(ws) || ws < 0 || ws > 23) return 'Start hour must be 0-23.';
              if (!Number.isInteger(we) || we < 0 || we > 23) return 'End hour must be 0-23.';
              if (we < ws) return 'End hour must be after start hour.';
            }
          }
```

- [ ] **Step 5: Send window fields in the save payload (`saveComposer`)**

Replace the `payload` object (~659-665):

```js
            const payload = {
              name: this.form.name.trim(), templateId: tplId,
              recipientType: this.form.recipientType, recipientId: Number(this.form.recipientId),
              scheduleType: this.form.scheduleType,
              timeHour: Number(this.form.timeHour), timeMinute: Number(this.form.timeMinute),
              days: this.form.days, intervalValue: Number(this.form.intervalValue), intervalUnit: this.form.intervalUnit,
            };
```

with:

```js
            const payload = {
              name: this.form.name.trim(), templateId: tplId,
              recipientType: this.form.recipientType, recipientId: Number(this.form.recipientId),
              scheduleType: this.form.scheduleType,
              timeHour: Number(this.form.timeHour), timeMinute: Number(this.form.timeMinute),
              days: this.form.days, intervalValue: Number(this.form.intervalValue), intervalUnit: this.form.intervalUnit,
              windowStart: Number(this.form.windowStart), windowEnd: Number(this.form.windowEnd),
            };
```

- [ ] **Step 6: Update the schedule summary text (`describe`)**

Replace the `describe` function (~547-553):

```js
        describe(s) {
          const pad = n => String(n).padStart(2, '0');
          if (s.scheduleType === 'daily') return `every day at ${pad(s.timeHour)}:${pad(s.timeMinute)}`;
          if (s.scheduleType === 'weekly') return `${(s.days||[]).map(d => DAY_NAMES[d]).join(', ')} at ${pad(s.timeHour)}:${pad(s.timeMinute)}`;
          if (s.scheduleType === 'interval') return `every ${s.intervalValue} ${s.intervalUnit}`;
          return '';
        },
```

with:

```js
        describe(s) {
          const pad = n => String(n).padStart(2, '0');
          if (s.scheduleType === 'daily') return `every day at ${pad(s.timeHour)}:${pad(s.timeMinute)}`;
          if (s.scheduleType === 'weekly') return `${(s.days||[]).map(d => DAY_NAMES[d]).join(', ')} at ${pad(s.timeHour)}:${pad(s.timeMinute)}`;
          if (s.scheduleType === 'interval') {
            const unit = s.intervalUnit === 'minutes' ? 'min' : s.intervalUnit;
            let out = `every ${s.intervalValue} ${unit}`;
            if (s.intervalUnit !== 'days') {
              const ws = s.windowStart ?? 0, we = s.windowEnd ?? 23;
              out += (ws === 0 && we === 23) ? ', all day' : `, ${pad(ws)}:00–${pad(we)}:59`;
              if (s.days && s.days.length) out += `, ${s.days.map(d => DAY_NAMES[d]).join(', ')}`;
            }
            return out;
          }
          return '';
        },
```

- [ ] **Step 7: Manual verification in the browser**

Start the server and exercise the UI:

Run: `npm start` then open `http://localhost:3000` (log in, WhatsApp need not be connected for this check).

Verify each:
1. New schedule → pick **Repeat**. Unit shows **minutes / hours / days**.
2. Select **minutes** → value becomes a dropdown (5/10/15/20/30). Window row ("between H and H") and day chips appear.
3. Select **hours** → value is a number input; window row + chips still show.
4. Select **days** → window row and chips hide.
5. Set every 30 min, between 9 and 18, tap Mon–Fri → Save. Reopen the schedule (edit) → values reload exactly (30, minutes, 9, 18, Mon–Fri).
6. The schedule list summary reads like `every 30 min, 09:00–18:59, Mon, Tue, Wed, Thu, Fri`.
7. Set end hour before start hour → Save is blocked with "End hour must be after start hour."
8. Create an hours interval with window 0–23 and no days → summary reads `every 2 hours, all day` (backward-compatible form).

- [ ] **Step 8: Confirm the stored cron via the API**

With the "every 30 min, 9–18, weekdays" schedule saved, confirm the encoding:

Run: `sqlite3 data/db.sqlite "SELECT name, cron_expr FROM schedules ORDER BY id DESC LIMIT 1;"`
Expected: `cron_expr` = `*/30 9-18 * * 1,2,3,4,5`

(If `sqlite3` CLI is not installed, instead verify in the browser that the reopened schedule shows the exact values from step 5 — that round-trips through `fromCron`.)

- [ ] **Step 9: Commit**

```bash
git add src/web/app.html
git commit -m "feat: interval schedule UI — daytime window, minutes unit, day chips

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

**Spec coverage:**
- Cron encoding table → Task 1 (`toCron`) + test cases.
- `fromCron`/`detectScheduleType` with interval-before-weekly → Task 1.
- Validation (minutes set, hours range, window bounds, dow) → Task 2.
- `estimateNextRun` rewrite for windowed forms → Task 3.
- node-cron acceptance of generated expressions → Task 3, Step 1 smoke test.
- Frontend (minutes unit, window row, day chips, summary, form state) → Task 4.
- Backward compat (`0 */2 * * *`, `0 0 */3 * *`, daily/weekly) → Task 1 test cases + Task 3 node-cron smoke + Task 4 step 8.
- Full-day window → `*` → Task 1 case `0 */2 * * *`; Task 4 describe "all day".
- Day-unit ignores window/days → Task 1 (`days` branch), Task 4 (UI hides window).

**Type consistency:** `windowStart`/`windowEnd`/`days`/`intervalUnit`/`intervalValue` names are identical across `toCron`, `fromCron`, `validateScheduleBody`, the PUT merge, and the frontend payload. `matchField(field, value, range)` and `nextRunFor(cronExpr, fromSec)` signatures match between Task 3 implementation and its tests.

**Placeholder scan:** none — every code step contains full code and exact commands.
