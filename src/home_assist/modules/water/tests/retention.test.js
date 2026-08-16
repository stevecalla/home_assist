'use strict';

const test = require('node:test');
const assert = require('node:assert');

const settings = require('../store/settings');
const readings = require('../store/readings');

test('0 means forever, but a positive hourly retention has a floor', function () {
  // `min` alone cannot express this: min:7 would forbid 0 (= forever), and min:0 would allow 1 --
  // and one day of hourly buckets starves check_continuous, which needs six consecutive hours.
  const d = settings.DEFS.hourly_retention_days;
  assert.equal(d.def, 0, 'forever is the default; the rollup is ~1 MB per meter per year');
  assert.equal(d.min, 0);
  assert.equal(d.min_nonzero, 7);

  assert.equal(settings.clamp(d, 0), 0, '0 must survive as "forever"');
  assert.equal(settings.clamp(d, 1), 7, 'a value that would starve the rules is raised to the floor');
  assert.equal(settings.clamp(d, 6), 7);
  assert.equal(settings.clamp(d, 30), 30, 'anything above the floor is honoured');
});

test('observed retention defaults to 45 days and is adjustable', function () {
  const d = settings.DEFS.observed_retention_days;
  assert.equal(d.def, 45);
  assert.equal(d.min, 1);
  assert.ok(d.max >= 365, 'adjustable well beyond the default');
  assert.equal(settings.clamp(d, 90), 90);
  assert.equal(settings.clamp(d, 0), 1, 'zero would mean "delete other meters instantly"');
});

test('the hourly prune refuses a value that would disarm a leak rule', async function () {
  // Enforced at the point of USE, not only on save -- a row edited straight into water_settings by
  // hand must not be able to quietly stop the monitor detecting continuous flow. Returns 0 before
  // touching the database, which is why this test needs no MySQL.
  assert.equal(readings.HOURLY_MIN_DAYS, 7);
  assert.equal(await readings.prune_hourly(0), 0, '0 = forever, nothing removed');
  assert.equal(await readings.prune_hourly(3), 0, 'below the floor is treated as off, not honoured');
  assert.equal(await readings.prune_hourly(-5), 0);
});

test('the observed ceiling is a no-op without an owned meter id', async function () {
  // The dangerous shape: if `owned` were missing, a WHERE meter_id <> NULL matches nothing in SQL --
  // but relying on that is relying on a subtlety. Guard explicitly, because the blast radius of
  // getting it wrong is deleting the history this app exists to keep.
  assert.equal(await readings.prune_observed(45, 0), 0);
  assert.equal(await readings.prune_observed(45, null), 0);
  assert.equal(await readings.prune_observed(45, undefined), 0);
  assert.equal(await readings.prune_observed(0, 16642655), 0, '0 days = ceiling disabled');
});

test('every retention setting is in the Retention or Data group', function () {
  // So they appear together on the Settings page rather than scattered. Retention that is hard to
  // find is retention nobody sets.
  const names = Object.keys(settings.DEFS).filter((n) => /retention|_keep$/.test(n));
  assert.ok(names.length >= 6, 'expected the full retention family, got ' + names.join(', '));
  for (const n of names) {
    const g = settings.DEFS[n].group;
    assert.ok(g === 'Retention' || g === 'Data', n + ' is in group "' + g + '"');
  }
});
