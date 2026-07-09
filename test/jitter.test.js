'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { intervalSeconds, jitterMaxSeconds, jitterOffset, nextIntendedRun } = require('../src/scheduler/manager');

const IST = 19800;
const istTime = (y, mo, d, h, mi) => Math.floor(Date.UTC(y, mo, d, h, mi, 0) / 1000) - IST;
const istHour = (t) => new Date((t + IST) * 1000).getUTCHours();
const istDate = (t) => new Date((t + IST) * 1000).getUTCDate();

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

test('nextIntendedRun: no lastRun returns the next occurrence', () => {
  withJitter('3', () => {
    const from = istTime(2026, 6, 13, 5, 0);           // 05:00, before daily 08:00
    const T = nextIntendedRun('0 8 * * *', from, null);
    assert.strictEqual(istHour(T), 8);
    assert.strictEqual(istDate(T), 13);
  });
});

test('nextIntendedRun: skips a slot already fired early (prevents double-send)', () => {
  withJitter('3', () => {
    const slot = istTime(2026, 6, 13, 8, 0);           // today 08:00
    const firedEarly = slot - 120;                     // fired at 07:58 (−2 min jitter)
    const from = firedEarly + 60;                       // reload/restart at 07:59, before 08:00
    const T = nextIntendedRun('0 8 * * *', from, firedEarly);
    // must advance to TOMORROW 08:00, not re-select today's already-fired 08:00
    assert.strictEqual(istHour(T), 8);
    assert.strictEqual(istDate(T), 14);
  });
});

test('nextIntendedRun: does not skip when lastRun is an old fire', () => {
  withJitter('3', () => {
    const from = istTime(2026, 6, 13, 5, 0);           // 05:00 today
    const yesterday8 = istTime(2026, 6, 12, 8, 0);     // fired yesterday 08:00
    const T = nextIntendedRun('0 8 * * *', from, yesterday8);
    assert.strictEqual(istHour(T), 8);
    assert.strictEqual(istDate(T), 13);                // today 08:00, not skipped
  });
});

test('nextIntendedRun: no skip when jitter disabled (J=0)', () => {
  withJitter(undefined, () => {
    const slot = istTime(2026, 6, 13, 8, 0);
    const from = istTime(2026, 6, 13, 5, 0);
    // lastRun exactly at slot but J=0 window is zero-width; still must not skip a future slot
    const T = nextIntendedRun('0 8 * * *', from, istTime(2026, 6, 12, 8, 0));
    assert.strictEqual(istDate(T), 13);
  });
});
