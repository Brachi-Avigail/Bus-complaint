import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ttsParts,
  messageParts,
  digits,
  readDigits,
  messageAndHangup,
  emptyResponse,
} from '../src/utils/yemotResponse.js';

test('ttsParts joins sentences with "." and strips separators', () => {
  assert.equal(ttsParts(['שלום', 'נא הקש']), 't-שלום.t-נא הקש');
  assert.equal(ttsParts('א.ב-ג=ד&ה'), 't-א ב ג ד ה');
  assert.equal(ttsParts(['', 'x']), 't-x');
});

test('readDigits builds the read command', () => {
  const cmd = readDigits({
    prompt: ['שלום', 'נא הקש'],
    varName: 'ID',
    maxDigits: 9,
    minDigits: 5,
    timeoutSec: 10,
  });
  assert.equal(cmd, 'read=t-שלום.t-נא הקש=ID,no,9,5,10,No,yes,no');
});

test('readDigits rejects unsafe variable names', () => {
  assert.throws(() => readDigits({ prompt: ['x'], varName: 'a=b' }));
});

test('digits() parts are played digit by digit', () => {
  assert.equal(messageParts(['הקשת', digits('039337423'), 'סוף']), 't-הקשת.d-039337423.t-סוף');
  assert.throws(() => digits('12a'));
});

test('readDigits with allowed digits', () => {
  const cmd = readDigits({
    prompt: ['אישור'],
    varName: 'CONFIRM',
    maxDigits: 1,
    minDigits: 1,
    blockZero: true,
    allowedDigits: ['1', '2'],
  });
  assert.equal(cmd, 'read=t-אישור=CONFIRM,no,1,1,7,No,yes,yes,,1.2');
});

test('messageAndHangup plays a message then hangs up', () => {
  assert.equal(messageAndHangup(['תודה']), 'id_list_message=t-תודה&go_to_folder=hangup');
});

test('emptyResponse is an empty string', () => {
  assert.equal(emptyResponse(), '');
});
