#!/usr/bin/env node
/**
 * hf_scan.js — is anything audible on medium wave via direct sampling?
 *
 *   node src/home_assist/modules/water/hf_scan.js
 *   node src/home_assist/modules/water/hf_scan.js --seconds 4
 *   node src/home_assist/modules/water/hf_scan.js --files a.iq b.iq
 *
 * PHASE 1 OF TWO, AND A GATE RATHER THAN A FEATURE.
 *
 * An RTL-SDR's tuner stops around 24 MHz, so the AM broadcast band (530-1700 kHz) is only reachable
 * by DIRECT SAMPLING: bypassing the tuner and reading the ADC pin. Whether a given board routes that
 * pin is a hardware question, and the honest way to answer it is to measure, not to read a spec
 * sheet. Building a demodulator first and discovering the pin is dead afterwards is the expensive
 * order to do this in.
 *
 * WHAT MAKES THE ANSWER TRUSTWORTHY. AM broadcast carriers sit on EXACT 10 kHz multiples in the US.
 * A handful of peaks landing on that grid cannot happen by chance -- noise, switching-supply hash
 * and USB interference all land wherever they like. So the test is not "is there energy" (there is
 * always energy) but "is the energy on the grid". That is what turns a spectrum into evidence.
 *
 * THE PACKING AMBIGUITY, RESOLVED BY MEASUREMENT. In direct sampling the byte stream's meaning is
 * genuinely ambiguous: it may be complex I/Q pairs at the configured rate (Nyquist = rate/2, so
 * 1.48 MHz folds back), or independent real samples at twice that (Nyquist = rate, so 1.48 MHz sits
 * directly in band). Rather than assert one, this scores BOTH against the channel grid and reports
 * which fits. The interpretation that lines up with real stations is the correct one, and if
 * neither does, that is its own answer.
 *
 * WHY TWO CAPTURES AT DIFFERENT SAMPLE RATES. The grid test alone is not enough, and a synthetic
 * check proved it: FOLDING A 10 kHz GRID LANDS YOU BACK ON THE 10 kHz GRID. Read a real-sample
 * stream as complex and every station aliases to another exact 10 kHz multiple, so the wrong
 * interpretation scores just as well as the right one and looks equally convincing.
 *
 * The discriminator is that ALIASES MOVE WHEN THE SAMPLE RATE CHANGES AND REAL SIGNALS DO NOT. So
 * this captures twice at different rates and keeps only peaks that appear at the SAME frequency in
 * both. That is what separates a station from an artefact, and it costs one extra two-second
 * capture.
 *
 * Same guard as the NOAA scan: a spectrum flatter than thermal noise means the measurement failed,
 * and is reported as such. "Nothing found" and "nothing measured" are opposite facts.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const { platform_env } = require('../../env');
const rtl433 = require('./collector/rtl433');

const RESET = '\x1b[0m', BOLD = '\x1b[1m', DIM = '\x1b[2m';
const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m';
const c = (color, t) => `${color}${t}${RESET}`;

const PM2_NAME = 'water_collector';

// Two valid device rates, deliberately different. Anything real sits at the same frequency in both;
// an alias shifts, because where it folds to depends on the rate. Both are inside librtlsdr's valid
// 900 ksps - 3.2 Msps window and both run without dropping samples.
const CAPTURE_RATES = [2400000, 2048000];
const STABLE_TOLERANCE_KHZ = 2;
const DEFAULT_SECONDS = 2;
const BLOCK = 32768;            // FFT length; 73 Hz bins at 2.4 Msps — far finer than 10 kHz spacing
const MIN_SPREAD_DB = 1.5;      // below this the chain is flat and nothing was measured

// US AM broadcast: 540-1700 kHz on exact 10 kHz centres. The grid IS the evidence.
const AM_LOW_KHZ = 520;
const AM_HIGH_KHZ = 1710;
const AM_STEP_KHZ = 10;
const GRID_TOLERANCE_KHZ = 2;

// ------------------------------------------------------------------------------------------------
// FFT — iterative radix-2, in place. No dependency; BLOCK is a power of two by construction.

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// Hann window. Without it every carrier smears across neighbouring bins and the grid test -- which
// depends on peaks being sharp and locatable -- stops working.
const WINDOW = new Float64Array(BLOCK);
for (let i = 0; i < BLOCK; i += 1) WINDOW[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (BLOCK - 1));

/**
 * Welch-averaged power spectrum.
 *
 * `complex` true  -> bytes are interleaved I/Q at `rate`; spectrum spans 0 .. rate/2.
 * `complex` false -> bytes are independent real samples at 2*rate; spectrum spans 0 .. rate.
 *
 * Averaging matters: one block of a noisy spectrum has several dB of random bin-to-bin scatter, and
 * a single scatter spike is indistinguishable from a weak carrier. Averaging many blocks flattens
 * the noise and leaves anything persistent standing up.
 */
function spectrum(buf, complex, capture_rate) {
  const rate = complex ? capture_rate : capture_rate * 2;
  const bins = BLOCK / 2;
  const acc = new Float64Array(bins);
  const re = new Float64Array(BLOCK);
  const im = new Float64Array(BLOCK);
  const stride = complex ? BLOCK * 2 : BLOCK;
  let blocks = 0;

  for (let off = 0; off + stride <= buf.length; off += stride) {
    for (let i = 0; i < BLOCK; i += 1) {
      if (complex) {
        re[i] = (buf[off + i * 2] - 127.5) * WINDOW[i];
        im[i] = (buf[off + i * 2 + 1] - 127.5) * WINDOW[i];
      } else {
        re[i] = (buf[off + i] - 127.5) * WINDOW[i];
        im[i] = 0;
      }
    }
    fft(re, im);
    for (let k = 0; k < bins; k += 1) acc[k] += re[k] * re[k] + im[k] * im[k];
    blocks += 1;
    if (blocks >= 200) break;   // plenty of averaging; keeps a long capture from taking minutes
  }
  if (!blocks) return null;

  const bin_hz = rate / BLOCK;
  const out = [];
  for (let k = 1; k < bins; k += 1) {
    out.push({ khz: (k * bin_hz) / 1000, db: 10 * Math.log10(acc[k] / blocks + 1e-12) });
  }
  return { bins: out, rate: rate, bin_hz: bin_hz, blocks: blocks };
}

// ------------------------------------------------------------------------------------------------

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function on_grid(khz) {
  if (khz < AM_LOW_KHZ || khz > AM_HIGH_KHZ) return false;
  const nearest = Math.round(khz / AM_STEP_KHZ) * AM_STEP_KHZ;
  return Math.abs(khz - nearest) <= GRID_TOLERANCE_KHZ;
}

/**
 * Peaks that stand above the local noise, deduplicated so one carrier is one peak rather than the
 * five adjacent bins it actually occupies.
 */
function find_peaks(bins, floor, min_over) {
  const hits = [];
  for (let i = 2; i < bins.length - 2; i += 1) {
    const b = bins[i];
    if (b.db - floor < min_over) continue;
    if (b.db < bins[i - 1].db || b.db < bins[i + 1].db) continue;
    hits.push(b);
  }
  hits.sort((a, b) => b.db - a.db);
  const kept = [];
  for (const h of hits) {
    if (kept.some((k) => Math.abs(k.khz - h.khz) < 5)) continue;
    kept.push(h);
    if (kept.length >= 40) break;
  }
  return kept;
}

function assess(buf, complex, label, capture_rate) {
  const sp = spectrum(buf, complex, capture_rate);
  if (!sp) return null;

  // Only judge the part of the spectrum where AM stations could be. Below ~500 kHz there is
  // enormous switching-supply hash that would dominate a whole-spectrum floor.
  const band = sp.bins.filter((b) => b.khz >= AM_LOW_KHZ - 100 && b.khz <= AM_HIGH_KHZ + 100);
  if (band.length < 50) return null;

  const dbs = band.map((b) => b.db);
  const floor = median(dbs);
  const spread = Math.max.apply(null, dbs) - Math.min.apply(null, dbs);
  const peaks = find_peaks(band, floor, 8);
  const grid = peaks.filter((p) => on_grid(p.khz));

  return {
    label: label,
    complex: complex,
    rate: sp.rate,
    blocks: sp.blocks,
    bin_hz: sp.bin_hz,
    nyquist_khz: sp.rate / 2000,
    floor: floor,
    spread: spread,
    peaks: peaks,
    grid: grid,
    score: grid.length,
  };
}

// ------------------------------------------------------------------------------------------------
// pm2 + capture

function pm2_state() {
  let out;
  try { out = execSync('pm2 jlist', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { return 'no-pm2'; }
  let list;
  try { list = JSON.parse(out); } catch (e) { return 'no-pm2'; }
  const proc = (Array.isArray(list) ? list : []).find((p) => p && p.name === PM2_NAME);
  if (!proc) return 'absent';
  return (proc.pm2_env && proc.pm2_env.status) === 'online' ? 'online' : 'stopped';
}
function pm2_do(verb) {
  try { execSync('pm2 ' + verb + ' ' + PM2_NAME, { stdio: ['ignore', 'ignore', 'ignore'] }); return true; }
  catch (e) { return false; }
}

function resolve_sdr_cmd() {
  const explicit = platform_env('WATER_RTL_SDR_CMD', '');
  if (explicit) return explicit;
  const r433 = rtl433.resolve_cmd();
  if (r433 && (r433.includes('/') || r433.includes('\\'))) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const sibling = path.join(path.dirname(r433), 'rtl_sdr' + ext);
    if (fs.existsSync(sibling)) return sibling;
  }
  return 'rtl_sdr';
}

function capture(seconds, rate, restore_after) {
  const cmd = resolve_sdr_cmd();
  const out = path.join(os.tmpdir(), 'hf_q_capture_' + rate + '.iq');
  // -D with no argument is the older librtlsdr signature; on this build it selects input 2/Q,
  // which is the branch direct-sampling hardware is actually wired to. Newer builds take -D 1|2|3.
  // -f is set even though direct sampling has no mixer: harmless, and it keeps the log readable.
  const args = ['-D', '-f', '1480000', '-s', String(rate), '-n', String(rate * seconds), out];

  console.log(c(DIM, '  $ ' + cmd + ' ' + args.join(' ')));

  const state = pm2_state();
  let restore = false;
  if (state === 'online') {
    process.stdout.write(c(YELLOW, '  Stopping the collector… '));
    if (pm2_do('stop')) { restore = true; console.log(c(YELLOW, 'stopped.')); }
    else console.log(c(RED, 'failed.'));
  }

  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  const log = String(r.stdout || '') + String(r.stderr || '');

  if (restore && restore_after) {
    process.stdout.write(c(YELLOW, '  Restarting the collector… '));
    console.log(pm2_do('start') || pm2_do('restart') ? c(GREEN, 'back up.') : c(RED, 'FAILED.'));
  }

  const branch = log.match(/direct sampling mode, input (\d)(\/([IQ]))?/);
  if (branch) {
    const q = branch[1] === '2';
    console.log('  branch  ' + (q ? c(GREEN, 'input 2 / Q — the one hardware uses')
      : c(RED, 'input ' + branch[1] + ' — NOT the Q branch; results below mean little')));
  }
  if (r.error) {
    console.log(c(RED, '  Could not run ' + cmd + ': ' + r.error.message));
    return null;
  }
  if (/usb_claim_interface/.test(log)) {
    console.log(c(RED, '  Something else has the dongle.'));
    return null;
  }
  if (!fs.existsSync(out)) {
    console.log(c(RED, '  No capture file was written.'));
    if (log.trim()) console.log(c(DIM, log.trim()));
    return null;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------

function report(a) {
  console.log('');
  console.log(c(BOLD, '  ' + a.label));
  console.log(c(DIM, '  ─────────────────────────────────────────────────────────────────'));
  console.log('  covers      ' + c(DIM, '0 – ' + a.nyquist_khz.toFixed(0) + ' kHz') +
    c(DIM, '   (' + a.bin_hz.toFixed(0) + ' Hz bins, ' + a.blocks + ' blocks averaged)'));
  console.log('  noise floor ' + c(DIM, a.floor.toFixed(1) + ' dB'));
  console.log('  spread      ' + c(a.spread < MIN_SPREAD_DB ? RED : DIM, a.spread.toFixed(1) + ' dB'));
  console.log('  peaks       ' + a.peaks.length +
    c(DIM, '  ·  stable across both rates: ') + c(a.stable.length ? BOLD : DIM, String(a.stable.length)) +
    c(DIM, '  ·  stable AND on the 10 kHz grid: ') + c(a.score ? GREEN : DIM, String(a.score)));

  const show = (a.stable.length ? a.stable : a.peaks).slice(0, 12);
  if (show.length) {
    console.log('');
    show.forEach(function (p) {
      const over = p.db - a.floor;
      const bar = '█'.repeat(Math.max(0, Math.min(20, Math.round(over / 2))));
      const grid = on_grid(p.khz);
      const stable = a.stable.some(function (q) { return q.khz === p.khz; });
      const mark = grid && stable ? c(GREEN, '✓') : stable ? c(YELLOW, '~') : c(DIM, '·');
      console.log('   ' + mark + ' ' + p.khz.toFixed(1).padStart(8) + ' kHz  ' +
        (grid && stable ? c(GREEN, bar) : c(DIM, bar)) + '  +' + over.toFixed(1) +
        (grid && stable ? c(GREEN, '   station') : stable ? c(YELLOW, '   stable, off grid') : c(DIM, '   moved with rate — alias')));
    });
  }
}

/**
 * Keep only peaks present at the SAME frequency in both captures.
 *
 * This is the whole reason for two rates. A genuine transmitter is at 850 kHz no matter how fast you
 * sample; an alias is at (rate - f) or (2*rate - f), so changing the rate moves it. Without this the
 * scan cannot tell a station from a folded image -- and because folding a 10 kHz grid lands back on
 * the 10 kHz grid, the grid test alone is fooled completely.
 */
function stable_peaks(a, b) {
  return a.peaks.filter(function (p) {
    return b.peaks.some(function (q) { return Math.abs(q.khz - p.khz) <= STABLE_TOLERANCE_KHZ; });
  });
}

function main() {
  const argv = process.argv.slice(2);
  const si = argv.indexOf('--seconds');
  const seconds = si === -1 ? DEFAULT_SECONDS
    : Math.max(1, Math.min(10, Number(argv[si + 1]) || DEFAULT_SECONDS));
  const fi = argv.indexOf('--files');

  console.log('');
  console.log(c(BOLD + CYAN, '  Medium wave via direct sampling — does the Q branch hear anything?'));
  console.log(c(DIM, '  ═════════════════════════════════════════════════════════════════'));
  console.log(c(DIM, '  US AM stations sit on EXACT 10 kHz centres, 540-1700 kHz. Noise and switching'));
  console.log(c(DIM, '  hash land anywhere, so on-grid energy is evidence. But folding a 10 kHz grid'));
  console.log(c(DIM, '  lands back ON the grid, so that alone can be fooled by aliases — hence two'));
  console.log(c(DIM, '  captures at different sample rates. Real signals stay put; aliases move.\n'));

  let files;
  if (fi !== -1) {
    files = [argv[fi + 1], argv[fi + 2]];
  } else {
    files = [];
    for (let k = 0; k < CAPTURE_RATES.length; k += 1) {
      console.log(c(BOLD, '  Capture ' + (k + 1) + ' of ' + CAPTURE_RATES.length) +
        c(DIM, '  at ' + (CAPTURE_RATES[k] / 1e6).toFixed(3) + ' Msps, ' + seconds + 's'));
      // Only put the collector back after the LAST capture -- restarting it between the two would
      // hand the dongle away and make the second capture fail.
      const f = capture(seconds, CAPTURE_RATES[k], k === CAPTURE_RATES.length - 1);
      if (!f) process.exit(1);
      files.push(f);
      console.log('');
    }
  }

  const bufs = files.map(function (f) {
    if (!f || !fs.existsSync(f)) { console.log(c(RED, '  Missing capture: ' + f)); process.exit(1); }
    return fs.readFileSync(f);
  });

  const options = [
    { complex: true, label: 'If the bytes are complex I/Q pairs' },
    { complex: false, label: 'If the bytes are independent real samples' },
  ];

  const results = options.map(function (opt) {
    const a = assess(bufs[0], opt.complex, opt.label, CAPTURE_RATES[0]);
    const b = assess(bufs[1], opt.complex, opt.label, CAPTURE_RATES[1]);
    if (!a || !b) return null;
    a.stable = stable_peaks(a, b);
    a.score = a.stable.filter(function (p) { return on_grid(p.khz); }).length;
    return a;
  }).filter(Boolean);

  if (!results.length) {
    console.log(c(RED, '  Captures too short to analyse.'));
    process.exit(1);
  }
  results.forEach(report);

  const flat = results.every(function (x) { return x.spread < MIN_SPREAD_DB; });
  const best = results.slice().sort(function (x, y) { return y.score - x.score; })[0];

  console.log('');
  console.log(c(DIM, '  ═════════════════════════════════════════════════════════════════'));
  if (flat) {
    console.log(c(RED, '  ✗ The measurement failed — the spectrum is flatter than thermal noise.'));
    console.log(c(DIM, '    This says NOTHING about what is on the air. Check the dongle is free and'));
    console.log(c(DIM, '    that the capture files are not all zeros.'));
    process.exit(1);
  }
  // THREE OUTCOMES, NOT TWO. The first version needed 3 on-grid carriers before it would say
  // anything positive, which conflated two different questions: "is the ADC pin routed" and "is the
  // antenna any good". ONE stable, on-grid carrier already settles the first -- an alias cannot
  // survive a sample-rate change and interference does not land on exact 10 kHz centres. Reporting
  // that as "almost none on the grid, blame the antenna" buries the finding that actually matters.
  const on_grid_stable = best.stable.filter(function (p) { return on_grid(p.khz); });
  const off_grid_stable = best.stable.filter(function (p) { return !on_grid(p.khz); });

  if (on_grid_stable.length >= 3) {
    console.log(c(GREEN, '  ✓ ' + on_grid_stable.length + ' AM stations, stable across both sample rates and on the 10 kHz grid.'));
    console.log(c(DIM, '    The Q branch works and reception is good. Phase 2 is worth building.'));
  } else if (on_grid_stable.length >= 1) {
    console.log(c(GREEN, '  ✓ THE Q BRANCH WORKS. ' + on_grid_stable.length + ' real AM carrier' +
      (on_grid_stable.length === 1 ? '' : 's') + ' found:'));
    on_grid_stable.forEach(function (p) {
      console.log(c(GREEN, '      ' + p.khz.toFixed(0) + ' kHz, +' + (p.db - best.floor).toFixed(1) + ' dB over the floor'));
    });
    console.log(c(DIM, '\n    That is proof, not a hint: an alias cannot survive a sample-rate change, and'));
    console.log(c(DIM, '    interference does not land on exact 10 kHz centres. The ADC pin is routed and'));
    console.log(c(DIM, '    the whole chain works.'));
    console.log(c(YELLOW, '\n    What is missing is antenna, not hardware.') +
      c(DIM, ' A quarter wave at 1.5 MHz is ~50 m;'));
    console.log(c(DIM, '    a 3-inch whip is electrically nothing there, so only the strongest carriers'));
    console.log(c(DIM, '    get through. Several metres of wire toward a window should bring in many more.'));
  } else if (off_grid_stable.length) {
    console.log(c(YELLOW, '  ? Signals are present and stable, but none sit on the 10 kHz grid.'));
    console.log(c(DIM, '    That is interference — switching supplies, USB, LED drivers — not broadcast.'));
    console.log(c(DIM, '    Antenna first: clip several metres of wire to the antenna centre, run it toward'));
    console.log(c(DIM, '    a window and away from the laptop, then re-run.'));
  } else {
    console.log(c(YELLOW, '  ? Nothing survives the two-rate test.'));
    console.log(c(DIM, '    Everything above the noise moved when the sample rate changed, which makes it'));
    console.log(c(DIM, '    artefact rather than signal. Antenna first — see above. If a long wire changes'));
    console.log(c(DIM, '    nothing, an upconverter is the honest answer.'));
  }

  if (best.stable.length) {
    console.log(c(DIM, '\n    Byte stream reads as: ') + c(BOLD, best.complex ? 'complex I/Q' : 'real samples') +
      c(DIM, '   (settled — phase 2 needs this)'));
  }
  if (off_grid_stable.length && on_grid_stable.length) {
    console.log(c(DIM, '    Off-grid and stable (' +
      off_grid_stable.map(function (p) { return p.khz.toFixed(0); }).join(', ') +
      ' kHz) is local interference, not a station.'));
  }
  console.log('');
  return 0;
}

if (require.main === module) main();

module.exports = { fft, spectrum, on_grid, find_peaks, assess, stable_peaks, CAPTURE_RATES, AM_STEP_KHZ, MIN_SPREAD_DB, BLOCK };
