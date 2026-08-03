'use strict';

const test = require('node:test');
const assert = require('node:assert');

const listen = require('../listen');
const menu = require('../../../menu');

// The sample rate IS the bandwidth: `-f X -s R` hears X ± R/2 and nothing else. These tests pin the
// listening positions against the one edit that would quietly ruin them — "fixing" the nearby
// survey so it covers the meter too, which destroys the whole point of having a window that
// deliberately excludes it.
function window_of(args) {
  const f = args.match(/-f\s+([\d.]+)M/);
  const s = args.match(/-s\s+(\d+)k/);
  assert.ok(f && s, 'every mode needs an explicit -f and -s: ' + args);
  const centre = Number(f[1]);
  const half = Number(s[1]) / 1000 / 2;
  return { low: centre - half, high: centre + half };
}

const METER_MHZ = 916.45;

test('the meter modes actually cover 916.45 MHz', function () {
  for (const key of ['meter', 'wide', 'signal']) {
    const w = window_of(listen.MODES[key].args);
    assert.ok(w.low < METER_MHZ && METER_MHZ < w.high,
      key + ' must cover the meter: ' + w.low.toFixed(3) + '–' + w.high.toFixed(3));
  }
});

test('the neighbourhood survey deliberately EXCLUDES the meter', function () {
  // -f 915M -s 1024k reads like "the 915 band" and is nothing of the sort: 902–928 MHz is 26 MHz
  // wide and this window sees 4% of it, ending 940 kHz below the meter. That is on purpose — it is
  // the proof-of-life command for when your own meter has gone silent. If someone widens it, the
  // mode stops answering the question it exists to answer.
  const w = window_of(listen.MODES.nearby.args);
  assert.ok(METER_MHZ > w.high, 'nearby must NOT reach the meter; got up to ' + w.high.toFixed(3));
  assert.match(listen.MODES.nearby.hears, /NOT your meter/,
    'the exclusion has to be stated in the mode description, not just true');
});

test('only the signal mode asks for JSON, and it asks for -M level', function () {
  assert.match(listen.MODES.signal.args, /-F json/, 'formatted output needs structured input');
  assert.match(listen.MODES.signal.args, /-M level/, 'rssi/snr/freq all come from -M level');
  for (const key of ['meter', 'nearby', 'wide']) {
    assert.doesNotMatch(listen.MODES[key].args, /-F json/, key + ' is meant to be read by a human');
  }
});

test('no listening mode passes -M freq', function () {
  // `rtl_433 -M help`: time|protocol|level|noise|stats|bits. `freq` is not a value, and passing it
  // suppresses the entire metadata set rather than being ignored — rssi/snr/freq all null, which
  // presents as a dead antenna.
  for (const key of Object.keys(listen.MODES)) {
    assert.doesNotMatch(listen.MODES[key].args, /-M\s+freq/, key + ' must not pass -M freq');
  }
});

test('the sweep covers the whole ISM band, with overlapping windows', function () {
  // The point of the sweep is that no part of 902-928 is unreachable. Two ways to get that wrong:
  // leave a hole at an end, or space the hops at exactly the window width so the joins land on the
  // attenuated filter edges. Both are invisible until something you were looking for is missed.
  const hops = listen.hop_centres();
  const half = listen.SWEEP_RATE_KHZ / 1000 / 2;

  assert.ok(hops[0] - half <= listen.SWEEP_LOW_MHZ, 'bottom of the band is not covered');
  assert.ok(hops[hops.length - 1] + half >= listen.SWEEP_HIGH_MHZ, 'top of the band is not covered');

  for (let i = 1; i < hops.length; i += 1) {
    const overlap = (hops[i - 1] + half) - (hops[i] - half);
    assert.ok(overlap > 0, 'gap between hop ' + hops[i - 1] + ' and ' + hops[i]);
    assert.ok(overlap >= 0.3, 'joins must overlap by more than the filter rolloff, got ' + overlap.toFixed(3));
  }
});

test('the sweep asks for -M level so you can tell WHERE a hit landed', function () {
  // Without frequency metadata a hopping scan tells you a device exists and not where it lives,
  // which is the only question the sweep is asked.
  assert.match(listen.MODES.sweep.args, /-M level/);
  assert.ok(/-f /.test(listen.MODES.sweep.args), 'sweep must pass explicit -f positions');
  assert.match(listen.MODES.sweep.args, /-H \d+/, 'multiple -f without -H never actually hops');
});

test('survey modes report customary units; the collector-reference modes do not', function () {
  // -C customary is display only -- Fahrenheit, mph, inches instead of Celsius, m/s, mm. It belongs
  // on the modes where you read a neighbour's weather station. It does NOT belong on `meter` or
  // `signal`, whose whole job is to reproduce the collector's exact arguments: a flag the collector
  // never passes makes them a worse reference, and protocol 223 has no temperature in it.
  for (const key of ['nearby', 'wide', 'sweep']) {
    assert.match(listen.MODES[key].args, /-C customary/, key + ' should report in F/mph/inches');
  }
  for (const key of ['meter', 'signal']) {
    assert.doesNotMatch(listen.MODES[key].args, /-C /, key + ' must mirror the collector exactly');
  }
});

test('menu item numbers are unique', function () {
  // Numbers are assigned by position now. This is the regression that change prevents: inserting a
  // section used to mean renumbering by hand, and a duplicate id makes one item unreachable.
  const ids = menu.ALL.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate menu ids');
  assert.deepEqual(ids, ids.map((_, i) => i + 1), 'ids must be 1..n in display order');
});

test('every menu item has a label, a description and a runnable action', function () {
  for (const it of menu.ALL) {
    assert.ok(it.label, 'menu item missing label');
    assert.ok(it.desc, it.label + ' missing desc');
    assert.ok(it.bin || it.open || it.endpoint || it.docs, it.label + ' does nothing');
  }
});

test('every doc the menu advertises actually exists', function () {
  // The menu prints a ✓/? beside each entry, which is a hint, not a gate. A renamed or never-written
  // doc sits in that list looking real until someone picks it. This is the cheap version of caring.
  const fs = require('node:fs');
  const path = require('node:path');
  // Use the menu's OWN root, not a hand-counted '..' chain from here. Miscounting the depth makes
  // every entry look missing, which is the same failure this file's sibling rule warns about in
  // CLAUDE.md for .env loading.
  const missing = menu.DOCS
    .map((d) => d[0])
    .filter((rel) => !fs.existsSync(path.join(menu.REPO_ROOT, rel.replace(/\/$/, ''))));
  assert.deepEqual(missing, [], 'menu DOCS entries that do not exist on disk');
});
