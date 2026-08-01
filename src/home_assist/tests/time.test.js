'use strict';
/**
 * time.test.js — the timestamp layer.
 *
 * Worth testing on its own because every leak rule keys off local-time hour buckets, and the whole
 * app moves between a Windows laptop and an Ubuntu box. If hour keys drift, the overnight window
 * silently shifts and the monitor quietly stops working.
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.WATER_TZ = 'America/Denver';
const time = require('../time');

test('hour keys are local, not UTC', function () {
  // 2026-08-01T03:30Z is 2026-07-31 21:30 in Denver (MDT, UTC-6) — a different DAY.
  const d = new Date('2026-08-01T03:30:00Z');
  assert.strictEqual(time.hour_key(d), '2026-07-31T21');
  assert.strictEqual(time.day_key(d), '2026-07-31');
  assert.strictEqual(time.local_hour(d), 21);
});

test('hour keys sort lexicographically (the range queries depend on it)', function () {
  const keys = ['2026-08-01T09', '2026-07-31T23', '2026-08-01T10', '2026-08-01T02'];
  assert.deepStrictEqual(keys.slice().sort(), ['2026-07-31T23', '2026-08-01T02', '2026-08-01T09', '2026-08-01T10']);
});

test('hour_key_offset walks backwards across a day boundary', function () {
  const d = new Date('2026-08-01T08:00:00Z');   // 02:00 Denver
  assert.strictEqual(time.hour_key(d), '2026-08-01T02');
  assert.strictEqual(time.hour_key_offset(d, 3), '2026-07-31T23');
});

test('recent_hour_keys returns N keys ending with the current hour', function () {
  const d = new Date('2026-08-01T14:20:00Z');   // 08:20 Denver
  const keys = time.recent_hour_keys(d, 4);
  assert.deepStrictEqual(keys, ['2026-08-01T05', '2026-08-01T06', '2026-08-01T07', '2026-08-01T08']);
});

test('utc and local stamps are both produced, and differ by the offset', function () {
  const d = new Date('2026-08-01T14:00:00Z');
  const s = time.stamps(d);
  assert.strictEqual(s.utc, '2026-08-01 14:00:00');
  assert.strictEqual(s.local, '2026-08-01 08:00:00');   // MDT = UTC-6
});

test('standard time (winter) uses the right offset too', function () {
  const d = new Date('2026-01-15T14:00:00Z');           // MST = UTC-7
  assert.strictEqual(time.sql_local(d), '2026-01-15 07:00:00');
});

test('hour_start_sql turns an hour key into a DATETIME', function () {
  assert.strictEqual(time.hour_start_sql('2026-08-01T02'), '2026-08-01 02:00:00');
});

test('day_key_offset walks back whole days', function () {
  const d = new Date('2026-08-01T14:00:00Z');
  assert.strictEqual(time.day_key_offset(d, 0), '2026-08-01');
  assert.strictEqual(time.day_key_offset(d, 1), '2026-07-31');
  assert.strictEqual(time.day_key_offset(d, 31), '2026-07-01');
});

test('a different zone gives different keys from the same instant', function () {
  const d = new Date('2026-08-01T03:30:00Z');
  assert.strictEqual(time.hour_key(d, 'UTC'), '2026-08-01T03');
  assert.strictEqual(time.hour_key(d, 'America/Denver'), '2026-07-31T21');
});

test('midnight renders as hour 00, never 24', function () {
  const d = new Date('2026-08-01T06:15:00Z');   // 00:15 Denver
  assert.strictEqual(time.hour_key(d), '2026-08-01T00');
  assert.strictEqual(time.local_hour(d), 0);
});
