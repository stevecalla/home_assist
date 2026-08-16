'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const meters = require('../store/meters');

test('the registry exists as a table, not as a query over packets', function () {
  // Why it matters: water_packets is pruned within a day by design, so any list derived from it
  // loses a meter that went quiet overnight. A selector whose options come and go reads as a bug in
  // the app rather than as reception.
  const schema = fs.readFileSync(require.resolve('../../../store/schema'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS water_meters/);
  assert.match(schema, /gallons_per_unit/, 'the per-meter scale must live with the meter');
  assert.match(schema, /owned\s+TINYINT/, 'owned decides which meter the leak rules run for');
});

test('first_heard is never updated, only last_heard', function () {
  // A meter heard ten thousand times was still first heard once, and that is the only question the
  // column answers. Same reasoning as created_at_* in water_settings.
  const src = fs.readFileSync(require.resolve('../store/meters'), 'utf8');
  const dup = src.slice(src.indexOf('ON DUPLICATE KEY UPDATE'), src.indexOf('params\n'));
  assert.ok(dup.indexOf('first_heard') === -1, 'first_heard must not be in the UPDATE clause');
  assert.match(dup, /last_heard_utc = VALUES/);
  assert.match(dup, /packets_seen = packets_seen \+ VALUES/, 'the lifetime count accumulates');
});

test('registering a meter never breaks ingest', async function () {
  // The registry is bookkeeping running inside the packet flush, on the process that must never
  // fall behind the radio. It returns 0 rather than throwing, including with no database at all --
  // which is why this test needs no MySQL.
  assert.equal(await meters.record_heard([], 16642655), 0);
  assert.equal(await meters.record_heard(null, 16642655), 0);
  assert.equal(await meters.record_heard([{ meter_id: 0 }], 16642655), 0, 'a junk id is skipped');
  assert.equal(await meters.record_heard([{ meter_id: -1 }], 16642655), 0);
});

test('the meter selector is a display filter, and says so', function () {
  // The dangerous misreading: that picking "All meters" starts STORING neighbours, or that picking
  // one meter stops capture. Capture is packets_capture_all_meters in Settings; this control only
  // changes what is drawn.
  //
  // The markup lives in MeterPicker so Monitor, History and Diagnostics cannot drift into three
  // controls that look alike and mean different things.
  const ui = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/MeterPicker.jsx'), 'utf8');
  assert.ok(ui.indexOf('w-pick-menu') !== -1, 'the picker must exist');
  assert.match(ui, /This meter/, 'the two original pills stay');
  assert.match(ui, /All meters/);
  assert.match(ui, /has_packets/, 'meters with no data must be visibly unavailable');
  assert.match(ui, /No meters heard yet/, 'an empty list must say so rather than look broken');
  assert.match(ui, /packets_capture_all_meters/, 'the comment that says this stores nothing stays');
});

test('the meters endpoint is readable by the water panel, not only admins', function () {
  // Choosing which meter you are looking at is not an administrative act. A selector nobody can
  // populate is a selector that does not work.
  const api = fs.readFileSync(require.resolve('../api'), 'utf8');
  const i = api.indexOf("app.get('/api/water/meters'");
  assert.ok(i !== -1, 'the endpoint must exist');
  assert.match(api.slice(i, i + 120), /require_panel\('water'\)/);
});

test('every stat on the card follows the selected meter, not "is it mine"', function () {
  // The half-state this replaces: pick a neighbour and the TABLE changed while the odometer, the
  // packet count, the signal badge and the clock silently kept showing your meter. One row of
  // numbers describing two different houses, with nothing on screen saying so.
  //
  // On "all meters" the stats deliberately still describe YOUR meter -- mixing several endpoints'
  // arrival times into one interval or one SNR average describes no real transmitter.
  const ui = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/Monitor.jsx'), 'utf8');

  assert.match(ui, /const selId = /, 'the card must know which meter is selected');
  assert.match(ui, /const rtFocus = selId !== null \? rtPackets : rtPackets\.filter/,
    'the focus set is the selection, falling back to ours only when not one meter');
  assert.ok(ui.indexOf('rtMine') === -1,
    'rtMine is the old "is it mine" filter and must be gone -- it is what produced 0 transmissions '
    + 'and a blank SNR while the table was full of rows');

  for (const bound of ['cardOdo', 'cardSecs', 'cardLastAt', 'cardTitle']) {
    assert.ok(ui.indexOf(bound) !== -1, bound + ' must exist so the card follows the selection');
  }
  assert.match(ui, /packets=\{rtFocus\}/, 'the chart draws the selected meter too');
});

test('the picker shows meter ids, not a synonym for the badge beside them', function () {
  const ui = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/Monitor.jsx'), 'utf8');
  assert.ok(ui.indexOf('My meter') === -1, '"My meter" next to a "mine" badge says it twice');
  const pick = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/MeterPicker.jsx'), 'utf8');
  assert.ok(pick.indexOf('My meter') === -1, '"My meter" next to a "mine" badge says it twice');
  const store = fs.readFileSync(require.resolve('../store/meters'), 'utf8');
  assert.ok(store.indexOf("'My meter'") === -1, 'the registry must not auto-label the owned meter');
});

test('the whole page follows the selection, not just the packet table', function () {
  // What this pins: /api/water/status backs the banner, the run meter and the four tiles. If it
  // did not take `meter`, picking a neighbour would change the table while the numbers above it
  // silently kept describing your own house -- one screen about two different addresses.
  const api = fs.readFileSync(require.resolve('../api'), 'utf8');
  for (const route of ['/api/water/status', '/api/water/meter', '/api/water/hourly',
                       '/api/water/daily', '/api/water/readings', '/api/water/reception']) {
    const i = api.indexOf("app.get('" + route + "'");
    assert.ok(i !== -1, route + ' must exist');
    const seg = api.slice(i, i + 1400);
    assert.match(seg, /resolve_meter\(req\.query\.meter, cfg\)/,
      route + ' must resolve the selected meter rather than always using cfg.meter_id');
  }
});

test('the collector heartbeat is read from the owned meter whatever is selected', function () {
  // "Receiver online" is a property of the PROCESS, not of the meter you happen to be looking at.
  // Read from the selected meter's row it would report the collector as down the moment you
  // selected a neighbour -- the single most alarming thing this app can say, said wrongly.
  const api = fs.readFileSync(require.resolve('../api'), 'utf8');
  const i = api.indexOf('const own_state =');
  assert.ok(i !== -1, 'status must read the owned meter\'s state for the heartbeat');
  assert.match(api.slice(i, i + 400), /readings\.get_state\(cfg\.meter_id\)/);
  const seg = api.slice(api.indexOf('collector_up:'), api.indexOf('collector_up:') + 300);
  assert.match(seg, /heartbeat_at/);
});

test('the selection is shared by every water page and resets on load', function () {
  // Two failures this prevents. Per-page state: pick a neighbour on the Monitor, open History, and
  // you are silently back on your own meter with nothing saying so. Persisted state: reopen the app
  // tomorrow to a banner reading "All clear" about a house that is not yours.
  const sel = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/meterSel.js'), 'utf8');
  assert.ok(sel.indexOf('localStorage') === -1 && sel.indexOf('sessionStorage') === -1,
    'the selection must NOT persist across a page load');
  assert.match(sel, /export function useMeterSel/);

  for (const page of ['Monitor', 'History', 'Diagnostics']) {
    const src = fs.readFileSync(
      require.resolve('../../../web/src/modules/water/' + page + '.jsx'), 'utf8');
    assert.match(src, /useMeterSel\(\)/, page + ' must use the shared selection, not its own');
    assert.match(src, /MeterPicker/, page + ' must show the picker');
  }
});

test('alerts and leak rules stay owned-only', function () {
  // Display follows the picker; ACTION does not. The collector may never raise an alert about a
  // neighbour's water, and the alert history must not be filtered by the picker either -- an empty
  // list reads as "no alerts", which is the opposite of "not applicable".
  const run = fs.readFileSync(require.resolve('../collector/run'), 'utf8');
  const i = run.indexOf('async function ingest_other');
  assert.ok(i !== -1);
  const body = run.slice(i, run.indexOf('\n  }', i));
  assert.ok(body.indexOf('alerts.') === -1, 'a neighbour must never fire an alert');
  assert.ok(body.indexOf('rules.') === -1, 'a neighbour must never run the leak rules');

  const ui = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/Monitor.jsx'), 'utf8');
  assert.match(ui, /api\.waterAlerts\(5\)/, 'the alert history takes no meter parameter');
});

test('the observed backfill can never overwrite a live hour', function () {
  // It runs on every collector start, so it must be idempotent by construction. INSERT IGNORE means
  // an hour the live path already wrote wins; an UPDATE would double-count on the second start.
  const src = fs.readFileSync(require.resolve('../store/readings'), 'utf8');
  const i = src.indexOf('async function backfill_observed_hourly');
  assert.ok(i !== -1, 'the backfill must exist');
  const body = src.slice(i, src.indexOf('\n}', i));
  assert.match(body, /INSERT IGNORE INTO water_hourly/);
  assert.ok(body.indexOf('ON DUPLICATE KEY UPDATE') === -1, 'it must never update an existing hour');
  assert.match(body, /meter_id <> \?/, 'it must never touch the owned meter');
  assert.match(body, /heard_at_mtn/, 'hour buckets are LOCAL -- the UTC column would misfile them');
});
