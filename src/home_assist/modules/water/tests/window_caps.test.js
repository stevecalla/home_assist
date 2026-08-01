'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

/**
 * The heartbeat window has a ceiling in TWO places, and they have to agree:
 *
 *   api.js       HEARTBEAT_MAX_HOURS — what the endpoint accepts, and what the chip row advertises
 *   readings.js  the LIMIT inside reception_series(minutes)
 *
 * They disagreed once. The store capped at 1440 minutes while the API accepted 72 hours, so asking
 * for 72h returned 24h — and nothing failed. The chip said 72h, the axis drew a day of clock labels
 * with no weekday on them, and the picture was simply wrong about how far back it looked. A silent
 * truncation is the worst kind of bug on a chart: it produces a confident answer to a question you
 * did not ask.
 *
 * Source-level rather than behavioural because the alternative needs MySQL, and these tests must
 * stay runnable before a deploy with nothing but Node.
 */
test('the reception window cap matches the API ceiling', function () {
  const api = fs.readFileSync(require.resolve('../api'), 'utf8');
  const store = fs.readFileSync(require.resolve('../store/readings'), 'utf8');

  const m = api.match(/HEARTBEAT_MAX_HOURS\s*=\s*(\d+)/);
  assert.ok(m, 'api.js must declare HEARTBEAT_MAX_HOURS');
  const max_hours = Number(m[1]);

  const fn = store.match(/async function reception_series[\s\S]*?\n}/);
  assert.ok(fn, 'readings.js must define reception_series');
  const cap = fn[0].match(/Math\.min\(Number\(minutes\)\s*\|\|\s*\d+,\s*(\d+)\)/);
  assert.ok(cap, 'reception_series must cap its window');

  assert.strictEqual(
    Number(cap[1]), max_hours * 60,
    'reception_series caps at ' + cap[1] + ' minutes but the API allows ' + max_hours +
    ' hours (' + max_hours * 60 + ' minutes) — a 72h request would silently return less'
  );
});

test('the collector prunes every table that grows on a timer', function () {
  // water_reception writes a row EVERY MINUTE whether or not water moves — that is what lets it
  // prove the radio is alive during a flat line, and it is also the only table that would grow
  // without bound on its own. If the sweep ever stops calling prune_reception, the table becomes
  // half a million rows a year on a box whose whole job is to sit in a basement unattended.
  const run = fs.readFileSync(require.resolve('../collector/run'), 'utf8');
  const sweep = run.match(/async function sweep\([\s\S]*?\n  }/);
  assert.ok(sweep, 'run.js must have a retention sweep');
  ['prune_raw', 'prune_readings', 'prune_alerts', 'prune_reception'].forEach(function (fn) {
    assert.match(sweep[0], new RegExp('readings\\.' + fn + '\\('), 'sweep must call ' + fn);
  });
});

/**
 * Every timestamp the UI renders must be LOCAL.
 *
 * The dual-timestamp convention (`*_utc` + `*_mtn`, both stamped in Node) exists so the UI never has
 * to convert anything: it renders the `_mtn` column and is correct by construction, on any machine,
 * from any timezone. The convention only holds if every endpoint actually SELECTs the local column —
 * and `/api/water/raw` did not. The Diagnostics table then showed raw decoder lines under a "Seen
 * (UTC)" heading: honestly labelled, and the one table in the app on a different clock from the
 * heartbeat directly above it.
 *
 * This checks the seam rather than the rendering, because the seam is where it broke: a SELECT that
 * pulls a `_utc` column without its `_mtn` twin leaves the UI nothing local to display.
 */
test('every endpoint that selects a timestamp also selects its local twin', function () {
  const src = fs.readFileSync(require.resolve('../api'), 'utf8');

  // Only the route handlers. The `sql` blocks shown in the "Data source & SQL" panels are display
  // text meant to be pasted into Workbench, where UTC is the right thing to hand someone.
  const routes = src.slice(0, src.indexOf('function heartbeat_sql'));
  const selects = routes.match(/'SELECT [\s\S]*?FROM [a-z_]+/g) || [];

  selects.forEach(function (q) {
    const utc = (q.match(/\b(\w+)_utc\b/g) || []).map(function (c) { return c.replace(/_utc$/, ''); });
    utc.forEach(function (base) {
      // last_read_at_utc / last_heartbeat_utc are instants sent to the browser as ISO strings and
      // formatted there with Intl + the meter's zone — a genuinely different mechanism, not a leak.
      if (base === 'last_read_at' || base === 'last_heartbeat' || base === 'started_at') return;
      if (base === 'minute' || base === 'heard_at') return;   // returned as ISO for chart maths
      assert.ok(
        q.indexOf(base + '_mtn') !== -1,
        'a query selects ' + base + '_utc without ' + base + '_mtn — the UI would have nothing ' +
        'local to render:\n' + q.slice(0, 160)
      );
    });
  });
});

test('the Diagnostics raw-sample table renders the local stamp', function () {
  const ui = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/Diagnostics.jsx'), 'utf8');
  assert.match(ui, /seen_at_mtn/, 'the raw table must render seen_at_mtn');
  assert.ok(ui.indexOf('Seen (UTC)') === -1, 'the raw table header must not advertise UTC');
});
