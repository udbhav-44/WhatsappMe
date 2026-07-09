'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluateSignup } = require('../src/api/auth');

const fresh = () => ({ count: 0, lockedUntil: 0 });
const NOW = 1_000_000_000_000;

test('disabled when no invite code configured', () => {
  const r = evaluateSignup({ envCode: '', providedCode: 'x', name: 'Dad', pin: '1234', attempts: fresh(), now: NOW });
  assert.strictEqual(r.status, 403);
  assert.ok(!r.ok);
});

test('wrong code rejected and increments attempts', () => {
  const r = evaluateSignup({ envCode: 'secret', providedCode: 'nope', name: 'Dad', pin: '1234', attempts: fresh(), now: NOW });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.attempts.count, 1);
});

test('locks out after 10 wrong attempts', () => {
  let attempts = fresh();
  let r;
  for (let i = 0; i < 10; i++) {
    r = evaluateSignup({ envCode: 'secret', providedCode: 'nope', name: 'Dad', pin: '1234', attempts, now: NOW });
    attempts = r.attempts;
  }
  assert.ok(attempts.lockedUntil > NOW, 'lockedUntil set after 10 failures');
  // further attempts while locked return 429
  const locked = evaluateSignup({ envCode: 'secret', providedCode: 'secret', name: 'Dad', pin: '1234', attempts, now: NOW });
  assert.strictEqual(locked.status, 429);
});

test('lockout expires after the window', () => {
  const attempts = { count: 0, lockedUntil: NOW - 1 };
  const r = evaluateSignup({ envCode: 'secret', providedCode: 'secret', name: 'Dad', pin: '1234', attempts, now: NOW });
  assert.strictEqual(r.status, 201);
  assert.ok(r.ok);
});

test('valid code but missing name rejected', () => {
  const r = evaluateSignup({ envCode: 'secret', providedCode: 'secret', name: '  ', pin: '1234', attempts: fresh(), now: NOW });
  assert.strictEqual(r.status, 400);
});

test('valid code but bad pin rejected', () => {
  const r = evaluateSignup({ envCode: 'secret', providedCode: 'secret', name: 'Dad', pin: '12', attempts: fresh(), now: NOW });
  assert.strictEqual(r.status, 400);
});

test('valid code + name + pin accepted and resets attempts', () => {
  const r = evaluateSignup({ envCode: 'secret', providedCode: 'secret', name: 'Dad', pin: '1234', attempts: { count: 4, lockedUntil: 0 }, now: NOW });
  assert.strictEqual(r.status, 201);
  assert.ok(r.ok);
  assert.strictEqual(r.attempts.count, 0);
});

test('code is trimmed and compared exactly (case-sensitive)', () => {
  assert.strictEqual(evaluateSignup({ envCode: 'secret', providedCode: '  secret  ', name: 'Dad', pin: '1234', attempts: fresh(), now: NOW }).status, 201);
  assert.strictEqual(evaluateSignup({ envCode: 'secret', providedCode: 'SECRET', name: 'Dad', pin: '1234', attempts: fresh(), now: NOW }).status, 401);
});

test('refused until the owner account exists (usersExist=false)', () => {
  const r = evaluateSignup({ envCode: 'secret', providedCode: 'secret', name: 'Dad', pin: '1234', attempts: fresh(), now: NOW, usersExist: false });
  assert.strictEqual(r.status, 409);
});

test('allowed once the owner exists (usersExist=true)', () => {
  const r = evaluateSignup({ envCode: 'secret', providedCode: 'secret', name: 'Dad', pin: '1234', attempts: fresh(), now: NOW, usersExist: true });
  assert.strictEqual(r.status, 201);
});
