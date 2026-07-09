'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizePairPhone } = require('../src/whatsapp/manager');

test('strips non-digits and keeps international number', () => {
  assert.strictEqual(normalizePairPhone('+91 98765 43210'), '919876543210');
  assert.strictEqual(normalizePairPhone('91-98765-43210'), '919876543210');
});

test('rejects too-short and too-long numbers', () => {
  assert.strictEqual(normalizePairPhone('12345'), null);        // 5 digits
  assert.strictEqual(normalizePairPhone('1234567890123456'), null); // 16 digits
});

test('rejects empty / junk', () => {
  assert.strictEqual(normalizePairPhone(''), null);
  assert.strictEqual(normalizePairPhone(null), null);
  assert.strictEqual(normalizePairPhone('abcd'), null);
});

test('accepts a plain 10-15 digit number', () => {
  assert.strictEqual(normalizePairPhone('919876543210'), '919876543210');
});
