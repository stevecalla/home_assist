#!/usr/bin/env node
/**
 * listen.js — listen to the radio yourself, without the collector in the way.
 *
 *   node src/home_assist/modules/water/listen.js meter     # is MY meter decoding right now
 *   node src/home_assist/modules/water/listen.js nearby    # everything nearby EXCEPT my meter
 *   node src/home_assist/modules/water/listen.js wide      # nearby AND my meter
 *   node src/home_assist/modules/water/listen.js sweep     # hop the whole 902-928 band (discovery)
 *   node src/home_assist/modules/water/listen.js signal    # per-packet rssi/snr for antenna work
 *   node src/home_assist/modules/water/listen.js check     # is protocol 223 even in this build
 *
 * Why this exists rather than "just type the rtl_433 command":
 *
 * 1. THE DONGLE HAS ONE OWNER. The collector holds it. Running rtl_433 alongside it gives you
 *    `usb_claim_interface error -6` and nothing else. This wrapper stops the collector first and
 *    restarts it when you are done -- including on Ctrl-C, which is the case you would otherwise
 *    forget. Leak detection is OFF for the duration; that is unavoidable, so it is stated loudly
 *    and the restart is made automatic rather than remembered.
 *
 * 2. THE BINARY IS PLATFORM-RESOLVED. `rtl_433` on Ubuntu, a full path to
 *    rtl_433_64bit_static.exe on the Windows laptop, both from .env via the same
 *    `WATER_RTL433_CMD[_LINUX|_WINDOWS]` convention the collector uses. Hardcoding `rtl_433` in a
 *    menu entry would work on exactly one of the two machines.
 *
 * 3. NO jq. The `signal` mode formats its own table in Node. jq is not on Git Bash, and a field
 *    guide whose key command only runs on one machine is not a field guide.
 *
 * The frequency arguments here are NOT read from WATER_RTL433_ARGS on purpose. These are fixed,
 * documented listening positions -- if one of them stops hearing something, the answer is the radio
 * or the antenna, not a config change somebody made three weeks ago.
 */
'use strict';

const { spawn, spawnSync, execSync } = require('child_process');
const { createInterface } = require('readline');
const path = require('path');
const rtl433 = require('./collector/rtl433');

const RESET = '\x1b[0m', BOLD = '\x1b[1m', DIM = '\x1b[2m';
const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m';
const c = (color, t) => `${color}${t}${RESET}`;

const PM2_NAME = 'water_collector';

/**
 * The band sweep.
 *
 * 902-928 MHz is the US ISM band, 26 MHz wide. A dongle cannot see it at once: the RTL2832U tops
 * out at 3.2 Msps and only ~2.4 Msps runs without dropping samples on USB 2, so the widest honest
 * window is about a ninth of the band. The answer is to HOP -- rtl_433 takes any number of -f
 * positions and -H seconds of dwell on each.
 *
 * STEP is 2 MHz while the window is 2.4 MHz, on purpose. The outer edges of a tuned window are
 * attenuated by the analog filter rolloff, so butting windows up edge-to-edge leaves weak seams
 * exactly where a transmitter is most likely to be missed. The 400 kHz overlap costs one extra hop
 * and buys clean joins.
 *
 * The first centre is LOW + STEP/2, not LOW: a window centred on 902 would waste half of itself
 * below the band. Starting at 903 puts the bottom edge at 901.8, just under the band floor.
 */
const SWEEP_LOW_MHZ = 902;
const SWEEP_HIGH_MHZ = 928;
const SWEEP_RATE_KHZ = 2400;
const SWEEP_STEP_MHZ = 2;
const SWEEP_DWELL_S = 20;

function hop_centres() {
  const out = [];
  for (let f = SWEEP_LOW_MHZ + SWEEP_STEP_MHZ / 2; f < SWEEP_HIGH_MHZ; f += SWEEP_STEP_MHZ) {
    out.push(Number(f.toFixed(3)));
  }
  return out;
}

const SWEEP_HOPS = hop_centres();
const SWEEP_ARGS = SWEEP_HOPS.map((f) => '-f ' + f + 'M').join(' ') +
  ' -s ' + SWEEP_RATE_KHZ + 'k -M level -H ' + SWEEP_DWELL_S;

/**
 * The listening positions.
 *
 * `window` is not decoration. The sample rate IS the bandwidth: `-f X -s R` hears X +/- R/2 and
 * NOTHING else. A transmitter outside that span is not weak, it is invisible -- which is the single
 * most expensive misunderstanding available here, because it presents as a hardware fault.
 */
const MODES = {
  meter: {
    label: 'Meter check',
    args: '-f 916.45M -s 1600k -R 223',
    window: '915.650 - 917.250 MHz',
    hears: 'your meter only (protocol 223, everything else filtered out)',
    blurb: 'The collector\'s exact tuning, in readable console output. A line every few seconds\n' +
           '  means the radio and the antenna are fine and any dashboard problem is downstream.',
  },
  nearby: {
    label: 'Survey the neighbourhood',
    args: '-f 915M -s 1024k',
    window: '914.488 - 915.512 MHz',
    hears: 'the neighbours\' utility meters and weather stations -- NOT your meter',
    blurb: 'Deliberately does not cover 916.45, so your own meter will never appear here. That is\n' +
           '  correct behaviour, not a fault. Use it to see what else is on the air, and to prove\n' +
           '  the dongle works when your meter has gone quiet.',
  },
  wide: {
    label: 'Survey including my meter',
    args: '-f 916M -s 2400k',
    window: '914.800 - 917.200 MHz',
    hears: 'the neighbours AND your meter, in one window',
    blurb: 'The comparison view. A neighbour\'s transmitter you did not move is a fixed reference:\n' +
           '  if your SNR rises and theirs does not, you improved YOUR path. If both rise, you\n' +
           '  improved the receiver.',
  },
  sweep: {
    label: 'Hop the whole band',
    args: SWEEP_ARGS,
    window: SWEEP_RATE_KHZ / 1000 + ' MHz at a time, ' + SWEEP_HOPS.length + ' positions covering ' +
      SWEEP_LOW_MHZ + ' - ' + SWEEP_HIGH_MHZ + ' MHz',
    hears: 'anything in the ISM band -- eventually. One slice at a time, never all at once',
    hops: SWEEP_HOPS,
    blurb: 'DISCOVERY ONLY. You are listening to any given slice ' + (1 / SWEEP_HOPS.length * 100).toFixed(0) +
      '% of the time, so\n' +
      '  absence here proves nothing. A full sweep takes ' + Math.round(SWEEP_HOPS.length * SWEEP_DWELL_S / 60) +
      ' minutes and the collector is stopped\n' +
      '  throughout. Use it to find out WHERE traffic is, then go listen there properly.',
    warn: 'This holds the dongle for minutes at a time. Leak detection is off for all of it.',
  },
  signal: {
    label: 'Signal figures (antenna work)',
    args: '-f 916.45M -s 1600k -R 223 -F json -M level',
    window: '915.650 - 917.250 MHz',
    hears: 'your meter, one formatted row per packet with rssi / snr / freq',
    blurb: 'What to watch while moving the aerial. Prints a running mean so you are comparing\n' +
           '  positions rather than reacting to one lucky packet.',
    format: true,
  },
};

// -----------------------------------------------------------------------------------------------
// pm2

function pm2_state() {
  // Returns 'online' | 'stopped' | 'absent' | 'no-pm2'.
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
  try { execSync(`pm2 ${verb} ${PM2_NAME}`, { stdio: ['ignore', 'ignore', 'ignore'] }); return true; }
  catch (e) { return false; }
}

// -----------------------------------------------------------------------------------------------
// signal formatting

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function pick(o, names) { for (const n of names) { const v = num(o[n]); if (v !== null) return v; } return null; }

function make_formatter() {
  let n = 0, rssi_sum = 0, rssi_n = 0, snr_sum = 0, snr_n = 0;
  let warned_no_level = false;

  console.log(c(DIM, '   #  time      meter        rssi     snr    freq MHz   reading'));
  console.log(c(DIM, '  ─────────────────────────────────────────────────────────────────'));

  return function (line) {
    if (line.charAt(0) !== '{') { if (line) console.log(c(DIM, '  ' + line)); return; }
    let m;
    try { m = JSON.parse(line); } catch (e) { return; }

    n += 1;
    const t = String(m.time || '').slice(11, 19) || '--:--:--';
    const id = m.id !== undefined ? String(m.id) : (m.Id !== undefined ? String(m.Id) : '?');
    const rssi = pick(m, ['rssi']);
    const snr = pick(m, ['snr']);
    const freq = pick(m, ['freq', 'freq1', 'frequency']);
    const vol = pick(m, ['volume_gal', 'volume', 'Volume', 'consumption', 'consumption_data']);

    if (rssi !== null) { rssi_sum += rssi; rssi_n += 1; }
    if (snr !== null) { snr_sum += snr; snr_n += 1; }

    // The failure this catches: `-M freq` is NOT a valid rtl_433 option, and passing it makes
    // rtl_433 drop the whole metadata set rather than ignore it -- so rssi/snr/freq all arrive
    // null and it reads as a dead antenna. Say so once, on the first bare packet.
    if (!warned_no_level && n >= 3 && rssi_n === 0) {
      warned_no_level = true;
      console.log(c(YELLOW, '\n  No signal metadata on the first few packets.'));
      console.log(c(YELLOW, '  -M level is what supplies Modulation, Frequency, RSSI, SNR and Noise -- all five.'));
      console.log(c(YELLOW, '  If WATER_RTL433_ARGS in .env contains "-M freq", delete it: it is not a valid'));
      console.log(c(YELLOW, '  value and rtl_433 suppresses the entire set rather than ignoring it.\n'));
    }

    const band = snr === null ? '' : snr >= 18 ? c(GREEN, ' strong') : snr >= 12 ? c(GREEN, '     ok') :
      snr >= 8 ? c(YELLOW, '   weak') : c(RED, '   poor');

    console.log(
      '  ' + String(n).padStart(3) + '  ' + t + '  ' + id.padStart(10) + '  ' +
      (rssi === null ? c(DIM, '    --') : rssi.toFixed(1).padStart(6)) + '  ' +
      (snr === null ? c(DIM, '    --') : snr.toFixed(1).padStart(6)) + band + '  ' +
      (freq === null ? c(DIM, '      --') : freq.toFixed(3).padStart(8)) + '   ' +
      (vol === null ? c(DIM, '--') : String(vol))
    );

    if (n % 20 === 0 && (rssi_n || snr_n)) {
      const parts = [];
      if (rssi_n) parts.push('rssi ' + (rssi_sum / rssi_n).toFixed(1));
      if (snr_n) parts.push('snr ' + (snr_sum / snr_n).toFixed(1) + ' dB');
      console.log(c(CYAN, '  ── mean over ' + n + ' packets: ' + parts.join('  ·  ') + ' ──'));
    }
  };
}

// -----------------------------------------------------------------------------------------------

function print_header(key, mode, cmd) {
  console.log('');
  console.log(c(BOLD + CYAN, '  ' + mode.label) + c(DIM, '   (' + key + ')'));
  console.log(c(DIM, '  ─────────────────────────────────────────────────────────────────'));
  console.log('  window  ' + c(BOLD, mode.window));
  console.log('  hears   ' + mode.hears);
  if (mode.hops) {
    // The hop plan is printed as edges, not centres, because the edges are what answer the only
    // question that matters here: "would this have heard X?"
    const half = SWEEP_RATE_KHZ / 1000 / 2;
    console.log('  hops    ' + c(DIM, mode.hops.map((f) => f + 'M').join('  ')));
    console.log('  covers  ' + c(DIM, (mode.hops[0] - half).toFixed(1) + ' - ' +
      (mode.hops[mode.hops.length - 1] + half).toFixed(1) + ' MHz, ' + SWEEP_DWELL_S + 's on each, ' +
      'full sweep every ' + Math.round(mode.hops.length * SWEEP_DWELL_S / 60) + ' min'));
  }
  console.log('');
  console.log('  ' + mode.blurb);
  if (mode.warn) console.log('\n  ' + c(YELLOW, mode.warn));
  console.log('');
  console.log(c(DIM, '  $ ' + cmd + ' ' + mode.args));
  console.log('');
}

function run_check(cmd) {
  console.log('\n  ' + c(BOLD, 'Is the Badger Orion decoder in this build?') + '\n');
  const r = spawnSync(cmd, ['-R', 'help'], { encoding: 'utf8', windowsHide: true });
  const text = String(r.stdout || '') + String(r.stderr || '');
  if (r.error) {
    console.log(c(RED, '  Could not run ' + cmd + ': ' + r.error.message));
    console.log(c(DIM, '  Set WATER_RTL433_CMD (or _LINUX / _WINDOWS) in .env.'));
    return 1;
  }
  const hits = text.split(/\r?\n/).filter((l) => /orion/i.test(l));
  if (hits.length) {
    hits.forEach((l) => console.log(c(GREEN, '  ✓ ' + l.trim())));
    console.log(c(DIM, '\n  Protocol 223 is present. -R 223 will work.'));
    return 0;
  }
  console.log(c(RED, '  ✗ No Orion decoder in this build.'));
  console.log(c(DIM, '  The apt package is often too old. Build rtl_433 from source --'));
  console.log(c(DIM, '  see src/home_assist/plans_and_notes/water/UBUNTU_DEPLOY.md'));
  return 1;
}

function main() {
  const key = (process.argv[2] || '').toLowerCase();
  const cmd = rtl433.resolve_cmd();

  if (key === 'check') { process.exit(run_check(cmd)); }

  const mode = MODES[key];
  if (!mode) {
    console.log('\n  Usage: node ' + path.relative(process.cwd(), __filename) + ' <mode>\n');
    Object.keys(MODES).forEach((k) => {
      console.log('    ' + c(BOLD, k.padEnd(8)) + MODES[k].label + c(DIM, '   ' + MODES[k].window));
    });
    console.log('    ' + c(BOLD, 'check   ') + 'Is protocol 223 in this rtl_433 build (no dongle needed)');
    console.log('');
    process.exit(key ? 1 : 0);
  }

  print_header(key, mode, cmd);

  // --- take the dongle -------------------------------------------------------------------------
  const state = pm2_state();
  let restore = false;

  if (state === 'online') {
    process.stdout.write(c(YELLOW, '  Stopping the collector so this can have the dongle… '));
    if (pm2_do('stop')) { restore = true; console.log(c(YELLOW, 'stopped.')); }
    else console.log(c(RED, 'failed — you will likely get usb_claim_interface error -6.'));
    console.log(c(BOLD + YELLOW, '  LEAK DETECTION IS OFF until you stop this. It restarts automatically on Ctrl-C.'));
  } else if (state === 'no-pm2' || state === 'absent') {
    console.log(c(DIM, '  (No pm2 collector found. If one is running in another terminal, stop it first.)'));
  } else {
    console.log(c(DIM, '  (Collector already stopped — leaving it that way.)'));
  }
  console.log(c(DIM, '\n  Ctrl-C to stop.\n'));

  // --- give it back, exactly once --------------------------------------------------------------
  let restored = false;
  function give_back() {
    if (restored) return;
    restored = true;
    if (!restore) return;
    process.stdout.write(c(YELLOW, '\n  Restarting the collector… '));
    console.log(pm2_do('start') || pm2_do('restart')
      ? c(GREEN, 'back up. You are protected again.')
      : c(RED, 'FAILED — run: npm run pm2_start_water_collector'));
  }

  const args = rtl433.parse_args(mode.args);
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const format = mode.format ? make_formatter() : null;

  child.on('error', function (err) {
    console.log(c(RED, '  Could not start ' + cmd + ': ' + err.message));
    if (err.code === 'ENOENT') console.log(c(DIM, '  Set WATER_RTL433_CMD (or _LINUX / _WINDOWS) in .env.'));
  });

  createInterface({ input: child.stdout }).on('line', function (line) {
    const t = String(line).trim();
    if (format) format(t); else if (t) console.log('  ' + t);
  });

  child.stderr.on('data', function (d) {
    const s = String(d);
    if (/usb_claim_interface error/.test(s)) {
      console.log(c(RED, '\n  Something else already has the dongle.'));
      console.log(c(DIM, '  Usually the collector running outside pm2. Find it: ps aux | grep rtl_433\n'));
    }
    process.stderr.write(d);
  });

  child.on('close', function (code) {
    console.log(c(DIM, '\n  rtl_433 exited (' + code + ').'));
    give_back();
    process.exit(0);
  });

  // SIGINT is the expected exit. Kill the radio and let 'close' restore the collector; the extra
  // give_back() on 'exit' is the belt-and-braces path for a kill that never produces 'close'.
  process.on('SIGINT', function () { try { child.kill(); } catch (e) { /* gone */ } });
  process.on('exit', give_back);
}

if (require.main === module) main();

module.exports = { MODES, pm2_state, hop_centres, SWEEP_LOW_MHZ, SWEEP_HIGH_MHZ, SWEEP_RATE_KHZ };
