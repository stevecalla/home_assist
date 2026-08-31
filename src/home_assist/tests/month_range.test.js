'use strict';
/**
 * month_range.test.js — calendar periods, which are a different question from rolling windows.
 *
 *   rolling   "the last 30 days"   always the same length, always comparable to itself
 *   calendar  "July"               28-31 days, and what the utility actually bills
 *
 * Worth pinning because every failure here is quiet: a month boundary computed in the wrong zone
 * files late-evening usage into the wrong month, and a part month set beside a whole one reads as a
 * drop in consumption that is nothing but the calendar.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const time = require('../time');
const TZ = 'America/Denver';
const at = (iso) => new Date(iso);

test('this month runs from the 1st to TODAY, not to the end of the month', function () {
  // The days after today have not happened. Drawing them as zero would say this house used no
  // water tomorrow — and on a leak monitor zero is a claim, not an absence.
  const r = time.month_range(at('2026-08-12T18:00:00Z'), 0, TZ);
  assert.strictEqual(r.from, '2026-08-01');
  assert.strictEqual(r.to, '2026-08-12');
  assert.strictEqual(r.partial, true);
  assert.strictEqual(r.label, 'August 2026');
});

test('on the last day of the month, this month is no longer partial', function () {
  const r = time.month_range(at('2026-08-31T18:00:00Z'), 0, TZ);
  assert.strictEqual(r.to, '2026-08-31');
  assert.strictEqual(r.partial, false);
});

test('last month is the WHOLE previous month', function () {
  const r = time.month_range(at('2026-08-12T18:00:00Z'), 1, TZ);
  assert.deepStrictEqual([r.from, r.to, r.partial], ['2026-07-01', '2026-07-31', false]);
  assert.strictEqual(r.days, 31);
});

test('January steps back into December of the previous year', function () {
  const r = time.month_range(at('2026-01-09T18:00:00Z'), 1, TZ);
  assert.strictEqual(r.label, 'December 2025');
  assert.strictEqual(r.from, '2025-12-01');
});

test('February knows about leap years, including the century rule', function () {
  assert.strictEqual(time.days_in_month(2026, 2), 28);
  assert.strictEqual(time.days_in_month(2028, 2), 29);
  assert.strictEqual(time.days_in_month(2000, 2), 29, 'divisible by 400 — a leap year');
  assert.strictEqual(time.days_in_month(2100, 2), 28, 'divisible by 100 but not 400 — not one');
});

test('the month is resolved in the CONFIGURED zone, not the process one', function () {
  // 2026-08-01T03:00Z is still July 31st in Denver. Computed in UTC this would report August and
  // file that evening's usage into the wrong month — the same silent drift the hour buckets guard
  // against, one level up.
  const r = time.month_range(at('2026-08-01T03:00:00Z'), 0, TZ);
  assert.strictEqual(r.label, 'July 2026');
  assert.strictEqual(r.to, '2026-07-31');

  const utc = time.month_range(at('2026-08-01T03:00:00Z'), 0, 'UTC');
  assert.strictEqual(utc.label, 'August 2026', 'and the zone genuinely changes the answer');
});

test('the daily endpoint keeps calendar and rolling ranges distinguishable', function () {
  const api = fs.readFileSync(require.resolve('../modules/water/api'), 'utf8');
  const i = api.indexOf("app.get('/api/water/daily'");
  const seg = api.slice(i, i + 1600);
  assert.match(seg, /period === 'this-month' \|\| period === 'last-month'/);
  assert.match(seg, /daily_series_between/, 'a calendar range needs explicit bounds, not a day count');
  assert.match(seg, /range: range/, 'the resolved bounds ride along so the page can state them');
});

test('a day with no stored row is a GAP, not a zero', function () {
  // A neighbour's month from before their retention window must not render as a month they used no
  // water. Same rule the charts already follow.
  const src = fs.readFileSync(require.resolve('../modules/water/store/readings'), 'utf8');
  const i = src.indexOf('async function daily_series_between');
  const seg = src.slice(i, i + 1400);
  assert.match(seg, /observed: !!hit/);
});

test('the page states the resolved dates and flags a part month', function () {
  const ui = fs.readFileSync(
    require.resolve('../web/src/modules/water/History.jsx'), 'utf8');
  assert.match(ui, /MONTH_RANGES/);
  assert.match(ui, /daily\.range\.from\.slice\(5\)/, 'print the actual dates');
  assert.match(ui, /daily\.range\.partial/);
  assert.match(ui, /Part month/, 'and say so in words, not only with a shorter bar');
});


test('the summary counts recorded days, not calendar days', function () {
  // A month missing three days already has an understated TOTAL. Averaging that over the calendar
  // length would understate it a second time, so the mean is over the days that HAVE data and the
  // gap is reported. Same rule as the charts: a day with no row is not a day of zero usage.
  const api = fs.readFileSync(require.resolve('../modules/water/api'), 'utf8');
  const i = api.indexOf('function summarise');
  assert.ok(i !== -1, 'one summary helper, shared by both endpoints');
  const seg = api.slice(i, i + 1200);
  assert.match(seg, /observed = rows\.filter/);
  assert.match(seg, /observed_days:/);
  assert.match(seg, /missing_days:/);
  assert.match(seg, /complete:/);
  assert.match(seg, /avg = observed\.length/, 'the mean is over recorded days');
});

test('Long view offers the same calendar periods as History', function () {
  // The option existing on one page and not the other reads as a bug in whichever you found second.
  const api = fs.readFileSync(require.resolve('../modules/water/api'), 'utf8');
  const i = api.indexOf("if (mode === 'long')");
  const seg = api.slice(i, i + 900);
  assert.match(seg, /period === 'this-month' \|\| period === 'last-month'/);
  assert.match(seg, /daily_series_between/);

  const ui = fs.readFileSync(require.resolve('../web/src/modules/water/Monitor.jsx'), 'utf8');
  assert.match(ui, /MONTH_CHIPS/);
  assert.match(ui, /setLvPeriod\(null\), setDays\(n\)/, 'a rolling chip must clear the calendar one');
});

test('History states the total and which timezone the days are bucketed in', function () {
  const ui = fs.readFileSync(require.resolve('../web/src/modules/water/History.jsx'), 'utf8');
  assert.match(ui, /daily\.summary\.total/, 'the number, not only the bars');
  assert.match(ui, /gal\/day average/);
  assert.match(ui, /observed_days\} of \{daily\.summary\.days\} days recorded/);
  assert.match(ui, /times are/, 'a day boundary with no stated zone is an unexplained choice');
});
