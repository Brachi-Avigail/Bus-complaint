import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateIsraeliId, isValidIsraeliId, maskId } from '../src/services/idValidator.js';

test('valid 9-digit ID', () => {
  assert.deepEqual(validateIsraeliId('123456782'), { valid: true, id: '123456782' });
});

test('wrong check digit', () => {
  assert.deepEqual(validateIsraeliId('123456789'), { valid: false, reason: 'bad_check_digit' });
});

test('wrong length', () => {
  assert.equal(validateIsraeliId('1234').reason, 'bad_length'); // < 5 digits
  assert.equal(validateIsraeliId('1234567820').reason, 'bad_length'); // 10 digits
  assert.equal(validateIsraeliId('').reason, 'not_digits');
});

test('all zeros', () => {
  assert.equal(validateIsraeliId('000000000').reason, 'all_zeros');
  assert.equal(validateIsraeliId('00000').reason, 'all_zeros');
});

test('non-numeric characters', () => {
  for (const value of ['12345678a', '12345-678', '1234 5678', '*12345678', undefined, null]) {
    assert.equal(validateIsraeliId(value).valid, false, String(value));
  }
});

test('pads short IDs with leading zeros', () => {
  assert.deepEqual(validateIsraeliId('39337423'), { valid: true, id: '039337423' });
  assert.deepEqual(validateIsraeliId('00018'), { valid: true, id: '000000018' });
  assert.equal(isValidIsraeliId('039337423'), true);
});

test('trims surrounding whitespace', () => {
  assert.equal(isValidIsraeliId(' 123456782 '), true);
});

test('maskId keeps only the last 3 digits', () => {
  assert.equal(maskId('123456782'), '******782');
  assert.equal(maskId('12'), '**');
});
