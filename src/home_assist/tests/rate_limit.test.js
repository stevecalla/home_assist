'use strict';
/**
 * rate_limit.test.js — the guard that stops diagnostics from filling the disk.
 *
 * The scenario worth pinning: the radio starts producing continuous garbage. Every rejected packet
 * used to write a ~4KB row to water_raw_samples, so at one packet every 3 seconds that is ~28,000
 * rows and ~100 MB per day — the diagnostics for the failure taking the machine down before the
 * failure does.
 */
const test = require('node:test');
const assert = require('node:assert');

const { create_limiter } = require('../rate_limit');

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-08-01T12:00:00Z').getTime();

test('allows up to the cap within a window', function () {
  const l = create_limiter(3, HOUR);
  assert.strictEqual(l.check(T0).allowed, true);
  assert.strictEqual(l.check(T0 + 1000).allowed, true);
  assert.strictEqual(l.check(T0 + 2000).allowed, true);
  assert.strictEqual(l.check(T0 + 3000).allowed, false);
});

test('a flood is bounded no matter how long it lasts', function () {
  const l = create_limiter(10, HOUR);
  let allowed = 0;
  // one packet every 3 seconds for an hour — the real worst case
  for (let t = 0; t < HOUR; t += 3000) if (l.check(T0 + t).allowed) allowed++;
  assert.strictEqual(allowed, 10, 'an hour of continuous garbage must cost 10 rows, not 1200');
});

test('the window resets and the next hour gets a fresh budget', function () {
  const l = create_limiter(2, HOUR);
  l.check(T0); l.check(T0 + 1); l.check(T0 + 2);          // 2 allowed, 1 dropped
  assert.strictEqual(l.check(T0 + HOUR + 1).allowed, true);
});

test('the count of suppressed events is reported once, on the next window', function () {
  const l = create_limiter(1, HOUR);
  l.check(T0);                                             // allowed
  for (let i = 0; i < 500; i++) l.check(T0 + i + 1);        // all dropped
  const next = l.check(T0 + HOUR + 1);
  assert.strictEqual(next.allowed, true);
  assert.strictEqual(next.dropped_since, 500, 'so the log can say "+500 more suppressed"');
  // ...and not repeated on the following call
  assert.strictEqual(l.check(T0 + HOUR + 2).dropped_since, 0);
});

test('an occasional bad packet is never suppressed', function () {
  // The normal case: one corrupt packet every few hours. All should be logged — the limiter must
  // not cost us the diagnostics it exists to preserve.
  const l = create_limiter(10, HOUR);
  for (let h = 0; h < 24; h++) {
    assert.strictEqual(l.check(T0 + h * HOUR).allowed, true, 'hour ' + h + ' should log');
  }
});

test('accepts a Date as well as a timestamp', function () {
  const l = create_limiter(1, HOUR);
  assert.strictEqual(l.check(new Date(T0)).allowed, true);
  assert.strictEqual(l.check(new Date(T0 + 5)).allowed, false);
});
