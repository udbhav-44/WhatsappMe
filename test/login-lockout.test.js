'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loginOutcome } = require('../src/api/auth');

const NOW = 1_000_000_000_000;
const LOCK = 30 * 60 * 1000;

test('locked account is rejected before checking the PIN', () => {
  const r = loginOutcome({ lockedUntil: NOW + 60000, failedAttempts: 5, pinMatches: true, now: NOW });
  assert.strictEqual(r.status, 429);
  assert.ok(!r.ok);
});

test('correct PIN succeeds and resets counters', () => {
  const r = loginOutcome({ lockedUntil: 0, failedAttempts: 3, pinMatches: true, now: NOW });
  assert.strictEqual(r.status, 200);
  assert.ok(r.ok);
  assert.strictEqual(r.failedAttempts, 0);
  assert.strictEqual(r.lockedUntil, 0);
});

test('wrong PIN below threshold increments the counter', () => {
  const r = loginOutcome({ lockedUntil: 0, failedAttempts: 2, pinMatches: false, now: NOW });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.failedAttempts, 3);
  assert.strictEqual(r.lockedUntil, 0);
});

test('5th wrong PIN locks the account and resets the counter', () => {
  const r = loginOutcome({ lockedUntil: 0, failedAttempts: 4, pinMatches: false, now: NOW });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.failedAttempts, 0);
  assert.strictEqual(r.lockedUntil, NOW + LOCK);
});

test('an expired lock does not block (treated as unlocked)', () => {
  const r = loginOutcome({ lockedUntil: NOW - 1, failedAttempts: 0, pinMatches: false, now: NOW });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.failedAttempts, 1);
});

test('custom maxAttempts / lockoutMs honored', () => {
  const r = loginOutcome({ lockedUntil: 0, failedAttempts: 2, pinMatches: false, now: NOW, maxAttempts: 3, lockoutMs: 1000 });
  assert.strictEqual(r.lockedUntil, NOW + 1000);
});
