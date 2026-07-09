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
