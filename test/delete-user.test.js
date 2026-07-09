'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { canDeleteUser } = require('../src/api/auth');

test('non-admin cannot delete anyone', () => {
  const r = canDeleteUser(2, 3);
  assert.strictEqual(r.status, 403);
  assert.ok(!r.ok);
});

test('admin cannot delete the owner (self / id 1)', () => {
  const r = canDeleteUser(1, 1);
  assert.strictEqual(r.status, 400);
});

test('admin can delete a normal user', () => {
  assert.deepStrictEqual(canDeleteUser(1, 3), { ok: true });
});

test('invalid target id rejected', () => {
  assert.strictEqual(canDeleteUser(1, NaN).status, 400);
  assert.strictEqual(canDeleteUser(1, 0).status, 400);
  assert.strictEqual(canDeleteUser(1, -2).status, 400);
});
