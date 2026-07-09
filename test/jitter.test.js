'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { intervalSeconds, jitterMaxSeconds, jitterOffset } = require('../src/scheduler/manager');

// Save/restore the env var each test touches.
function withJitter(mins, fn) {
  const prev = process.env.JITTER_MINUTES;
  if (mins === undefined) delete process.env.JITTER_MINUTES;
  else process.env.JITTER_MINUTES = String(mins);
  try { fn(); } finally {
    if (prev === undefined) delete process.env.JITTER_MINUTES;
    else process.env.JITTER_MINUTES = prev;
  }
}

test('intervalSeconds reads each cron form', () => {
  assert.strictEqual(intervalSeconds('*/30 9-18 * * *'), 1800);
  assert.strictEqual(intervalSeconds('*/5 * * * *'), 300);
  assert.strictEqual(intervalSeconds('0 9-18/2 * * *'), 7200);
  assert.strictEqual(intervalSeconds('0 */2 * * *'), 7200);
  assert.strictEqual(intervalSeconds('0 0 */3 * *'), 259200);
  assert.strictEqual(intervalSeconds('30 8 * * *'), 86400);       // daily
  assert.strictEqual(intervalSeconds('0 9 * * 1,3'), 86400);      // weekly
});

test('jitterMaxSeconds is 0 when JITTER_MINUTES unset', () => {
  withJitter(undefined, () => {
    assert.strictEqual(jitterMaxSeconds('30 8 * * *'), 0);
  });
});

test('jitterMaxSeconds is 0 for invalid or non-positive values', () => {
  withJitter('abc', () => assert.strictEqual(jitterMaxSeconds('30 8 * * *'), 0));
  withJitter('0', () => assert.strictEqual(jitterMaxSeconds('30 8 * * *'), 0));
  withJitter('-5', () => assert.strictEqual(jitterMaxSeconds('30 8 * * *'), 0));
});

test('jitterMaxSeconds = T*60 for daily/weekly (no interval cap)', () => {
  withJitter('3', () => assert.strictEqual(jitterMaxSeconds('30 8 * * *'), 180));
  withJitter('10', () => assert.strictEqual(jitterMaxSeconds('0 9 * * 1,3'), 600));
});

test('jitterMaxSeconds capped to under half the interval for short intervals', () => {
  // 5-min interval = 300s -> cap floor(150)-30 = 120 -> min(180,120) = 120
  withJitter('3', () => assert.strictEqual(jitterMaxSeconds('*/5 * * * *'), 120));
  // 30-min interval = 1800s -> cap 870 -> min(180,870) = 180
  withJitter('3', () => assert.strictEqual(jitterMaxSeconds('*/30 9-18 * * *'), 180));
  // 2-hour interval -> cap large -> 180
  withJitter('3', () => assert.strictEqual(jitterMaxSeconds('0 */2 * * *'), 180));
});

test('jitterOffset is 0 when disabled', () => {
  withJitter(undefined, () => {
    for (let i = 0; i < 50; i++) assert.strictEqual(jitterOffset('30 8 * * *'), 0);
  });
});

test('jitterOffset stays within [-J, +J] and varies in sign', () => {
  withJitter('3', () => {
    let sawNeg = false, sawPos = false;
    for (let i = 0; i < 2000; i++) {
      const o = jitterOffset('30 8 * * *');
      assert.ok(o >= -180 && o <= 180, `offset ${o} out of bounds`);
      if (o < 0) sawNeg = true;
      if (o > 0) sawPos = true;
    }
    assert.ok(sawNeg, 'expected some negative offsets');
    assert.ok(sawPos, 'expected some positive offsets');
  });
});
