'use strict';

const test = require('node:test');
const assert = require('node:assert');

const hf = require('../hf_scan');

test('the FFT puts a known tone in the right bin', function () {
  // Everything downstream -- peak finding, the grid test, the whole conclusion -- rests on this
  // being correct. A transposed index or a sign error would put stations at plausible-looking
  // wrong frequencies, which is worse than an obvious failure.
  const n = 1024;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const k = 37;
  for (let i = 0; i < n; i += 1) re[i] = Math.cos(2 * Math.PI * k * i / n);
  hf.fft(re, im);

  let best = 0, best_p = -1;
  for (let i = 1; i < n / 2; i += 1) {
    const p = re[i] * re[i] + im[i] * im[i];
    if (p > best_p) { best_p = p; best = i; }
  }
  assert.equal(best, k, 'tone at bin ' + k + ' landed in bin ' + best);
});

test('the AM grid test accepts exact channels and rejects everything else', function () {
  // US AM is 540-1700 kHz on exact 10 kHz centres. This is the entire basis for calling a peak a
  // station rather than interference, so the tolerance has to be tight enough to mean something.
  assert.ok(hf.on_grid(850));
  assert.ok(hf.on_grid(1480));
  assert.ok(hf.on_grid(1479.5), 'a bin or two of slop must still count');
  assert.ok(!hf.on_grid(1485), 'halfway between channels is not a station');
  assert.ok(!hf.on_grid(1733.5), 'above the band');
  assert.ok(!hf.on_grid(120), 'below the band');
  assert.equal(hf.AM_STEP_KHZ, 10);
});

test('stability across two sample rates is what separates a station from an alias', function () {
  // The synthetic check that forced this design: folding a 10 kHz grid lands BACK on the 10 kHz
  // grid, so an aliased image scores just as well on the grid test as a real station. Only the
  // rate change tells them apart -- a real transmitter is at 850 kHz however fast you sample.
  const a = { peaks: [{ khz: 850, db: 10 }, { khz: 1480, db: 8 }, { khz: 666.5, db: 9 }] };
  const b = { peaks: [{ khz: 850.4, db: 10 }, { khz: 1479.8, db: 8 }, { khz: 314.5, db: 9 }] };
  const stable = hf.stable_peaks(a, b);
  const khz = stable.map((p) => Math.round(p.khz));
  assert.deepEqual(khz, [850, 1480], 'the peak that moved with the rate must be dropped');
});

test('the two capture rates are different and both are valid device rates', function () {
  // Same rate twice would make every alias look stable and defeat the whole test.
  const [a, b] = hf.CAPTURE_RATES;
  assert.notEqual(a, b, 'two identical rates prove nothing');
  for (const r of hf.CAPTURE_RATES) {
    assert.ok(r >= 900001 && r <= 3200000, r + ' is outside librtlsdr valid sample rates');
  }
});

test('a flat spectrum is a failed measurement, not a negative result', function () {
  assert.ok(hf.MIN_SPREAD_DB >= 1 && hf.MIN_SPREAD_DB <= 4);
});

test('the FFT block is a power of two', function () {
  // Radix-2 silently produces garbage otherwise.
  assert.equal(hf.BLOCK & (hf.BLOCK - 1), 0);
});
