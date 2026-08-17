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

test('detection runs for every meter; DELIVERY is owned-only', function () {
  // The boundary that replaced "alerts are owned-only". Observed meters are now watched -- the same
  // pure rules run over their hour buckets and the results are recorded -- but nothing is emailed
  // or pushed for them. Waking someone at 3am about a stranger's shower is not a feature, and the
  // two halves of that sentence are enforced in two different places.
  const store = fs.readFileSync(require.resolve('../store/alerts'), 'utf8');
  const i = store.indexOf('async function dispatch');
  assert.ok(i !== -1);
  const body = store.slice(i, store.indexOf('\n}', i));
  assert.match(body, /may_deliver/, 'delivery must be a separate decision from detection');
  assert.match(body, /if \(!may_deliver\)/, 'a meter with notify off must short-circuit before any send');
  // Recorded, not dropped: the history and the banner need the row.
  const gate = body.slice(body.indexOf('if (!may_deliver)'), body.indexOf('const channels'));
  assert.match(gate, /await record\(/, 'a non-delivered alert must still be recorded');
  assert.ok(gate.indexOf('mailer') === -1 && gate.indexOf('ntfy') === -1,
    'nothing may be sent on the not-delivered path');

  // ingest_other still touches no rule and no alert -- the collector's fast path stays clean; the
  // observed rules run on the slow tick instead.
  const run = fs.readFileSync(require.resolve('../collector/run'), 'utf8');
  const k = run.indexOf('async function ingest_other');
  const ing = run.slice(k, run.indexOf('\n  }', k));
  assert.ok(ing.indexOf('alerts.') === -1, 'the packet path must never dispatch an alert');
  assert.ok(ing.indexOf('rules.') === -1, 'the packet path must never run the leak rules');
});

test('one meter cooldown can never suppress another meter alert', function () {
  // The dangerous one. Keyed on alert_key alone, a neighbour whose overnight rule tripped first
  // takes the cooldown slot and silences YOURS for the next six hours -- two houses sharing one
  // mutex, and the failure is completely invisible.
  const store = fs.readFileSync(require.resolve('../store/alerts'), 'utf8');
  const i = store.indexOf('async function in_cooldown');
  assert.ok(i !== -1);
  const body = store.slice(i, store.indexOf('\n}', i));
  assert.match(body, /WHERE meter_id = \? AND alert_key = \?/,
    'the cooldown ledger must be keyed on (meter_id, alert_key)');
  assert.match(body, /function in_cooldown\(alert_key, cooldown_min, meter_id\)/);
});

test('the receiver-silent watchdog never fires for an observed meter', function () {
  // Silence from a neighbour means MY antenna lost THEM, not that their pipe burst. A watchdog that
  // fires whenever reception dips is one you learn to ignore -- and it is the single alert that must
  // never be ignored, because silence is the one state indistinguishable from a quiet night.
  const run = fs.readFileSync(require.resolve('../collector/run'), 'utf8');
  const i = run.indexOf('async function tick_observed');
  assert.ok(i !== -1, 'the observed rules tick must exist');
  const body = run.slice(i, run.indexOf('\n  }\n', i));
  assert.match(body, /last_read_at: now/, 'passing `now` is what makes the watchdog unable to trip');
  assert.match(body, /alert\.kind === 'stale'\) continue/, 'and a second, explicit guard');
  assert.match(body, /notify: !!m\.notify/, 'delivery is decided by the registry, not by an if here');
});

test('the owned meter is the only one that notifies by default', function () {
  const store = fs.readFileSync(require.resolve('../store/meters'), 'utf8');
  const i = store.indexOf('async function ensure_owned');
  assert.match(store.slice(i, i + 900), /notify = 1/, 'your meter notifies from the first boot');
  const schema = fs.readFileSync(require.resolve('../../../store/schema'), 'utf8');
  assert.match(schema, /notify\s+TINYINT\(1\)\s+NOT NULL DEFAULT 0/,
    'every other meter must default to recorded-only');
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

test('the card clock and the banner clock are the same clock', function () {
  // The bug: the card read the odometer and last-heard off the newest row of the PACKET array while
  // the banner read them from /api/water/status. Two sources, two poll intervals, so the banner said
  // 3:32:34 and the card said 3:32:30 with "9s ago" -- both honest, four seconds apart. Now that
  // status follows the selection there is no reason for a second source, and one source cannot
  // disagree with itself.
  const ui = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/Monitor.jsx'), 'utf8');
  assert.match(ui, /const cardOdo = liveOdo;/);
  assert.match(ui, /const cardLastAt = r\.last_read_at;/);
  assert.match(ui, /const cardSecs = secsSince;/);
  assert.ok(ui.indexOf('rtNewest') === -1,
    'the packet-array fallback is what produced two clocks and must be gone');
});

test('"mine" is decided by the OWNED meter, never by the selected one', function () {
  // Selecting 14905174 badged every one of its rows "mine", because the cell renderer was handed
  // status.meter_id -- which now means "the meter in view". The same conflation the whole pass
  // exists to remove, reintroduced one argument at a time.
  const ui = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/Monitor.jsx'), 'utf8');
  assert.match(ui, /renderPacketCell\(rt && rt\.quality, status\.own_meter_id\)/);
  assert.ok(ui.indexOf('renderPacketCell(rt && rt.quality, status.meter_id)') === -1);
});

test('every per-minute chart reads packets_meter, not packets_ours', function () {
  // On a neighbour's reception row packets_ours is zero BY DEFINITION. A chart plotting it draws a
  // flatline, and a flatline on this chart means "the radio heard nothing" -- the opposite of the
  // truth, stated confidently.
  const api = fs.readFileSync(require.resolve('../api'), 'utf8');
  assert.match(api, /packets_meter: Number\(r\.packets_meter\)/,
    '/api/water/reception must expose the per-meter count');
  const diag = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/Diagnostics.jsx'), 'utf8');
  assert.match(diag, /value: m\.packets_meter/, 'the reception chart must plot it');
  assert.ok(diag.indexOf('m.packets_ours') === -1,
    'no stat on Diagnostics may still be keyed to "is it mine"');
});

test('bar value labels are dropped rather than allowed to collide', function () {
  // And never printed on a no-data bar: "0" over a stub erases the one distinction this chart works
  // hardest to keep. On a leak monitor "no reading" and "no water" are opposite conclusions.
  const chart = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/BarChart.jsx'), 'utf8');
  assert.match(chart, /VALUE_LABEL_MIN_PX/, 'there must be a width floor, not an unconditional label');
  assert.match(chart, /labelValues = showValues && slot >= VALUE_LABEL_MIN_PX/);
  assert.match(chart, /labelValues && d\.observed/, 'only observed bars may carry a number');
});

test('a recorded-but-undelivered alert is not shown as a failure', function () {
  // Three states, not two. "delivery failed" and "deliberately not delivered" render identically as
  // a red cross, and one is a broken channel while the other is the system working as designed --
  // conflating them teaches you to ignore the red ones that are real.
  const ui = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/Alerts.jsx'), 'utf8');
  assert.match(ui, /notify is off/, 'the recorded-only state must be detected');
  assert.match(ui, /recorded only/);
  const css = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/water.css'), 'utf8');
  assert.match(css, /\.w-pill\.watched/, 'and must have its own, non-red treatment');
});
