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
  const ui = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/Monitor.jsx'), 'utf8');
  const i = ui.indexOf('w-pick-menu');
  assert.ok(i !== -1, 'the picker must exist');
  const seg = ui.slice(i - 1600, i + 1600);
  assert.match(seg, /This meter/, 'the two original pills stay');
  assert.match(seg, /All meters/);
  assert.match(seg, /has_packets/, 'meters with no data must be visibly unavailable');
  assert.match(seg, /No meters heard yet/, 'an empty list must say so rather than look broken');
});

test('the meters endpoint is readable by the water panel, not only admins', function () {
  // Choosing which meter you are looking at is not an administrative act. A selector nobody can
  // populate is a selector that does not work.
  const api = fs.readFileSync(require.resolve('../api'), 'utf8');
  const i = api.indexOf("app.get('/api/water/meters'");
  assert.ok(i !== -1, 'the endpoint must exist');
  assert.match(api.slice(i, i + 120), /require_panel\('water'\)/);
});
