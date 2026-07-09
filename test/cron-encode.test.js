'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { toCron, fromCron, detectScheduleType } = require('../src/api/schedules');

const cases = [
  { in: { scheduleType:'interval', intervalUnit:'minutes', intervalValue:30, windowStart:9, windowEnd:18, days:[] }, cron: '*/30 9-18 * * *' },
  { in: { scheduleType:'interval', intervalUnit:'minutes', intervalValue:15, windowStart:8, windowEnd:20, days:[1,2,3,4,5] }, cron: '*/15 8-20 * * 1,2,3,4,5' },
  { in: { scheduleType:'interval', intervalUnit:'hours', intervalValue:2, windowStart:9, windowEnd:18, days:[1,2,3,4,5] }, cron: '0 9-18/2 * * 1,2,3,4,5' },
  { in: { scheduleType:'interval', intervalUnit:'hours', intervalValue:2, windowStart:0, windowEnd:23, days:[] }, cron: '0 */2 * * *' },
  { in: { scheduleType:'interval', intervalUnit:'hours', intervalValue:2, windowStart:9, windowEnd:9, days:[] }, cron: '0 9-9/2 * * *' },
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
