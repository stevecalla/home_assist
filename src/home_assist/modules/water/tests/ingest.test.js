'use strict';
/**
 * ingest.test.js — the guards between a 900 MHz packet and the database.
 *
 * A packet can pass CRC and still be nonsense. These are the checks that stop one bad reading from
 * poisoning every downstream number, and the impossible-jump case is the subtle one: it must NOT
 * advance the baseline, or the next good packet measures from the corrupt value.
 */
const test = require('node:test');
const assert = require('node:assert');

const ingest = require('../collector/ingest');
const settings = require('../store/settings');

const cfg = settings.defaults();
const T0 = new Date('2026-08-01T12:00:00Z');
const later = (min) => new Date(T0.getTime() + min * 60000);

// ─────────────────────── extract_reading ───────────────────────

test('extract: the CURRENT Badger-ORION shape (volume_gal / mic)', function () {
  // Copied verbatim from the collector's first decoded line, 2026-08-01 00:38:35.
  // rtl_433 renamed these between builds; missing `volume_gal` meant every packet decoded
  // correctly and was then silently discarded — meter working, collector running, nothing recorded.
  const r = ingest.extract_reading({
    time: '2026-08-01 00:38:35', model: 'Badger-ORION', id: 16642655,
    flags_1: 0, volume_gal: 794120, flags_2: 4, mic: 'CRC',
  });
  assert.ok(r, 'must not be null');
  assert.deepStrictEqual({ id: r.id, raw: r.raw, field: r.field, model: r.model, integrity: r.integrity },
    { id: 16642655, raw: 794120, field: 'volume_gal', model: 'Badger-ORION', integrity: 'CRC' });
});

test('extract: the OLDER Badger-ORION shape (Volume / Integrity) still works', function () {
  // What the 2026-07-31 hose test saw. Both builds must keep working — the Ubuntu box may compile
  // a different vintage than the Windows nightly.
  const r = ingest.extract_reading({
    time: '2026-07-31 18:04:12', model: 'Badger-ORION', id: 16642655,
    'Flags-1': 0, Volume: 794120, 'Flags-2': 0, Integrity: 'CRC',
  });
  assert.deepStrictEqual({ id: r.id, raw: r.raw, field: r.field, model: r.model, integrity: r.integrity },
    { id: 16642655, raw: 794120, field: 'Volume', model: 'Badger-ORION', integrity: 'CRC' });
});

test('extract: an unrecognised volume field is NAMED, not silently dropped', function () {
  // The failure mode this exists to prevent: a future rename that looks like "no packets".
  const r = ingest.extract_reading({ model: 'Badger-ORION', id: 16642655, volume_something_new: 794120 });
  assert.ok(r, 'must return a descriptor, not null');
  assert.strictEqual(r.raw, null);
  assert.strictEqual(r.field, 'volume_something_new');
  assert.match(r.error, /unrecognised volume field/);
});

test('extract: a non-gallon unit is REFUSED rather than mis-scaled', function () {
  // Reading cubic metres as gallons would be off by 264x — and would look like a catastrophic
  // leak rather than a bug. Refuse it and say why.
  const r = ingest.extract_reading({ model: 'Badger-ORION', id: 16642655, volume_m3: 3005 });
  assert.strictEqual(r.raw, null);
  assert.match(r.error, /not in gallons/);
});

test('extract: tolerates field-name variants across decoder builds', function () {
  assert.strictEqual(ingest.extract_reading({ id: 1, volume: 500 }).raw, 500);
  assert.strictEqual(ingest.extract_reading({ id: 1, consumption: 501 }).raw, 501);
  assert.strictEqual(ingest.extract_reading({ id: 1, Reading: 502 }).raw, 502);
});

test('extract: numeric strings are accepted', function () {
  assert.strictEqual(ingest.extract_reading({ id: 1, Volume: '794120' }).raw, 794120);
});

test('extract: no volume field means no reading', function () {
  assert.strictEqual(ingest.extract_reading({ id: 1, model: 'Whatever' }), null);
  assert.strictEqual(ingest.extract_reading(null), null);
  assert.strictEqual(ingest.extract_reading('not an object'), null);
});

// ─────────────────────── is_our_meter ───────────────────────

test('meter filter: a neighbour\'s endpoint is ignored', function () {
  // 40462356 is the neighbour's newer frequency-hopping Orion seen during testing.
  assert.strictEqual(ingest.is_our_meter({ id: 40462356 }, 16642655), false);
  assert.strictEqual(ingest.is_our_meter({ id: 16642655 }, 16642655), true);
});

test('meter filter: a decoder that reports no id is accepted', function () {
  assert.strictEqual(ingest.is_our_meter({ id: null }, 16642655), true);
});

// ─────────────────────── evaluate_reading ───────────────────────

test('first reading becomes the baseline and credits nothing', function () {
  const v = ingest.evaluate_reading(null, 794120, T0, cfg);
  assert.strictEqual(v.action, 'baseline');
  assert.strictEqual(v.delta, 0);
  assert.strictEqual(v.advance, true);
});

test('normal flow is credited', function () {
  const v = ingest.evaluate_reading({ gallons: 794120, at: T0 }, 794127, later(6), cfg);
  assert.strictEqual(v.action, 'accept');
  assert.strictEqual(v.delta, 7);           // the actual hose test: 7 counts over ~6 minutes
  assert.strictEqual(v.advance, true);
});

test('no change is accepted with a zero delta', function () {
  const v = ingest.evaluate_reading({ gallons: 794120, at: T0 }, 794120, later(1), cfg);
  assert.strictEqual(v.action, 'accept');
  assert.strictEqual(v.delta, 0);
});

test('a small backward step is ignored but re-baselines', function () {
  const v = ingest.evaluate_reading({ gallons: 794120, at: T0 }, 794118, later(1), cfg);
  assert.strictEqual(v.action, 'backward');
  assert.strictEqual(v.delta, 0);
  assert.strictEqual(v.advance, true, 'must re-baseline, or the next packet credits a phantom +2');
});

test('a huge backward step is treated as a counter rollover', function () {
  const v = ingest.evaluate_reading({ gallons: 999999, at: T0 }, 12, later(1), cfg);
  assert.strictEqual(v.action, 'rollover');
  assert.strictEqual(v.delta, 0);
  assert.strictEqual(v.advance, true);
  assert.match(v.reason, /rollover/);
});

test('an impossible jump is rejected AND does not advance the baseline', function () {
  // 5000 gal in one minute is not plumbing, it is a corrupt packet.
  const v = ingest.evaluate_reading({ gallons: 794120, at: T0 }, 799120, later(1), cfg);
  assert.strictEqual(v.action, 'impossible');
  assert.strictEqual(v.delta, 0);
  assert.strictEqual(v.advance, false, 'advancing here would poison every later delta');
});

test('rapid packets are NOT mistaken for impossible flow', function () {
  // Regression: the meter bubbles up every few seconds. A naive delta/minutes made a legitimate
  // +1 gal one second after the previous packet look like 60 gal/min, so it was rejected — and
  // because rejection does not advance the baseline, the collector went permanently deaf.
  const oneSecond = new Date(T0.getTime() + 1000);
  const v = ingest.evaluate_reading({ gallons: 794120, at: T0 }, 794121, oneSecond, cfg);
  assert.strictEqual(v.action, 'accept');
  assert.strictEqual(v.delta, 1);
  assert.strictEqual(v.advance, true);
});

test('a genuinely corrupt jump is still caught on a short gap', function () {
  const oneSecond = new Date(T0.getTime() + 1000);
  const v = ingest.evaluate_reading({ gallons: 794120, at: T0 }, 794120 + 500, oneSecond, cfg);
  assert.strictEqual(v.action, 'impossible');
  assert.strictEqual(v.advance, false);
});

test('a large but plausible jump over a long gap is accepted', function () {
  // 600 gal over 3 hours = 3.3 gal/min — filling a pool, not a corrupt packet.
  const v = ingest.evaluate_reading({ gallons: 794120, at: T0 }, 794720, later(180), cfg);
  assert.strictEqual(v.action, 'accept');
  assert.strictEqual(v.delta, 600);
});

test('a non-numeric volume is rejected', function () {
  const v = ingest.evaluate_reading({ gallons: 794120, at: T0 }, NaN, later(1), cfg);
  assert.strictEqual(v.action, 'impossible');
  assert.strictEqual(v.advance, false);
});

// ─────────────────────── reading_effects ───────────────────────

test('effects: a zero-flow packet STILL stamps the hour', function () {
  // The regression that matters most in this file. bump_hour used to run only when delta > 0, so an
  // hour in which the collector heard the meter 900 times and nobody ran a tap wrote no row — and a
  // row existing is the ONLY thing that marks an hour `observed`. A perfect quiet night and an
  // unplugged dongle produced an identical chart, and check_continuous / check_overnight saw those
  // hours as missing rather than as zero. On a leak monitor those mean opposite things.
  const v = ingest.evaluate_reading({ gallons: 794120, at: T0 }, 794120, later(1), cfg);
  assert.strictEqual(v.delta, 0);
  const e = ingest.reading_effects(v);
  assert.strictEqual(e.bump_hour, true, 'a quiet hour must still be recorded as observed');
  assert.strictEqual(e.insert, false, 'but there is no per-reading row worth writing');
});

test('effects: flow both stamps the hour and writes a reading', function () {
  const v = ingest.evaluate_reading({ gallons: 794120, at: T0 }, 794127, later(6), cfg);
  assert.deepStrictEqual(ingest.reading_effects(v), { insert: true, bump_hour: true, advance: true });
});

test('effects: a rejected packet touches NOTHING', function () {
  // An impossible jump must not stamp the hour either — recording it as observed would assert we
  // had a trustworthy reading that minute when we explicitly decided we did not.
  const v = ingest.evaluate_reading({ gallons: 794120, at: T0 }, 899999, later(1), cfg);
  assert.deepStrictEqual(ingest.reading_effects(v), { insert: false, bump_hour: false, advance: false });
});

test('effects: the first packet stamps the hour without crediting gallons', function () {
  const v = ingest.evaluate_reading(null, 794120, T0, cfg);
  assert.deepStrictEqual(ingest.reading_effects(v), { insert: false, bump_hour: true, advance: true });
});

test('effects: backward and rollover count as heard', function () {
  // We received a valid packet; the odometer just did something odd. The hour was observed.
  const back = ingest.evaluate_reading({ gallons: 794120, at: T0 }, 794118, later(1), cfg);
  const roll = ingest.evaluate_reading({ gallons: 999999, at: T0 }, 12, later(1), cfg);
  assert.strictEqual(ingest.reading_effects(back).bump_hour, true);
  assert.strictEqual(ingest.reading_effects(roll).bump_hour, true);
  assert.strictEqual(ingest.reading_effects(back).insert, false);
});

test('the baseline survives a burst of corrupt packets', function () {
  // The scenario that matters: garbage arrives, then a good reading. The good reading must measure
  // from the last TRUSTED value, so the real 3 gallons are credited exactly once.
  let last = { gallons: 794120, at: T0 };
  const corrupt = ingest.evaluate_reading(last, 899999, later(1), cfg);
  assert.strictEqual(corrupt.advance, false);
  // baseline unchanged
  const good = ingest.evaluate_reading(last, 794123, later(2), cfg);
  assert.strictEqual(good.action, 'accept');
  assert.strictEqual(good.delta, 3);
});
