'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { hit } = require('../src/api/rate-limit');

const T0 = 1_000_000_000_000;

test('allows up to max within the window, blocks beyond', () => {
  const store = {};
  for (let i = 1; i <= 5; i++) {
    assert.strictEqual(hit(store, 'ip1', 5, 60000, T0).allowed, true, `hit ${i}`);
  }
  assert.strictEqual(hit(store, 'ip1', 5, 60000, T0).allowed, false); // 6th blocked
});

test('resets after the window elapses', () => {
  const store = {};
  for (let i = 0; i < 5; i++) hit(store, 'ip1', 5, 60000, T0);
  assert.strictEqual(hit(store, 'ip1', 5, 60000, T0).allowed, false);
  // window passed
  assert.strictEqual(hit(store, 'ip1', 5, 60000, T0 + 60001).allowed, true);
});

test('separate keys are independent', () => {
  const store = {};
  for (let i = 0; i < 5; i++) hit(store, 'ip1', 5, 60000, T0);
  assert.strictEqual(hit(store, 'ip1', 5, 60000, T0).allowed, false);
  assert.strictEqual(hit(store, 'ip2', 5, 60000, T0).allowed, true);
});

test('retryAfter is the remaining window', () => {
  const store = {};
  for (let i = 0; i < 6; i++) hit(store, 'ip1', 5, 60000, T0 + 10000);
  const r = hit(store, 'ip1', 5, 60000, T0 + 20000);
  assert.ok(!r.allowed);
  assert.ok(r.retryAfter > 0 && r.retryAfter <= 60000);
});
