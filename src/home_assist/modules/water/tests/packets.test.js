'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const rules = require('../rules/leak_rules');

// Packets every `step` seconds starting at `t0`, with optional holes.
function stream(count, step, opts) {
  const o = opts || {};
  const skip = new Set(o.skip || []);
  const t0 = Date.parse('2026-08-01T10:00:00.000Z');
  const out = [];
  for (let i = 0; i < count; i++) {
    if (skip.has(i)) continue;
    out.push({
      heard_at_utc: new Date(t0 + i * step * 1000).toISOString(),
      heard_at_mtn: '2026-08-01 04:00:00',
      snr: o.snr ? o.snr(i) : 21,
    });
  }
  return out;
}

// ── median_interval ──────────────────────────────────────────────────────────────────────────

test('the packet interval is measured, not assumed', function () {
  assert.strictEqual(rules.median_interval(stream(30, 4)), 4);
  assert.strictEqual(rules.median_interval(stream(30, 7.5)), 7.5);
});

test('a long dropout does not drag the interval up', function () {
  // THE reason this is a median and not a mean. One 60s hole in a 4s stream pulls a mean to ~6s,
  // and a gap detector keyed on 3x that would stop calling 15-second silences gaps at all — the
  // outliers would quietly redefine "normal" and the detector would go blind to the tail.
  const pkts = stream(40, 4, { skip: [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34] });
  assert.strictEqual(rules.median_interval(pkts), 4);
});

test('too few packets falls back to the nominal interval rather than dividing by nothing', function () {
  assert.strictEqual(rules.median_interval([]), 4);
  assert.strictEqual(rules.median_interval(stream(2, 4)), 4);
});

// ── gap_spans ────────────────────────────────────────────────────────────────────────────────

test('an unbroken stream has no gaps', function () {
  assert.deepStrictEqual(rules.gap_spans(stream(40, 4), 4), []);
});

test('a dropout is reported with its length and how many were missed', function () {
  const pkts = stream(20, 4, { skip: [10, 11, 12] });   // 16 s between packet 9 and packet 13
  const gaps = rules.gap_spans(pkts, 4);
  assert.strictEqual(gaps.length, 1);
  assert.strictEqual(gaps[0].seconds, 16);
  assert.strictEqual(gaps[0].missed, 3);
});

test('normal jitter is not a gap', function () {
  // One interval of 8s in a 4s stream is 2x — under the 3x threshold. A detector that flagged this
  // would produce a gap list nobody reads, which is the same as having no gap list.
  const pkts = stream(20, 4, { skip: [10] });
  assert.deepStrictEqual(rules.gap_spans(pkts, 4), []);
});

test('a gap carries the signal either side, because that is the diagnosis', function () {
  // Signal collapsing across a gap is a path problem — something moved, something got wet. Signal
  // unchanged across a gap is interference or a stalled receiver. The number alone cannot tell you
  // which; the pair can.
  const pkts = stream(20, 4, { skip: [10, 11, 12], snr: (i) => (i < 10 ? 21 : 11) });
  const g = rules.gap_spans(pkts, 4)[0];
  assert.strictEqual(g.snr_before, 21);
  assert.strictEqual(g.snr_after, 11);
});

test('the gap threshold scales with the measured interval', function () {
  // A 20-second endpoint has a 60-second threshold. Hardcoding "anything over 12s is a gap" would
  // report a continuous gap on any meter that does not transmit every 4 seconds.
  const pkts = stream(20, 20, { skip: [10] });          // 40 s hole, 2x — not a gap at this cadence
  assert.deepStrictEqual(rules.gap_spans(pkts, 20), []);
});

// ── signal bands ─────────────────────────────────────────────────────────────────────────────

test('signal bands name the number instead of just printing it', function () {
  assert.strictEqual(rules.signal_band('snr', 22).level, 'strong');
  assert.strictEqual(rules.signal_band('snr', 14).level, 'ok');
  assert.strictEqual(rules.signal_band('snr', 9).level, 'weak');
  assert.strictEqual(rules.signal_band('snr', 4).level, 'poor');
});

test('rssi bands run the right way round for a negative scale', function () {
  // The trap: -9 is STRONGER than -20. A naive ascending comparison inverts the whole badge and
  // reports a healthy antenna as failing.
  assert.strictEqual(rules.signal_band('rssi', -9).level, 'strong');
  assert.strictEqual(rules.signal_band('rssi', -20).level, 'weak');
  assert.ok(rules.signal_band('rssi', -9).min > rules.signal_band('rssi', -20).min);
});

test('a missing reading is not a bad reading', function () {
  // -M level off means NULL, not zero. Rendering "poor" for a column the radio never reported
  // would send someone onto the roof to fix an antenna that is fine.
  assert.strictEqual(rules.signal_band('snr', null), null);
  assert.strictEqual(rules.signal_band('snr', undefined), null);
});

// ── decode rate ──────────────────────────────────────────────────────────────────────────────

test('decode rate counts against what SHOULD have arrived', function () {
  const r = rules.decode_rate(stream(90, 4), 4, 3600);   // 90 heard, 900 expected in an hour
  assert.strictEqual(r.expected, 900);
  assert.strictEqual(Math.round(r.pct), 10);
});

test('decode rate never exceeds 100% when more arrived than predicted', function () {
  const r = rules.decode_rate(stream(100, 4), 4, 100);
  assert.ok(r.pct <= 100);
});

// ── wiring ───────────────────────────────────────────────────────────────────────────────────

test('every packet column has a tooltip, and the tooltip says what good looks like', function () {
  // A header tooltip that only restates the column name is decoration. The signal columns are the
  // ones people cannot interpret unaided, so those must carry an actual threshold.
  const src = fs.readFileSync(require.resolve('../api'), 'utf8');
  const block = src.slice(src.indexOf('const PACKET_COLUMNS'), src.indexOf('function packets_sql'));
  ['heard_at_mtn', 'meter_id', 'volume', 'delta', 'flags_1', 'flags_2', 'integrity',
    'rssi', 'snr', 'noise', 'freq_mhz'].forEach(function (k) {
    assert.ok(block.indexOf("key: '" + k + "'") !== -1, k + ' must be a defined column');
  });
  const helps = block.match(/help: '[^']+'/g) || [];
  assert.strictEqual(helps.length, 11, 'every column needs a help string');
  helps.forEach(function (h) {
    assert.ok(h.length > 90, 'a one-line tooltip that restates the label helps nobody: ' + h);
  });
  ['rssi', 'snr'].forEach(function (k) {
    const i = block.indexOf("key: '" + k + "'");
    const seg = block.slice(i, i + 700);
    assert.match(seg, /\d/, k + ' tooltip must name an actual threshold, not just describe the field');
  });
});

test('the decoder field names the radio actually uses are the ones we read', function () {
  // Found on live hardware: `integrity` and `freq_mhz` were NULL for every row while rssi/snr/noise
  // populated fine. Two separate causes, and both are the same class of mistake — assuming a JSON
  // key instead of checking one.
  //
  //   integrity  rtl_433 reports the checksum result as `mic` on every decoder. The code read
  //              `Integrity`, which is what our own SYNTHETIC replay meter emits and nothing else
  //              does. Replay populated the column; the real radio did not. A bug that only exists
  //              on hardware is exactly the one a replay-mode test cannot catch, so this asserts on
  //              the field LIST rather than on behaviour.
  //   freq       for an FSK protocol the tone frequencies come back as freq1/freq2, not freq.
  const run = fs.readFileSync(require.resolve('../collector/run'), 'utf8');

  const integ = run.match(/const INTEGRITY_FIELDS = \[([^\]]+)\]/);
  assert.ok(integ, 'INTEGRITY_FIELDS must exist');
  assert.match(integ[1], /'mic'/, "rtl_433 reports the checksum as `mic` — it must be in the list");
  assert.ok(integ[1].indexOf("'mic'") < integ[1].indexOf("'Integrity'"),
    'mic must come BEFORE Integrity: the real radio wins over the synthetic one');

  const freq = run.match(/const FREQ_FIELDS = \[([^\]]+)\]/);
  assert.ok(freq, 'FREQ_FIELDS must exist');
  assert.match(freq[1], /'freq1'/, 'FSK protocols report freq1/freq2, not freq');
});

test('the frequency tooltip says which -M flag it needs', function () {
  // Modulation, Frequency, RSSI, SNR and Noise all arrive from the ONE flag `-M level`. Without
  // that sentence a permanently blank column reads as a broken feature rather than an unset flag.
  const api = fs.readFileSync(require.resolve('../api'), 'utf8');
  const i = api.indexOf("key: 'freq_mhz'");
  assert.ok(i !== -1, 'freq_mhz must be a defined column');
  assert.match(api.slice(i, i + 900), /-M level/, 'the tooltip must name the flag it requires');
});

test('the default decoder args never pass -M freq', function () {
  // `rtl_433 -M help` lists exactly: time|protocol|level|noise|stats|bits. `freq` is NOT among them.
  // Passing it is not a harmless no-op — rtl_433 rejects the unknown value and the run comes back
  // with NO signal metadata at all, so rssi/snr/freq are all null and it reads as a dead antenna.
  // This test exists because that flag shipped in DEFAULT_ARGS and cost a debugging session.
  const rtl = fs.readFileSync(require.resolve('../collector/rtl433'), 'utf8');
  const m = rtl.match(/const DEFAULT_ARGS = '([^']+)'/);
  assert.ok(m, 'DEFAULT_ARGS must be a plain string literal');
  assert.match(m[1], /-M level/, '-M level supplies every signal column the UI draws');
  assert.doesNotMatch(m[1], /-M\s+freq/, '-M freq is not a valid rtl_433 option');
});

test('packets are flushed on their own fast timer, not on the 60-second tick', function () {
  // The bug this pins: the buffer was flushed inside tick(), so water_packets gained rows once a
  // MINUTE in batches of fifteen. The Real time tab polled every four seconds and correctly showed
  // nothing for fifty-six of them, then fifteen rows at once. A live view fed by a once-a-minute
  // write is not live, no matter how fast the browser asks.
  const run = fs.readFileSync(require.resolve('../collector/run'), 'utf8');

  const m = run.match(/PACKET_FLUSH_MS\s*=\s*([^;]+);/);
  assert.ok(m, 'run.js must declare PACKET_FLUSH_MS');
  const flush_ms = Function('return (' + m[1] + ')')();
  assert.ok(flush_ms <= 10000, 'a flush slower than 10s is not a real-time view (' + flush_ms + 'ms)');

  const tickm = run.match(/TICK_MS\s*=\s*([^;]+);/);
  const tick_ms = Function('return (' + tickm[1] + ')')();
  assert.ok(flush_ms < tick_ms, 'the packet flush must be faster than the rule tick');

  assert.match(run, /setInterval\(function \(\) \{ flush_packets\(\); \}, PACKET_FLUSH_MS\)/,
    'the flush needs its own interval');
  // And it must be torn down, or a restarted collector leaks a timer writing from a dead buffer.
  const stop = run.slice(run.indexOf('async stop()'));
  assert.match(stop, /clearInterval\(packet_timer\)/, 'stop() must clear the packet timer');

  const tickBody = run.match(/async function tick\([\s\S]*?\n  }\n/);
  assert.ok(tickBody, 'tick() must exist');
  assert.ok(tickBody[0].indexOf('record_packets') === -1,
    'the tick must NOT be what flushes packets — that is the once-a-minute bug');
});

test('the decode rate is measured against the window, not the fetched slice', function () {
  // The bug: the UI divided the number of ROWS IT RECEIVED by the number expected in the whole
  // window. At 24 hours the fetch is capped well below what the radio actually heard, so a healthy
  // antenna reported ~29% decoded — indistinguishable from genuinely losing two packets in three,
  // which is exactly the fault this screen exists to detect. The denominator was right; the
  // numerator was a LIMIT clause.
  const api = fs.readFileSync(require.resolve('../api'), 'utf8');
  const block = api.slice(api.indexOf("app.get('/api/water/packets'"), api.indexOf("// ── reception:"));

  assert.match(block, /readings\.packet_count\(/, 'the endpoint must COUNT the window');
  assert.match(block, /decode: rules\.decode_rate\(\{ length: counts\.ours \}/,
    'decode_rate must be fed the window COUNT, not the returned array');
  assert.match(block, /truncated: counts\.total > packets\.length/,
    'the response must say when it returned less than the window holds');

  const ui = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/Monitor.jsx'), 'utf8');
  assert.match(ui, /rt\.decode\.pct/, 'the UI must use the server-computed rate');
  assert.ok(ui.indexOf('rtMine.length / rtExpected') === -1,
    'the UI must not recompute the rate from the fetched array');
});

test('the grid caps what it paints and says what it left out', function () {
  // 6,000 rows x 12 cells is 72,000 DOM elements — enough to make sorting stutter, for rows nobody
  // scrolls to. Capping is correct; capping SILENTLY is the bug, because "800 rows" then reads as
  // "that is all there was".
  const grid = fs.readFileSync(
    require.resolve('../../../web/src/components/DataGrid.jsx'), 'utf8');
  assert.match(grid, /renderLimit\s*=\s*\d+/, 'the grid needs a render cap');
  assert.match(grid, /sorted\.slice\(0, renderLimit\)/, 'the cap must actually be applied');
  assert.match(grid, /in window/, 'the footer must report the true window size');
  assert.match(grid, /windowNote/, 'a truncated grid must explain itself');
});

test('a boolean setting can actually be turned OFF', function () {
  // The bug: `coerce` had branches for int and float and nothing for bool, so a bool fell through
  // to String(raw) — and "0" is a TRUTHY string in JavaScript. Every switch read as ON no matter
  // what was saved, so there was no way to stop packet capture from the Settings page at all. It
  // surfaced because someone typed 3 into what looked like a number box and it still worked.
  const settings = require('../store/settings');
  assert.strictEqual(settings.coerce('bool', '0', 1), 0, '"0" must be OFF, not a truthy string');
  assert.strictEqual(settings.coerce('bool', 0, 1), 0);
  assert.strictEqual(settings.coerce('bool', '1', 0), 1);
  assert.strictEqual(settings.coerce('bool', 'false', 1), 0);
  assert.strictEqual(settings.coerce('bool', 'off', 1), 0);
  assert.strictEqual(settings.coerce('bool', '3', 0), 1, 'any non-zero number is on');
  assert.strictEqual(settings.coerce('bool', '', 1), 1, 'blank falls back to the default');

  // And the form must offer a switch, not a free-text number box — typing 3 into an on/off is not
  // a user error, it is the control never having said what it wanted.
  const ui = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/Settings.jsx'), 'utf8');
  assert.match(ui, /f\.type === 'bool'/, 'the Settings form must special-case bool');
  assert.match(ui, /role="switch"/, 'a bool needs a switch');
});

test('the decode rate is measured over the span recorded, not the span requested', function () {
  // Enable packet recording, open the 24h view three hours later, and the old code reported 13.9%
  // decoded — which reads as "the radio is missing six packets in seven". The real answer was "we
  // have been recording for three of these twenty-four hours". Same number, opposite conclusions,
  // and the alarming one was on screen. Coverage and reception are different facts.
  const api = fs.readFileSync(require.resolve('../api'), 'utf8');
  const block = api.slice(api.indexOf("app.get('/api/water/packets'"), api.indexOf('// ── reception:'));
  assert.match(block, /coverage\.seconds/, 'decode must divide by the COVERED span');
  assert.ok(block.indexOf('decode_rate({ length: counts.ours }, interval, hours * 3600)') === -1,
    'dividing by the requested window is the bug');
  assert.match(block, /partial: covered < window_seconds/, 'the response must flag a partial window');
  assert.match(block, /first_mtn/, 'and say when recording actually started');
});

test('every metric on the Monitor card carries a definition', function () {
  // The table headers had tooltips and the readout numbers above them did not, which is what left
  // "13.9%" unexplained on screen. Each entry also names the SETTING behind it where one exists,
  // so "where do I change this" is answerable from the number rather than by hunting Settings.
  const ui = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/Monitor.jsx'), 'utf8');
  const block = ui.slice(ui.indexOf('const METRIC_HELP'), ui.indexOf('function fmtDur'));
  ['reading', 'since', 'shown', 'interval', 'decoded', 'snr', 'gaps',
    'today', 'overnight', 'last24', 'avg', 'run'].forEach(function (k) {
    assert.ok(block.indexOf(k + ':') !== -1, 'METRIC_HELP needs an entry for ' + k);
  });
  const helps = block.match(/: '[^']{40,}'/g) || [];
  assert.ok(helps.length >= 12, 'every metric needs a real sentence, not a restated label');
  // The two that are meaningless without a scale must name actual numbers.
  assert.match(block.slice(block.indexOf('snr:')), /18 dB/);
  assert.match(block.slice(block.indexOf('decoded:')), /95%/);
  // And the retention chip must name the setting it maps to.
  assert.match(ui, /packets_retention_days — Settings/,
    'the "keeping N days" chip must say which setting changes it');
});

test('the collector prunes water_packets in the retention sweep', function () {
  // This table writes a row per transmission — ~21,600 a day. It is bounded by the clock, and only
  // if something actually runs the clock.
  const run = fs.readFileSync(require.resolve('../collector/run'), 'utf8');
  const sweep = run.match(/async function sweep\([\s\S]*?\n  }/);
  assert.ok(sweep, 'run.js must have a retention sweep');
  assert.match(sweep[0], /readings\.prune_packets\(/, 'sweep must prune water_packets');
});

test('neighbouring meters are captured before the filter and counted after it', function () {
  // The safety boundary of this whole feature. If the capture ever moves below the `is_ours` gate
  // the reference signal disappears; if the COUNTING ever moves above it, a neighbour's meter
  // starts advancing your odometer and firing your alerts.
  const run = fs.readFileSync(require.resolve('../collector/run'), 'utf8');
  const capture = run.indexOf('packet_buf.push(');
  const gate = run.indexOf('if (!ours_now) return;');
  assert.ok(capture !== -1 && gate !== -1, 'both the capture and the gate must exist');
  assert.ok(capture < gate, 'capture must happen BEFORE the our-meter gate, or neighbours are lost');
  assert.ok(run.indexOf('pkt_ours++') > gate, 'counting must happen AFTER the gate');
});
