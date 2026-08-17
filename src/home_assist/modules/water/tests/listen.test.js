'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

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

test('the hopping-endpoint modes enable 282 and 290, and say which fired', function () {
  // The whole point is telling 282 from 290 from 223. Without -M protocol every decode is just a
  // model string and the summary could not answer the question the mode exists for.
  for (const key of ['hop', 'hopsweep']) {
    const m = listen.MODES[key];
    assert.ok(m, key + ' must exist');
    assert.match(m.args, /-R 223 -R 282 -R 290/, key + ' must enable all three decoders');
    assert.match(m.args, /-M protocol/, key + ' must record WHICH protocol decoded each packet');
    assert.match(m.args, /-M level/, key + ' still wants rssi/snr/freq');
    assert.ok(m.tally, key + ' must print the endpoint summary');
  }
  // The fixed-window one really is the collector's window -- otherwise "my window only" is a lie.
  assert.match(listen.MODES.hop.args, /-f 916\.45M -s 1600k/);
  // The sweep covers the range rtl_433 DOCUMENTS for these endpoints -- 904.4 to 924.6 MHz -- not
  // the whole ISM band. Same dwell over a fifth less spectrum is more time on each slice that can
  // actually contain one, and dwell is the only lever that matters when chasing a hopper.
  assert.equal(listen.ORION_LOW_MHZ, 904.4);
  assert.equal(listen.ORION_HIGH_MHZ, 924.6);
  const hops = listen.orion_hops();
  // Narrower SPAN, not fewer hops -- the 1600k window is smaller, so covering less spectrum
  // correctly still takes more positions than covering more of it at the wrong rate.
  const span = (hops[hops.length - 1] - hops[0]) + listen.ORION_RATE_KHZ / 1000;
  const generic = listen.hop_centres();
  const generic_span = (generic[generic.length - 1] - generic[0]) + 2.4;
  assert.ok(span < generic_span, 'the Orion range is narrower than the whole ISM band');
  hops.forEach(function (f) {
    assert.ok(listen.MODES.hopsweep.args.indexOf('-f ' + f + 'M') !== -1, f + ' must be in the hop plan');
  });
  // rtl_433 prints "-s 1600k" beside BOTH 282 and 290. A decoder's timing comes from the sample
  // rate, so the wrong rate can mean it never syncs -- zero decodes from a transmitter that is
  // right there, reported as an absent one. This is the one parameter that must not be tuned for
  // coverage.
  assert.equal(listen.ORION_RATE_KHZ, 1600);
  assert.match(listen.MODES.hopsweep.args, /-s 1600k/);
  assert.ok(listen.MODES.hopsweep.args.indexOf('-s 2400k') === -1);
  // The window edges must cover the documented range, or a hop has been cut off.
  const half = listen.ORION_RATE_KHZ / 1000 / 2;
  assert.ok(hops[0] - half <= listen.ORION_LOW_MHZ, 'bottom edge must reach 904.4');
  assert.ok(hops[hops.length - 1] + half >= listen.ORION_HIGH_MHZ, 'top edge must reach 924.6');
});

test('an empty hop result is reported as weak evidence, not as an answer', function () {
  // A hopping endpoint is inside any one 2.4 MHz slice a small fraction of the time. "Nothing
  // found" after four minutes is close to meaningless, and stating it as a conclusion is how you
  // end up confidently wrong about hardware you never actually listened for.
  const src = fs.readFileSync(require.resolve('../listen'), 'utf8');
  const i = src.indexOf('function make_tally');
  assert.ok(i !== -1, 'the summary must exist');
  const body = src.slice(i, src.indexOf('\n  return { on_line, summary };', i));
  assert.match(body, /weak evidence, not a conclusion/);
  assert.match(body, /several full passes/);
  // Keyed on (protocol, id): one endpoint decoded by two protocols is two findings, and collapsing
  // them would hide exactly what is being tested.
  assert.match(body, /const key = proto \+ '\|' \+ id;/);
  // Nothing at all -- not even 223 -- points at the radio, not at the band.
  assert.match(body, /Not even protocol 223/);
});

test('the decoder check reads the WHOLE protocol list, not just Orion lines', function () {
  // The bug this replaces: it filtered `-R help` down to Orion-named lines and THEN looked for
  // 282/290 among them. A protocol 282 that exists under any other name was therefore reported
  // "not in this build" -- a confident answer to a question it had not asked.
  //
  // The list is the authority. 282/290 came from a field note, not from rtl_433, and a check whose
  // conclusion depends on that note being right is not a check.
  const src = fs.readFileSync(require.resolve('../listen'), 'utf8');
  assert.match(src, /function protocol_table\(cmd\)/);
  const t = src.slice(src.indexOf('function protocol_table'), src.indexOf('function present_protocols'));
  // Every numbered line, whatever it is called. The `*` marks disabled-by-default and must not
  // make a protocol invisible.
  assert.ok(t.indexOf(']\\*?') !== -1, 'the parser must tolerate the * disabled-by-default marker');
  assert.ok(t.indexOf('(\\d+)') !== -1, 'and capture the protocol number');

  const chk = src.slice(src.indexOf('function run_check'), src.indexOf('\nfunction main'));
  assert.match(chk, /by name/i, 'name first — it survives the numbers being wrong');
  assert.match(chk, /list\.get\(String\(n\)\)/, 'and report WHAT each number actually is');
  assert.match(chk, /not an Orion decoder/, 'a number that is something else is the useful finding');
});

test('a hop mode drops decoders this build lacks instead of failing to start', function () {
  // rtl_433 EXITS on an unknown -R number. Shipping `-R 282 -R 290` to a build without them meant
  // the mode did not degrade, it refused to run -- and the user sees a usage dump, not an answer.
  const src = fs.readFileSync(require.resolve('../listen'), 'utf8');
  assert.match(src, /if \(mode\.optional_protocols\)/);
  assert.match(src, /arg_text = arg_text\.replace/, 'the missing -R must be removed from the command');
  assert.match(src, /so an empty result says nothing about the hopping endpoints/,
    'and the run must say why its result is not evidence');
  for (const key of ['hop', 'hopsweep']) {
    assert.deepEqual(listen.MODES[key].optional_protocols, [282, 290],
      key + ' must declare which decoders are optional');
  }
  // 223 is NOT optional: without it the mode has no baseline and "nothing heard" cannot be told
  // apart from a dead antenna.
  assert.ok(listen.MODES.hop.optional_protocols.indexOf(223) === -1);
});

test('the antenna readout averages PER METER, against a held baseline', function () {
  // One pooled mean across a 25 dB meter of your own and a 15 dB neighbour describes neither, and
  // it moves when the MIX of packets changes rather than when the antenna does. Walking an aerial
  // around a room while watching that number means chasing which transmitter happened to be louder
  // in the last twenty packets.
  const src = fs.readFileSync(require.resolve('../listen'), 'utf8');
  const f = src.slice(src.indexOf('function make_formatter'), src.indexOf('function print_header'));
  assert.match(f, /const per = new Map\(\)/, 'stats must be kept per meter id');
  assert.match(f, /e\.base === null && snr_avg !== null/,
    'a baseline must be held from the first block — only the delta answers "did that help?"');
  assert.match(f, /n - last_report >= 20/,
    'report on packet count, not a timer: a timer compares a busy 20s against a quiet one');
});
