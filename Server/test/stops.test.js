import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

// Must be set before the app (and env.js) is imported. dotenv never overrides existing vars.
Object.assign(process.env, {
  NODE_ENV: 'test',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_KEY: 'test-key',
});

let app;
let supabase;
let getStopNameByCode;

before(async () => {
  ({ default: app } = await import('../src/app.js'));
  ({ supabase } = await import('../src/config/supabase.js'));
  ({ getStopNameByCode } = await import('../src/services/stops.service.js'));
});

// Fake for supabase.from(table).select(cols).eq(col, val).limit(n).maybeSingle()
let calls;
const mockQuery = (result) => {
  mock.method(supabase, 'from', (table) => {
    calls.push(['from', table]);
    const builder = {
      select: (cols) => (calls.push(['select', cols]), builder),
      eq: (col, val) => (calls.push(['eq', col, val]), builder),
      limit: (n) => (calls.push(['limit', n]), builder),
      maybeSingle: async () => result,
    };
    return builder;
  });
};

beforeEach(() => {
  calls = [];
  mock.restoreAll();
  mock.method(console, 'error', () => {});
});

test('service: returns the stop name for an existing code', async () => {
  mockQuery({ data: { stop_name: 'מחלף חמד' }, error: null });
  assert.equal(await getStopNameByCode(638), 'מחלף חמד');
  assert.deepEqual(calls, [
    ['from', 'gtfs_stops'],
    ['select', 'stop_name'],
    ['eq', 'stop_code', 638],
    ['limit', 1],
  ]);
});

test('service: unknown code throws 404', async () => {
  mockQuery({ data: null, error: null });
  await assert.rejects(getStopNameByCode(99999), { statusCode: 404, message: 'Stop not found' });
});

test('service: database error throws 500', async () => {
  mockQuery({ data: null, error: { message: 'boom' } });
  await assert.rejects(getStopNameByCode(638), { statusCode: 500 });
});

test('GET /api/stops/:code returns 200 with the name', async () => {
  mockQuery({ data: { stop_name: 'מחלף חמד' }, error: null });
  const res = await request(app).get('/api/stops/638');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true, data: { stop_code: 638, stop_name: 'מחלף חמד' } });
});

test('GET /api/stops/:code returns 404 for an unknown stop', async () => {
  mockQuery({ data: null, error: null });
  const res = await request(app).get('/api/stops/99999');
  assert.equal(res.status, 404);
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, 'Stop not found');
});

for (const bad of ['abc', '0', '00000', '123456', '12a', '-5']) {
  test(`GET /api/stops/${bad} returns 400`, async () => {
    mockQuery({ data: { stop_name: 'should not be called' }, error: null });
    const res = await request(app).get(`/api/stops/${bad}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'Validation failed');
    assert.equal(calls.length, 0);
  });
}
