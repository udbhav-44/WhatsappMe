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
