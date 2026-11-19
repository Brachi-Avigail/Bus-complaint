import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

// Must be set before the app (and env.js) is imported. dotenv never overrides existing vars.
const SECRET = 'test-secret-1234567890';
Object.assign(process.env, {
  NODE_ENV: 'test',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_KEY: 'test-key',
  IVR_SECRET: SECRET,
  IVR_ALLOWED_IPS: '',
  IVR_MAX_ATTEMPTS: '0', // no limit
  LOG_FULL_ID: 'false',
  TRUST_PROXY: '',
});

let app;
let logs;

before(async () => {
  ({ default: app } = await import('../src/app.js'));
});

beforeEach(() => {
  logs = [];
  mock.restoreAll();
  mock.method(console, 'log', (msg) => logs.push(String(msg)));
  mock.method(console, 'warn', () => {});
  mock.method(console, 'error', () => {});
});

const call = (params) =>
  request(app).get('/api/ivr').query({ token: SECRET, ApiPhone: '0501234567', ...params });

const ID_OPTIONS = '=ID,no,,5,10,No,yes,no';
const WELCOME_READ =
  'read=t-שלום וברוכים הבאים למערכת תלונות אוטובוסים.t-נא הקש מספר תעודת זהות ולסיום הקש סולמית' +
  ID_OPTIONS;
const RETRY_READ =
  'read=t-מספר תעודת הזהות שהוקש אינו תקין.t-נא נסה שוב.t-נא הקש מספר תעודת זהות ולסיום הקש סולמית' +
  ID_OPTIONS;
const REENTER_READ = 'read=t-הקש שוב תעודת זהות ולסיום הקש סולמית' + ID_OPTIONS;
const confirmRead = (keyed) =>
  `read=t-מספר תעודת הזהות שהוקש הינו.d-${keyed}.t-לאישור הקש אחת.t-לשינוי הקש שתיים=CONFIRM,no,1,1,7,No,yes,yes,,1.2`;
const THANKS = 'id_list_message=t-תודה.t-מספר תעודת הזהות שלך התקבל&go_to_folder=hangup';

const receivedLogs = () =>
  logs.map((l) => JSON.parse(l)).filter((l) => l.event === 'id_received');

test('first request: welcome + read ID', async () => {
  const res = await call({ ApiCallId: 'c1' });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/plain; charset=utf-8/);
  assert.equal(res.text, WELCOME_READ);
});

test('POST form body works too', async () => {
  const res = await request(app)
    .post('/api/ivr')
    .type('form')
    .send({ token: SECRET, ApiCallId: 'c-post' });
  assert.equal(res.status, 200);
  assert.equal(res.text, WELCOME_READ);
});

test('valid ID: plays it back and asks 1 / 2, nothing logged yet', async () => {
  await call({ ApiCallId: 'c2' });
  const res = await call({ ApiCallId: 'c2', ID: '123456782' });
  assert.equal(res.text, confirmRead('123456782'));
  assert.equal(receivedLogs().length, 0);
});

test('confirm with 1: thanks + hangup, masked log', async () => {
  await call({ ApiCallId: 'c2b' });
  await call({ ApiCallId: 'c2b', ID: '123456782' });
  const res = await call({ ApiCallId: 'c2b', ID: '123456782', CONFIRM: '1' });
  assert.equal(res.text, THANKS);

  const [entry] = receivedLogs();
  assert.equal(entry.id, '******782');
  assert.equal(entry.callId, 'c2b');
  assert.equal(entry.phone, '0501234567');
  assert.ok(!logs.join('').includes('123456782'));
});

test('change with 2: asks again, then the new ID is confirmed', async () => {
  await call({ ApiCallId: 'c2c' });
  await call({ ApiCallId: 'c2c', ID: '123456782' });
  assert.equal(
    (await call({ ApiCallId: 'c2c', ID: '123456782', CONFIRM: '2' })).text,
    REENTER_READ
  );

  // Yemot resends the old CONFIRM=2 together with the new ID: must ask to confirm, not loop
  const res = await call({ ApiCallId: 'c2c', ID: '39337423', CONFIRM: '2' });
  assert.equal(res.text, confirmRead('39337423'));

  assert.equal((await call({ ApiCallId: 'c2c', ID: '39337423', CONFIRM: '1' })).text, THANKS);
  assert.equal(receivedLogs()[0].id, '******423');
});

test('duplicate ID params (ID=old&ID=new): the last value is used', async () => {
  await call({ ApiCallId: 'c2e' });
  await call({ ApiCallId: 'c2e', ID: '123456782' });
  await call({ ApiCallId: 'c2e', ID: '123456782', CONFIRM: '2' });
  const res = await request(app).get(
    `/api/ivr?token=${SECRET}&ApiCallId=c2e&ID=123456782&CONFIRM=2&ID=39337423&CONFIRM=1`
  );
  // Stage is "id" (after pressing 2), so the newest ID is validated and played back
  assert.equal(res.text, confirmRead('39337423'));
});

test('unexpected confirm key: asks to confirm again', async () => {
  await call({ ApiCallId: 'c2d' });
  await call({ ApiCallId: 'c2d', ID: '123456782' });
  const res = await call({ ApiCallId: 'c2d', ID: '123456782', CONFIRM: '7' });
  assert.equal(res.text, confirmRead('123456782'));
});

test('invalid ID: retry message + read again', async () => {
  const res = await call({ ApiCallId: 'c3', ID: '123456789' });
  assert.equal(res.text, RETRY_READ);
  assert.ok(!logs.join('').includes('123456789'));
});

test('no attempt limit: keeps asking after many invalid IDs', async () => {
  for (let i = 0; i < 6; i += 1) {
    assert.equal((await call({ ApiCallId: 'c4', ID: '111' })).text, RETRY_READ);
  }
  // A valid ID still works afterwards
  assert.equal((await call({ ApiCallId: 'c4', ID: '123456782' })).text, confirmRead('123456782'));
});

test('hangup=yes: empty answer and counter reset', async () => {
  await call({ ApiCallId: 'c5', ID: '111' });
  await call({ ApiCallId: 'c5', ID: '222' });

  const res = await call({ ApiCallId: 'c5', ID: '222', hangup: 'yes' });
  assert.equal(res.status, 200);
  assert.equal(res.text, '');

  // Counter was cleared: a new wrong ID is attempt 1 again, not the final one
  assert.equal((await call({ ApiCallId: 'c5', ID: '333' })).text, RETRY_READ);
});

test('ApiHangup=yes is accepted as hangup', async () => {
  const res = await call({ ApiCallId: 'c6', ApiHangup: 'yes' });
  assert.equal(res.text, '');
});

test('missing or wrong token: 403', async () => {
  assert.equal((await request(app).get('/api/ivr').query({ ApiCallId: 'x' })).status, 403);
  assert.equal(
    (await request(app).get('/api/ivr').query({ ApiCallId: 'x', token: 'wrong' })).status,
    403
  );
});

test('unexpected error: valid Yemot answer, not 500', async () => {
  // ESM exports cannot be stubbed, so make the service's logger throw
  mock.method(console, 'log', () => {
    throw new Error('boom');
  });
  const res = await call({ ApiCallId: 'c7' });
  assert.equal(res.status, 200);
  assert.equal(res.text, 'id_list_message=t-אירעה שגיאה במערכת.t-נא נסה שוב מאוחר יותר&go_to_folder=hangup');
});

test('existing users routes are untouched (404 JSON for unknown route)', async () => {
  const res = await request(app).get('/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.success, false);
});
