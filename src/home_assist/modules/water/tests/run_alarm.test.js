'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const rules = require('../rules/leak_rules');

const CFG = {
  run_alarm_min: 60, run_alarm_gal: 100,
  run_alert_email: 1, run_alert_all_clear: 1,
};
const run = (o) => Object.assign(
  { flowing: true, minutes: 0, gallons: 0, rate: 1, started_at: '2026-08-01T14:32:00Z', truncated: false },
  o
);

// ── the duration trigger ─────────────────────────────────────────────────────────────────────

test('a normal shower does not alarm', function () {
  assert.strictEqual(rules.check_run_alarm(run({ minutes: 12, gallons: 22 }), CFG), null);
});

test('nothing fires one minute short of the threshold', function () {
  assert.strictEqual(rules.check_run_alarm(run({ minutes: 59, gallons: 40 }), CFG), null);
});

test('an hour unbroken alarms', function () {
  const a = rules.check_run_alarm(run({ minutes: 60, gallons: 45, rate: 0.75 }), CFG);
  assert.ok(a, 'must fire at run_alarm_min');
  assert.strictEqual(a.severity, 'high');
  assert.strictEqual(a.detail.trigger, 'minutes');
  assert.match(a.message, /1h 0m/);
});

// ── the volume trigger ───────────────────────────────────────────────────────────────────────

test('a burst line alarms in minutes, not in an hour', function () {
  // THE case duration alone misses. 110 gallons in 11 minutes is a supply line, not a fixture, and
  // waiting the full hour would mean waiting for 600 gallons.
  const a = rules.check_run_alarm(run({ minutes: 11, gallons: 110, rate: 10 }), CFG);
  assert.ok(a, 'volume must be able to fire on its own');
  assert.strictEqual(a.detail.trigger, 'gallons');
  assert.match(a.message, /100 gal mark/);
});

test('a full tub does not trip the volume trigger', function () {
  // ~50 gal is the largest single household draw. If 100 were set much lower this alert would cry
  // wolf on ordinary use, and an alert you learn to ignore is worse than no alert.
  assert.strictEqual(rules.check_run_alarm(run({ minutes: 9, gallons: 52 }), CFG), null);
});

test('the volume trigger can be switched off with 0', function () {
  const off = Object.assign({}, CFG, { run_alarm_gal: 0 });
  assert.strictEqual(rules.check_run_alarm(run({ minutes: 11, gallons: 400 }), off), null);
  assert.ok(rules.check_run_alarm(run({ minutes: 60, gallons: 400 }), off), 'minutes still work');
});

// ── keying: one email per RUN ────────────────────────────────────────────────────────────────

test('the alert is keyed on the run, not on a time bucket', function () {
  // Every other rule here uses a time cooldown. This one must not: a 12-hour cooldown would go
  // quiet through a SECOND, separate leak the same evening, and a short one would spam through a
  // single long one. Keying on the run start gives exactly one email per event.
  const a = rules.check_run_alarm(run({ minutes: 60, gallons: 45 }), CFG);
  const b = rules.check_run_alarm(run({ minutes: 190, gallons: 150 }), CFG);   // same run, later
  assert.strictEqual(a.key, b.key, 'the same run must keep the same key');

  const other = rules.check_run_alarm(
    run({ minutes: 60, gallons: 45, started_at: '2026-08-01T21:10:00Z' }), CFG);
  assert.notStrictEqual(a.key, other.key, 'a different run must get a different key');
});

test('a truncated run says "at least" rather than inventing a start', function () {
  const a = rules.check_run_alarm(run({ minutes: 480, gallons: 400, truncated: true }), CFG);
  assert.match(a.message, /at least/);
  assert.strictEqual(a.detail.truncated, true);
});

// ── switches ─────────────────────────────────────────────────────────────────────────────────

test('nothing fires when the run is not flowing', function () {
  assert.strictEqual(rules.check_run_alarm(run({ flowing: false, minutes: 600 }), CFG), null);
  assert.strictEqual(rules.check_run_alarm(null, CFG), null);
});

test('the email can be turned off without touching the dashboard', function () {
  const off = Object.assign({}, CFG, { run_alert_email: 0 });
  assert.strictEqual(rules.check_run_alarm(run({ minutes: 600, gallons: 900 }), off), null);
});

// ── the all-clear ────────────────────────────────────────────────────────────────────────────

const ALARMED = { key: 'run:2026-08-01T14:32:00Z', minutes: 134, gallons: 128 };

test('the all-clear fires once the run has stopped', function () {
  const c = rules.check_run_cleared(run({ flowing: false }), CFG, ALARMED);
  assert.ok(c);
  assert.strictEqual(c.severity, 'low', 'an all-clear must not wake anyone');
  assert.match(c.message, /2h 14m/);
  assert.match(c.message, /128 gal/);
});

test('the all-clear does not fire while the water is still running', function () {
  assert.strictEqual(rules.check_run_cleared(run({ flowing: true, minutes: 200 }), CFG, ALARMED), null);
});

test('an ordinary shower ending sends nothing', function () {
  // Without the last-alarm record this would announce the end of every draw in the house.
  assert.strictEqual(rules.check_run_cleared(run({ flowing: false }), CFG, null), null);
});

test('the all-clear key cannot collide with the alarm it follows', function () {
  const c = rules.check_run_cleared(run({ flowing: false }), CFG, ALARMED);
  assert.notStrictEqual(c.key, ALARMED.key);
  assert.match(c.key, /:cleared$/);
});

// ── wiring ───────────────────────────────────────────────────────────────────────────────────

test('the collector evaluates the run every tick and remembers what it alarmed on', function () {
  const src = fs.readFileSync(require.resolve('../collector/run'), 'utf8');
  assert.match(src, /rules\.current_run\(recent, now, cfg\)/, 'the tick must compute the run');
  assert.match(src, /run: current/, 'and hand it to evaluate');
  assert.match(src, /last_alarm_run: last_alarm_run/, 'and carry the last alarm for the all-clear');
  assert.match(src, /if \(last_alarm_run && !current\.flowing\) last_alarm_run = null/,
    'and clear it once the run ends, or the next run inherits the old one');
});

test('the hourly continuous rule is still wired in alongside the run alarm', function () {
  // They catch different SHAPES. A run that never pauses is caught in an hour by the run alarm; a
  // fill valve cycling every few minutes keeps resetting the run timer and is only ever visible in
  // the hourly buckets. Removing either leaves a class of leak unwatched.
  const src = fs.readFileSync(require.resolve('../rules/leak_rules'), 'utf8');
  const ev = src.match(/function evaluate\(input\)[\s\S]*?\n}/)[0];
  assert.match(ev, /check_continuous\(/);
  assert.match(ev, /check_run_alarm\(/);
  assert.match(ev, /check_run_cleared\(/);
});

test('the catalog no longer calls the run dashboard-only', function () {
  const cat = rules.ALERT_CATALOG;
  const r = cat.find(function (a) { return a.key === 'run'; });
  assert.ok(r, 'the catalog must carry the run alert');
  assert.notStrictEqual(r.email, false, 'it emails now');
  assert.strictEqual(r.severity, 'high');
  assert.ok(r.settings.indexOf('run_alarm_gal') !== -1, 'and expose the new setting');
  assert.ok(cat.find(function (a) { return a.key === 'run_cleared'; }), 'and the all-clear');
});
