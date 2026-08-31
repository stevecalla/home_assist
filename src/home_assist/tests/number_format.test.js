'use strict';
/**
 * number_format.test.js — thousands separators, and the two places they must NOT appear.
 *
 * A source scan rather than a render, because the bug is not "this component prints the wrong
 * string": it is that `toFixed()` was doing the formatting at ~20 sites and toFixed never groups,
 * at any magnitude. That is invisible in every test that checks a small number, and a monthly total
 * is the one figure that is always large.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web', 'src');
const WATER = path.join(WEB, 'modules', 'water');

function read(p) { return fs.readFileSync(p, 'utf8'); }
// Comments describe the rule and quote the thing being forbidden. Scanning them finds the
// explanation and reports it as the offence -- twice now.
function code(p) {
  return read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// lib/num.js is ESM (everything under web/ is) and this suite is CommonJS, which is the split the
// whole repo is built on. Rather than add a build step to the test run -- which would cost the
// ~1s startup that makes `npm run home_assist_test` something you actually run before a deploy --
// the module is loaded by stripping its `export` keywords and evaluating it. The assertions below
// are then against the real implementation, not a copy of it.
function load_num() {
  const src = read(path.join(WEB, 'lib', 'num.js')).replace(/^export /gm, '');
  return new Function(src + '\nreturn { num, gal };')();   // eslint-disable-line no-new-func
}

test('there is one formatter, and it groups from four digits', function () {
  const { num, gal } = load_num();
  assert.strictEqual(num(2480), '2,480');
  assert.strictEqual(num(999), '999', 'three digits are left alone');
  assert.strictEqual(num(1000), '1,000');
  assert.strictEqual(num(2480.4, 1), '2,480.4');
  assert.strictEqual(num(147), '147');

  // "No data" and "zero" mean opposite things on a leak monitor, so a non-number renders as the
  // same em dash the rest of the UI uses and never as 0 or NaN.
  assert.strictEqual(num(null), '—');
  assert.strictEqual(num(undefined), '—');
  assert.strictEqual(num(NaN), '—');
  assert.strictEqual(num(0), '0', 'but a real zero is a real reading');

  // Sub-10 volumes keep a decimal: overnight, 0 gal and 0.4 gal are a meaningful difference.
  assert.strictEqual(gal(0.4), '0.4');
  assert.strictEqual(gal(2480), '2,480');
});

test('no gallon is printed through toFixed any more', function () {
  // The whole class, not the one site that was reported. A volume reaches the screen as
  // "<something> gal", so that is what is forbidden -- precisely, rather than by guessing at
  // variable names. What legitimately remains is a RATE (gal/min, gal/hour), which is never four
  // digits, plus signal levels, percentages, frequencies, SVG coordinates and CSV cells.
  const files = ['Monitor.jsx', 'History.jsx', 'Alerts.jsx', 'Diagnostics.jsx', 'BarChart.jsx',
    'HeartbeatChart.jsx', 'RealtimeChart.jsx'];
  for (const f of files) {
    const src = code(path.join(WATER, f));
    // toFixed(n), then at most a dozen characters of punctuation, then the unit -- but not
    // "gal/min" or "gal/hour", which are rates and are meant to stay as they are.
    const hits = src.match(/toFixed\(\d\)[^\n]{0,12}?gal(?!\/)/g) || [];
    assert.deepStrictEqual(hits, [],
      f + ' still formats a volume with toFixed: ' + hits.join(' | '));
  }
});

test('the CSV rows stay ungrouped', function () {
  // A grouped number is written to the file quoted and lands in a spreadsheet as TEXT: the column
  // stops summing. These arrays are data, and the same array also feeds the on-screen flip table,
  // which is why the temptation to format them here is real.
  const src = read(path.join(WATER, 'Monitor.jsx'));
  assert.match(src, /const lvRows = lv \? lv\.series\.map\(\(d\) => \[d\.day_key, d\.gallons\.toFixed\(1\)/);
  assert.match(src, /CSV/, 'and the reason is written down beside them');
});

test('SVG path coordinates stay ungrouped', function () {
  // Path data is space- and comma-delimited. A grouped coordinate does not draw a wrong chart, it
  // draws no chart -- and it would fail silently, with an empty box where the reading should be.
  for (const f of ['HeartbeatChart.jsx', 'RealtimeChart.jsx']) {
    const src = code(path.join(WATER, f));
    assert.match(src, /`M\$\{px\.toFixed\(1\)\}/, f + ' must keep raw path coordinates');
    assert.ok(src.indexOf('num(px') === -1, f + ' must not group a coordinate');
  }
});

test('every file that formats a volume imports the formatter', function () {
  // A local copy of the rule is how two pages start disagreeing about what a number looks like.
  for (const f of ['Monitor.jsx', 'History.jsx', 'Alerts.jsx', 'Diagnostics.jsx', 'BarChart.jsx',
    'HeartbeatChart.jsx', 'RealtimeChart.jsx']) {
    assert.match(code(path.join(WATER, f)), /from '\.\.\/\.\.\/lib\/num\.js'/, f);
  }
  assert.match(code(path.join(WEB, 'pages', 'Home.jsx')), /from '\.\.\/lib\/num\.js'/);
});
