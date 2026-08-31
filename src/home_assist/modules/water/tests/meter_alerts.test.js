'use strict';
/**
 * meter_alerts.test.js — the per-meter alerts panel, and the two bugs that made it necessary.
 *
 * Everything here is pure: sample_alerts() runs the real rule functions over synthesised inputs,
 * build_email() formats the result, parse_alerts_off() validates a column value. No MySQL, no
 * radio, no clock beyond the one passed in.
 *
 * The panel's whole claim is "this is what will be sent". These tests are what stop that from
 * becoming a lie — a preview that is merely PLAUSIBLE is worse than no preview, because it is the
 * thing people will check instead of checking the mail.
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.WATER_TZ = process.env.WATER_TZ || 'America/Denver';
const rules = require('../rules/leak_rules');
const alerts = require('../store/alerts');
const meters = require('../store/meters');

const TZ = 'America/Denver';
const CFG = {
  meter_id: 16642655,
  overnight_start_hour: 2, overnight_end_hour: 5, overnight_threshold_gal: 3,
  continuous_hours: 6, continuous_min_gal_per_hour: 1,
  run_gap_min: 5, run_warn_min: 30, run_alarm_min: 60, run_alarm_gal: 100,
  run_alert_email: 1, run_alert_all_clear: 1,
  stale_minutes: 90, daily_summary_hour: 8,
};
const NOW = new Date('2026-08-31T21:00:00Z');   // 15:00 in Denver — mid-afternoon, nothing happening

// ── the all-clear email: the bug this work found ────────────────────────────────────────────────

test('the all-clear email is formatted, not dumped', function () {
  // `check_run_cleared` emits kind 'run_cleared'. alerts.js was keyed on 'run_clear' -- no D -- in
  // BOTH the subject map and the detail-row branch. The result was the exact output the email
  // rewrite existed to delete: a generic subject and a list of raw field names. It survived the
  // rewrite because a missing key in a lookup table is indistinguishable from a kind that was
  // never meant to have one, and no test named the kind out loud.
  const e = alerts.build_email({
    kind: 'run_cleared',
    message: 'The run that triggered the alarm has stopped. 2h 5m, 96 gal total.',
    detail: { started_at: '2026-08-30 18:12:00', minutes: 125, gallons: 96.4, rate: 0.77, trigger: 'minutes' },
  }, CFG, { meter_id: 14905174, meter_name: '4528 Sprucedale' });

  assert.strictEqual(e.subject, '[WATER] Stopped after 2h 5m — 4528 Sprucedale');
  assert.match(e.text, /Ran for: 2h 5m/);
  assert.match(e.text, /Volume: 96 gal/);
  // The tells of the raw dump.
  assert.ok(e.text.indexOf('started at:') === -1, 'no raw field names');
  assert.ok(e.text.indexOf('trigger:') === -1);
  assert.ok(e.text.indexOf('[WATER] Alert') === -1, 'not the generic fallback subject');
});

test('the two run alerts have their own banner colours', function () {
  // Both fell through to the grey default. The run alarm is the fastest and most urgent thing this
  // app says and was arriving looking calmer than the overnight advisory.
  assert.strictEqual(alerts.COLORS.run, '#dc3545');
  assert.strictEqual(alerts.COLORS.run_cleared, '#28a745');
});

// ── the preview ────────────────────────────────────────────────────────────────────────────────

test('every alert in the catalog can produce a sample', function () {
  // If a catalog row has no sample the panel shows an apology where the email should be, and the
  // reader cannot answer the one question the panel exists for.
  const s = rules.sample_alerts(CFG, TZ, NOW);
  for (const c of rules.ALERT_CATALOG) {
    const key = c.key || c.kind;
    assert.ok(s[key], key + ' must produce a preview');
  }
});

test('the sample comes back out of the REAL rules, past the meter’s own thresholds', function () {
  // Not hand-written prose. Move a threshold and the preview must move with it, or the page is
  // describing an app that no longer exists.
  const s = rules.sample_alerts(CFG, TZ, NOW);
  assert.strictEqual(s.run.kind, 'run');
  assert.ok(s.run.detail.minutes >= CFG.run_alarm_min, 'the run sample clears run_alarm_min');
  assert.ok(s.overnight.detail.total > CFG.overnight_threshold_gal, 'and the overnight threshold');

  const tuned = rules.sample_alerts(Object.assign({}, CFG, { run_alarm_min: 240 }), TZ, NOW);
  assert.ok(tuned.run.detail.minutes >= 240, 'a retuned threshold moves the preview');
  assert.match(tuned.run.message, /4h/);
});

// ── the email actually reads the fields the rules actually write ────────────────────────────────

test('every alert’s email carries its own figures, from the real rule output', function () {
  // THE test this file exists for, and the one whose absence hid a whole class of bug.
  //
  // build_email's detail branch was written against invented field names -- `total_gal`,
  // `threshold_gal`, `min_gal_per_hour`, `minutes` -- where leak_rules emits `total`, `threshold`,
  // `min_per_hour` and `quiet_minutes`. Nothing threw: the row builder skips undefined, so the
  // overnight email simply arrived with no numbers in it and a subject that had lost its gallons.
  //
  // It passed review and a test suite because the fixtures were written from the same wrong guess
  // as the code. Feeding sample_alerts() -- the REAL rules -- into build_email() is what makes that
  // impossible: there is now exactly one source for the field names, and it is the rules.
  const s = rules.sample_alerts(CFG, TZ, NOW);
  const ctx = { meter_id: 14905174, meter_name: 'Next door' };
  const mail = function (k) { return alerts.build_email(s[k], CFG, ctx); };

  const on = mail('overnight');
  assert.match(on.subject, /^\[WATER\] \d+ gal overnight — Next door$/, 'the subject keeps its number');
  assert.match(on.text, /Used overnight: \d+ gal/);
  assert.match(on.text, /Alerts above: 3 gal/);
  assert.match(on.text, /Overnight window: 2:00 to 5:00/);

  const co = mail('continuous');
  assert.match(co.subject, /Water every hour for 6h/);
  assert.match(co.text, /Hours in a row with water: 6/);
  assert.match(co.text, /Counts as flow above: 1 gal\/hour/);

  const run = mail('run');
  assert.match(run.subject, /Running 1h without stopping/);
  assert.match(run.text, /Ran for: 1h/);
  assert.match(run.text, /Volume: \d+ gal/);

  const st = mail('stale');
  assert.match(st.text, /Silent for: 1h 35m/, 'durations read as durations, not raw minutes');
  assert.match(st.text, /Alerts after: 90 minutes of silence/);

  const su = mail('summary');
  assert.match(su.text, /Yesterday: \d+ gal/);
  assert.match(su.text, /Your \d+-day average: \d+ gal\/day/);
});

test('no email is left with a bare headline and no figures', function () {
  // The failure mode of the bug above, stated as a rule rather than per-alert. An alert that
  // reaches you with nothing but its headline has told you something is wrong and given you
  // nothing to act on -- which is the state three of the six were shipped in.
  const s = rules.sample_alerts(CFG, TZ, NOW);
  for (const key of Object.keys(s)) {
    const e = alerts.build_email(s[key], CFG, { meter_id: 16642655 });
    const rows = e.text.split('\n').filter(function (l) { return /^[A-Z][^:]*: /.test(l); });
    // Meter and When are on every email; anything with only those two carries no facts of its own.
    assert.ok(rows.length > 2, key + ' must carry figures of its own, not just Meter and When: '
      + rows.join(' | '));
  }
});

test('a preview is built by the same function that sends', function () {
  // The design rule: if the page and the mail can disagree, the page is worthless.
  const s = rules.sample_alerts(CFG, TZ, NOW);
  const e = alerts.build_email(s.overnight, CFG, { meter_id: 14905174, meter_name: 'Next door' });
  assert.match(e.subject, /^\[WATER\] \d+ gal overnight — Next door$/);
  assert.match(e.text, /What to check:/);
});

test('the enable gates are forced for the preview, but not the thresholds', function () {
  // A switched-off alert must still show what it WOULD send -- a blank panel hides the one thing
  // you need in order to decide whether to switch it on. The numbers are not forced: those are the
  // question being answered.
  const off = Object.assign({}, CFG, { run_alert_email: 0, run_alert_all_clear: 0 });
  const s = rules.sample_alerts(off, TZ, NOW);
  assert.ok(s.run, 'the run alarm previews even when its email setting is off');
  assert.ok(s.run_cleared, 'and so does the all-clear');
});

test('the previewed clock is the CONFIGURED zone, not the process one', function () {
  // check_overnight() returns null until the window has passed and daily_summary() fires only in
  // its own hour, so the sample picks a `now` for each. Computed through time.js -- a setHours()
  // here would read the process timezone and quietly preview the wrong window on the Ubuntu box
  // while looking right on the Windows laptop.
  const src = require('fs').readFileSync(require.resolve('../rules/leak_rules'), 'utf8');
  const i = src.indexOf('function at_local_hour');
  assert.ok(i !== -1);
  const fn = src.slice(i, i + 400);
  assert.ok(fn.indexOf('setHours') === -1, 'never setHours');
  assert.match(fn, /time\.local_hour/);
});

// ── switching one alert off ────────────────────────────────────────────────────────────────────

test('the watchdog cannot be switched off, by any route', function () {
  // Silence is not safety. A dead receiver reports a flat zero, indistinguishable from a quiet
  // night — so suppressing this alert does not make the monitor quieter, it makes it dishonest.
  assert.strictEqual(rules.is_suppressible('stale'), false);
  assert.strictEqual(rules.is_suppressible('never_decoded'), false);
  assert.strictEqual(rules.is_suppressible('summary'), true);

  // Refused on the way IN, and again on the way OUT, because the column can be hand-edited in
  // MySQL and this is the one alert whose absence nobody can notice.
  assert.deepStrictEqual(meters.parse_alerts_off('stale,summary,never_decoded'), ['summary']);
});

test('an unknown or repeated key is dropped rather than stored', function () {
  // A key the catalog does not know is a typo or a renamed rule. Keeping it would mean a switch
  // the UI cannot draw and nobody can turn back on; dropping it fails the safe way — it sends.
  assert.deepStrictEqual(meters.parse_alerts_off('summary,nonsense,summary'), ['summary']);
  assert.deepStrictEqual(meters.parse_alerts_off(''), []);
  assert.deepStrictEqual(meters.parse_alerts_off(null), []);
  assert.deepStrictEqual(meters.parse_alerts_off('  overnight ,, run '), ['overnight', 'run']);
});

test('a fired alert maps to its CATALOG key, not its per-firing one', function () {
  // A firing's key is deliberately unique -- 'overnight:2026-08-31' -- because that is what makes
  // the cooldown one-leak-one-email. A stored preference needs the opposite.
  assert.strictEqual(rules.catalog_key({ kind: 'overnight', key: 'overnight:2026-08-31' }), 'overnight');
  assert.strictEqual(rules.catalog_key({ kind: 'run', key: 'run:2026-08-31 05:04:00' }), 'run');
  assert.strictEqual(rules.catalog_key({ kind: 'run_cleared', key: 'run:x:cleared' }), 'run_cleared');
  // The one row keyed by `key`: "it broke" and "it never worked" are the same kind and different
  // problems, so they are separate catalog entries and must stay separately switchable.
  assert.strictEqual(rules.catalog_key({ kind: 'stale', key: 'never_decoded' }), 'never_decoded');
  assert.strictEqual(rules.catalog_key({ kind: 'stale', key: 'stale' }), 'stale');
});

test('every catalog key is unique — a duplicate would make one alert unswitchable', function () {
  const keys = rules.ALERT_CATALOG.map(function (c) { return c.key || c.kind; });
  assert.strictEqual(new Set(keys).size, keys.length, keys.join(', '));
});

test('turning an alert off still RECORDS it', function () {
  // The rule ran and found what it found. An email switch that also edits the history turns a
  // quiet alert into a blind one, and the Monitor would then agree with the silence.
  const src = require('fs').readFileSync(require.resolve('../store/alerts'), 'utf8');
  const i = src.indexOf('is_suppressible(ckey) && off.indexOf(ckey) >= 0');
  assert.ok(i !== -1, 'dispatch must consult the per-meter list');
  const seg = src.slice(i, i + 400);
  assert.match(seg, /await record\(/, 'and record the alert anyway');
  assert.match(seg, /delivered: false/);
});

test('the collector hands the per-meter list to dispatch — for both meters', function () {
  // Resolved in run.js, never read by alerts.js: that module stays a formatter with no queries of
  // its own. Two dispatch sites, and the OWNED one was the easy one to forget.
  const src = require('fs').readFileSync(require.resolve('../collector/run'), 'utf8');
  assert.strictEqual((src.match(/alerts_off:/g) || []).length, 2,
    'both the observed-meter loop and the owned tick must pass it');
});
