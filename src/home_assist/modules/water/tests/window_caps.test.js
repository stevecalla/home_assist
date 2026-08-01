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
