'use strict';
/**
 * leak_rules.test.js — the rules that decide whether to wake you at 3am.
 *
 * No database, no radio, no waiting until 2am: the rules are pure functions over an hour-bucket
 * map, so every scenario is a literal object. That is the entire reason they were extracted from
 * monitor.mjs as pure functions.
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.WATER_TZ = 'America/Denver';
const rules = require('../rules/leak_rules');
const settings = require('../store/settings');

const TZ = 'America/Denver';
const cfg = settings.defaults();

// 2026-08-01 07:00 local (Denver, UTC-6) == 13:00Z. Past the 5am overnight window, so the
// overnight check is live.
const MORNING = new Date('2026-08-01T13:00:00Z');

function hours(map) { return Object.assign({}, map); }

// ───────────────────────────── overnight ─────────────────────────────

test('overnight: quiet night does not alert', function () {
  const h = hours({ '2026-08-01T02': 0, '2026-08-01T03': 0, '2026-08-01T04': 0 });
  assert.strictEqual(rules.check_overnight(h, MORNING, cfg, TZ), null);
});

test('overnight: usage under the threshold does not alert', function () {
  // threshold is 3 gal; 2 total should stay quiet (an ice maker, not a leak)
  const h = hours({ '2026-08-01T02': 1, '2026-08-01T03': 0, '2026-08-01T04': 1 });
  assert.strictEqual(rules.check_overnight(h, MORNING, cfg, TZ), null);
});

test('overnight: a running toilet alerts', function () {
  const h = hours({ '2026-08-01T02': 40, '2026-08-01T03': 41, '2026-08-01T04': 39 });
  const a = rules.check_overnight(h, MORNING, cfg, TZ);
  assert.ok(a, 'expected an alert');
  assert.strictEqual(a.kind, 'overnight');
  assert.strictEqual(a.key, 'overnight:2026-08-01');
  assert.strictEqual(a.severity, 'high');
  assert.match(a.message, /120 gal/);
  assert.strictEqual(a.detail.total, 120);
});

test('overnight: does not evaluate before the window has passed', function () {
  // 03:00 local == 09:00Z — we are still inside the window, so no verdict yet.
  const inside = new Date('2026-08-01T09:00:00Z');
  const h = hours({ '2026-08-01T02': 99 });
  assert.strictEqual(rules.check_overnight(h, inside, cfg, TZ), null);
});

test('overnight: no data at all is not an alert (that is the watchdog\'s job)', function () {
  assert.strictEqual(rules.check_overnight({}, MORNING, cfg, TZ), null);
});

test('overnight: partial data still evaluates', function () {
  // We only observed one hour of the window, and it alone exceeds the threshold.
  const h = hours({ '2026-08-01T03': 50 });
  const a = rules.check_overnight(h, MORNING, cfg, TZ);
  assert.ok(a);
  assert.strictEqual(a.detail.hours_missing, 2);
});

// ───────────────────────────── continuous ────────────────────────────

test('continuous: six straight hours of flow alerts', function () {
  const h = {};
  for (let i = 1; i <= 6; i++) h['2026-08-01T' + String(7 - i).padStart(2, '0')] = 5;
  const a = rules.check_continuous(h, MORNING, cfg, TZ);
  assert.ok(a, 'expected an alert');
  assert.strictEqual(a.kind, 'continuous');
  assert.strictEqual(a.detail.total, 30);
});

test('continuous: one dry hour breaks the streak', function () {
  const h = {};
  for (let i = 1; i <= 6; i++) h['2026-08-01T' + String(7 - i).padStart(2, '0')] = 5;
  h['2026-08-01T03'] = 0;                       // a gap in the middle
  assert.strictEqual(rules.check_continuous(h, MORNING, cfg, TZ), null);
});

test('continuous: a missing hour is not a streak', function () {
  const h = {};
  for (let i = 1; i <= 6; i++) h['2026-08-01T' + String(7 - i).padStart(2, '0')] = 5;
  delete h['2026-08-01T04'];                    // no data != zero flow
  assert.strictEqual(rules.check_continuous(h, MORNING, cfg, TZ), null);
});

test('continuous: flow below the per-hour minimum does not count', function () {
  const h = {};
  for (let i = 1; i <= 6; i++) h['2026-08-01T' + String(7 - i).padStart(2, '0')] = 0.4;
  assert.strictEqual(rules.check_continuous(h, MORNING, cfg, TZ), null);
});

// ───────────────────────────── watchdog ──────────────────────────────

test('watchdog: a recent reading is fine', function () {
  const recent = new Date(MORNING.getTime() - 5 * 60000);
  assert.strictEqual(rules.check_watchdog(recent, MORNING, cfg), null);
});

test('watchdog: silence past the threshold alerts', function () {
  const old = new Date(MORNING.getTime() - 200 * 60000);
  const a = rules.check_watchdog(old, MORNING, cfg);
  assert.ok(a, 'expected an alert');
  assert.strictEqual(a.kind, 'stale');
  assert.strictEqual(a.detail.quiet_minutes, 200);
  assert.match(a.message, /NOT running/);
});

test('watchdog: no reading and no start time is not an alert', function () {
  // Genuinely nothing to measure from.
  assert.strictEqual(rules.check_watchdog(null, MORNING, cfg), null);
});

test('watchdog: NEVER decoding a packet alerts once past the threshold', function () {
  // The hole this closes: the collector is up, has never heard the meter, and used to send
  // nothing at all — for days — while the dashboard said "waiting for first reading". That is the
  // same danger as going deaf mid-run, at the moment you are most likely to hit it.
  const started = new Date(MORNING.getTime() - 200 * 60000);
  const a = rules.check_watchdog(null, MORNING, cfg, started);
  assert.ok(a, 'expected an alert');
  assert.strictEqual(a.kind, 'stale');
  assert.strictEqual(a.key, 'never_decoded', 'own cooldown key — a different problem from going silent');
  assert.strictEqual(a.detail.never_decoded, true);
  assert.strictEqual(a.detail.running_minutes, 200);
  assert.match(a.message, /NEVER decoded/);
  assert.match(a.message, /PLL not locked/, 'should name the symptom you would actually see');
});

test('watchdog: a freshly started collector gets a grace period', function () {
  // 10 minutes in, with a 90-minute threshold: still starting up, not yet a fault.
  const started = new Date(MORNING.getTime() - 10 * 60000);
  assert.strictEqual(rules.check_watchdog(null, MORNING, cfg, started), null);
});

test('watchdog: once readings exist, start time is irrelevant', function () {
  // A long-running collector that is currently healthy must not alert just because it started
  // days ago — the last READING is what matters.
  const started = new Date(MORNING.getTime() - 10000 * 60000);
  const recent = new Date(MORNING.getTime() - 5 * 60000);
  assert.strictEqual(rules.check_watchdog(recent, MORNING, cfg, started), null);
});

// ───────────────────────────── daily summary ─────────────────────────

test('summary: fires only at the configured hour', function () {
  const at8 = new Date('2026-08-01T14:00:00Z');   // 08:00 Denver
  const at9 = new Date('2026-08-01T15:00:00Z');   // 09:00 Denver
  const h = { '2026-08-01T07': 10 };
  assert.ok(rules.daily_summary(h, at8, cfg, TZ));
  assert.strictEqual(rules.daily_summary(h, at9, cfg, TZ), null);
});

test('summary: can be disabled', function () {
  const off = Object.assign({}, cfg, { daily_summary_hour: -1 });
  const at8 = new Date('2026-08-01T14:00:00Z');
  assert.strictEqual(rules.daily_summary({}, at8, off, TZ), null);
});

// ───────────────────────────── status banner ─────────────────────────

test('status: silence outranks everything — being blind is the worst state', function () {
  const h = {};
  for (let i = 1; i <= 6; i++) h['2026-08-01T' + String(7 - i).padStart(2, '0')] = 5;
  const old = new Date(MORNING.getTime() - 500 * 60000);
  const s = rules.status({ hours: h, now: MORNING, cfg: cfg, tz: TZ, last_read_at: old });
  assert.strictEqual(s.state, 'offline');
});

test('status: all clear on a normal morning', function () {
  const h = { '2026-08-01T02': 0, '2026-08-01T03': 0, '2026-08-01T04': 0, '2026-08-01T06': 12 };
  const s = rules.status({ hours: h, now: MORNING, cfg: cfg, tz: TZ, last_read_at: new Date(MORNING.getTime() - 60000) });
  assert.strictEqual(s.state, 'ok');
  assert.strictEqual(s.headline, 'All clear');
});

test('status: unknown during the start-up grace period', function () {
  const started = new Date(MORNING.getTime() - 5 * 60000);
  const s = rules.status({ hours: {}, now: MORNING, cfg: cfg, tz: TZ, last_read_at: null, started_at: started });
  assert.strictEqual(s.state, 'unknown');
  assert.match(s.detail, /90 min/, 'should say when it will escalate');
});

test('status: "never decoded" is distinct from "receiver silent"', function () {
  // They look identical on a chart but mean different things: one is a setup problem you can fix
  // now, the other is a working system that broke.
  const started = new Date(MORNING.getTime() - 300 * 60000);
  const never = rules.status({ hours: {}, now: MORNING, cfg: cfg, tz: TZ, last_read_at: null, started_at: started });
  assert.strictEqual(never.state, 'offline');
  assert.strictEqual(never.headline, 'Never decoded a packet');

  const old = new Date(MORNING.getTime() - 300 * 60000);
  const silent = rules.status({ hours: {}, now: MORNING, cfg: cfg, tz: TZ, last_read_at: old, started_at: started });
  assert.strictEqual(silent.state, 'offline');
  assert.strictEqual(silent.headline, 'Receiver silent');
});

test('status: an overnight leak surfaces', function () {
  const h = { '2026-08-01T02': 40, '2026-08-01T03': 41, '2026-08-01T04': 39 };
  const s = rules.status({ hours: h, now: MORNING, cfg: cfg, tz: TZ, last_read_at: new Date(MORNING.getTime() - 60000) });
  assert.strictEqual(s.state, 'leak');
  assert.strictEqual(s.headline, 'Overnight flow');
});

// ───────────────────────────── evaluate() ────────────────────────────

test('evaluate: returns every signal that fired', function () {
  const h = { '2026-08-01T02': 40, '2026-08-01T03': 41, '2026-08-01T04': 39 };
  const fired = rules.evaluate({ hours: h, now: MORNING, cfg: cfg, tz: TZ, last_read_at: new Date(MORNING.getTime() - 60000) });
  const kinds = fired.map(function (a) { return a.kind; });
  assert.deepStrictEqual(kinds, ['overnight']);
});

test('evaluate: a quiet, healthy system fires nothing', function () {
  const fired = rules.evaluate({
    hours: { '2026-08-01T02': 0, '2026-08-01T03': 0, '2026-08-01T04': 0 },
    now: MORNING, cfg: cfg, tz: TZ, last_read_at: new Date(MORNING.getTime() - 60000),
  });
  assert.deepStrictEqual(fired, []);
});

// ───────────────────────── current run (the point of the app) ─────────────────────────

const NOW = new Date('2026-08-01T09:00:00Z');
// recent_readings returns newest-first, MySQL DATETIME strings. Mirror that exactly.
function reads(spec) {
  return spec.map(function (s) {
    return {
      read_at_utc: new Date(NOW.getTime() - s[0] * 60000).toISOString().slice(0, 19).replace('T', ' '),
      delta_gallons: s[1],
    };
  });
}

test('run: nothing recorded is idle, not a run', function () {
  assert.strictEqual(rules.current_run([], NOW, cfg).flowing, false);
  assert.strictEqual(rules.current_run(null, NOW, cfg).level, 'idle');
});

test('run: flow that stopped long ago reports how long it has been quiet', function () {
  const r = rules.current_run(reads([[45, 3]]), NOW, cfg);
  assert.strictEqual(r.flowing, false);
  assert.strictEqual(r.idle_minutes, 45, 'silence is the good news — make it legible');
  assert.strictEqual(r.level, 'idle');
});

test('run: a shower is a normal run, not an alarm', function () {
  // 10 minutes of flow, 2 gal/min, ending now.
  const spec = [];
  for (let m = 0; m <= 10; m++) spec.push([m, 2]);
  const r = rules.current_run(reads(spec), NOW, cfg);
  assert.strictEqual(r.flowing, true);
  assert.strictEqual(r.level, 'running');
  assert.strictEqual(r.minutes, 10);
  assert.strictEqual(r.gallons, 22);
});

test('run: past the warn threshold it escalates, but is not yet an alarm', function () {
  const spec = [];
  for (let m = 0; m <= 35; m++) spec.push([m, 1]);
  assert.strictEqual(rules.current_run(reads(spec), NOW, cfg).level, 'long');
});

test('run: an hour of unbroken flow is CONTINUOUS', function () {
  // The running toilet. This is the case the whole app exists to catch, and the hourly rule would
  // stay silent about it for another five hours.
  const spec = [];
  for (let m = 0; m <= 75; m++) spec.push([m, 1]);
  const r = rules.current_run(reads(spec), NOW, cfg);
  assert.strictEqual(r.level, 'continuous');
  assert.ok(r.minutes >= 75);
  assert.ok(r.rate > 0);
});

test('run: an idle gap ends the run — two showers are not one leak', function () {
  // 5 min of flow now, a 20-minute gap, then an earlier 10 min of flow. The current run is 5 min.
  const spec = [];
  for (let m = 0; m <= 5; m++) spec.push([m, 2]);
  for (let m = 25; m <= 35; m++) spec.push([m, 2]);
  const r = rules.current_run(reads(spec), NOW, cfg);
  assert.strictEqual(r.minutes, 5, 'the earlier shower must not be welded onto the current run');
  assert.strictEqual(r.gallons, 12);
});

test('run: a SLOW leak is not split into innocent short runs', function () {
  // The failure this guards: at 0.4 gal/min the meter only ticks a whole gallon every ~2.5 min.
  // A gap threshold below that would chop a genuine continuous leak into tidy 1-reading "runs" —
  // hiding exactly what we are hunting. Default gap is 5 min, comfortably above the tick interval.
  const spec = [];
  for (let m = 0; m <= 90; m += 3) spec.push([m, 1]);
  const r = rules.current_run(reads(spec), NOW, cfg);
  assert.strictEqual(r.level, 'continuous');
  assert.ok(r.minutes >= 90, 'expected one 90-minute run, got ' + r.minutes);
});

test('run: zero-delta readings are not flow', function () {
  const r = rules.current_run(reads([[1, 0], [2, 0], [3, 0]]), NOW, cfg);
  assert.strictEqual(r.flowing, false);
});

test('run: a run reaching the oldest row we can see is reported as "at least"', function () {
  // Never invent a start time. If the run fills the window, say so and let the UI say "at least".
  const spec = [];
  for (let m = 0; m <= 200; m += 2) spec.push([m, 1]);
  const r = rules.current_run(reads(spec), NOW, cfg);
  assert.strictEqual(r.truncated, true);
});

test('run: the gap threshold is configurable', function () {
  const tight = Object.assign({}, cfg, { run_gap_min: 1 });
  const spec = [[0, 1], [3, 1], [6, 1]];             // a tick every 3 minutes
  assert.strictEqual(rules.current_run(reads(spec), NOW, tight).minutes, 0, 'a 1-min gap splits it');
  assert.ok(rules.current_run(reads(spec), NOW, cfg).minutes >= 6, 'the 5-min default holds it together');
});

test('status: the banner cannot say "All clear" while water runs continuously', function () {
  // The contradiction this closes: check_continuous works in whole hours and needs six of them, so
  // a toilet that has been running for 75 minutes left the banner reading "All clear" directly
  // above a card reading "CONTINUOUS FLOW". A monitor whose two answers disagree teaches you to
  // trust neither.
  const quiet = { '2026-08-01T06': 0 };
  const run = { flowing: true, level: 'continuous', minutes: 75, gallons: 75, rate: 1, truncated: false };
  const s = rules.status({ hours: quiet, now: MORNING, cfg: cfg, tz: TZ, last_read_at: new Date(MORNING.getTime() - 60000), run: run });
  assert.strictEqual(s.state, 'leak');
  assert.match(s.headline, /running continuously/i);
  assert.match(s.detail, /75 min/);
});

test('status: a normal-length run does NOT trip the banner', function () {
  // A shower must not put the dashboard into a leak state, or the state means nothing.
  const run = { flowing: true, level: 'running', minutes: 9, gallons: 18, rate: 2 };
  const s = rules.status({ hours: {}, now: MORNING, cfg: cfg, tz: TZ, last_read_at: new Date(MORNING.getTime() - 60000), run: run });
  assert.strictEqual(s.state, 'ok');
});

test('status: silence still outranks a run — being blind is worse', function () {
  const run = { flowing: true, level: 'continuous', minutes: 200, gallons: 200, rate: 1 };
  const old = new Date(MORNING.getTime() - 500 * 60000);
  const s = rules.status({ hours: {}, now: MORNING, cfg: cfg, tz: TZ, last_read_at: old, run: run });
  assert.strictEqual(s.state, 'offline', 'a stale run reading must not mask a dead receiver');
});

// ───────────────────────── run_spans (the red bands on the chart) ─────────────────────────

test('run_spans: no flow means no spans', function () {
  assert.deepStrictEqual(rules.run_spans([], cfg), []);
  assert.deepStrictEqual(rules.run_spans(reads([[5, 0], [9, 0]]), cfg), []);
});

test('run_spans: two showers separated by a gap are TWO runs', function () {
  // The whole point of the function: current_run only ever sees the newest one. A chart that
  // merged these would draw one 40-minute band across a period when nothing was running.
  const spec = [];
  for (let m = 0; m <= 8; m++) spec.push([m, 2]);          // recent, 8 min
  for (let m = 40; m <= 50; m++) spec.push([m, 2]);        // earlier, 10 min
  const spans = rules.run_spans(reads(spec), cfg);
  assert.strictEqual(spans.length, 2);
  assert.strictEqual(spans[0].minutes, 10, 'oldest first');
  assert.strictEqual(spans[1].minutes, 8);
});

test('run_spans: levels match the thresholds', function () {
  const short = [], long = [], alarm = [];
  for (let m = 200; m <= 210; m++) short.push([m, 1]);     // 10 min
  for (let m = 100; m <= 140; m++) long.push([m, 1]);      // 40 min
  for (let m = 0; m <= 70; m++) alarm.push([m, 1]);        // 70 min
  const spans = rules.run_spans(reads(short.concat(long).concat(alarm)), cfg);
  assert.deepStrictEqual(spans.map(function (s) { return s.level; }), ['running', 'long', 'continuous']);
});

test('run_spans: a slow leak stays ONE span, not many short ones', function () {
  // Same trap as current_run: at 0.4 gal/min the meter only ticks every ~2.5 min. A gap threshold
  // below that would chop a genuine 90-minute leak into 30 innocent-looking bands.
  const spec = [];
  for (let m = 0; m <= 90; m += 3) spec.push([m, 1]);
  const spans = rules.run_spans(reads(spec), cfg);
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].level, 'continuous');
});

test('run_spans: agrees with current_run about the newest run', function () {
  // Two functions, one definition of "a run". If these ever disagree the banner and the chart
  // contradict each other, which is the failure mode we already fixed once.
  const spec = [];
  for (let m = 0; m <= 75; m++) spec.push([m, 1]);
  const now = rules.current_run(reads(spec), NOW, cfg);
  const spans = rules.run_spans(reads(spec), cfg);
  const newest = spans[spans.length - 1];
  assert.strictEqual(newest.level, now.level);
  assert.strictEqual(newest.gallons, now.gallons);
});
