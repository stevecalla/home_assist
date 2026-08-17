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

// -C customary makes rtl_433 print Fahrenheit, mph and inches instead of Celsius, m/s and mm.
// Display only -- it converts on output and changes nothing about decoding.
//
// It is on the SURVEY modes (nearby / wide / sweep), where you are reading a neighbour's weather
// station, and deliberately NOT on `meter` or `signal`. Those two exist to reproduce the
// collector's exact tuning as a reference; a flag the collector does not pass would make them a
// worse reference, and nothing on protocol 223 has a temperature in it anyway.
//
// The other values are `-C si` and `-C native` (the default, whatever the decoder emitted).

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
  ' -s ' + SWEEP_RATE_KHZ + 'k -M level -C customary -H ' + SWEEP_DWELL_S;


/**
 * The OTHER Orion protocols.
 *
 * 223 ("Badger ORION water meter, 100kbps") is a fixed-frequency endpoint and is what the collector
 * reads. 282 and 290 are newer Orion variants that FREQUENCY-HOP across the whole 902-928 band --
 * which is why meter 40462356, visible to the utility, has never appeared in this app.
 *
 * The point of these two modes is to answer one question before any collector change is made:
 * IS there anything on 282/290 within reach of this antenna?
 *
 * Read the two results very differently:
 *
 *   `hop`      Fixed on the collector's own window. Silence here proves almost nothing -- a hopping
 *              endpoint spends roughly 1.6/26 of its time in this 1.6 MHz slice, so you can miss it
 *              for many minutes and it still be there. A DECODE here is the interesting result.
 *   `hopsweep` The real test. Same 13-position sweep as `sweep`, with the extra decoders on. You
 *              still hear any one slice about 8% of the time, so run it long -- several full passes
 *              -- before concluding anything. It holds the dongle throughout.
 *
 * -M protocol is added so the summary can say WHICH decoder fired. Without it every row is just a
 * model string and 282 cannot be told from 290.
 */
const ORION_PROTOCOLS = '-R 223 -R 282 -R 290';
const ORION_META = '-F json -M level -M protocol';

/**
 * The Orion Endpoint hop range, from rtl_433's own protocol descriptions:
 *
 *   [282]  Orion Endpoint from Badger Meter, GIF2014W-OSE,  hopping from 904.4 MHz to 924.6 MHz
 *   [290]  Orion Endpoint from Badger Meter, GIF2020OCECNA, hopping from 904.4 MHz to 924.6 MHz
 *
 * 20.2 MHz, not the full 26 MHz ISM band -- so the generic `sweep` plan wastes about a fifth of its
 * dwell listening where these endpoints never transmit. Same total time over a narrower span means
 * more time on each slice that can actually contain one, which is the only lever that matters when
 * you are trying to catch a hopper.
 */
const ORION_LOW_MHZ = 904.4;
const ORION_HIGH_MHZ = 924.6;

/**
 * 1600k, NOT the 2400k the generic sweep uses.
 *
 * rtl_433 prints a suggested sample rate beside each protocol, and for both of these it is
 * `-s 1600k`. That is not a hint about bandwidth -- the decoder's timing is derived from the sample
 * rate, so running a 100kbps-class decoder at the wrong rate can mean it never syncs and you get
 * ZERO decodes from a transmitter that is right there. The first version of this mode used 2400k
 * to cover more spectrum per hop, which would have produced a confident, wrong "nothing found".
 *
 * The cost is a narrower window (1.6 MHz instead of 2.4) and therefore more hops. Correct and slow
 * beats fast and deaf.
 */
const ORION_RATE_KHZ = 1600;
const ORION_STEP_MHZ = 1.4;             // 1.6 MHz window, 0.2 MHz overlap at the seams

/**
 * Centres that COVER the range, rather than centres that merely start inside it.
 *
 * The loop exits once the window's top edge has passed ORION_HIGH_MHZ, so the last hop always
 * overshoots slightly. Stopping at the last centre below the limit instead would leave the top
 * ~0.5 MHz unlistened -- and an endpoint that only ever transmits up there would be reported as
 * absent by a sweep that never pointed at it.
 */
function orion_hops() {
  const half = ORION_RATE_KHZ / 1000 / 2;
  const out = [];
  for (let f = ORION_LOW_MHZ + ORION_STEP_MHZ / 2; ; f += ORION_STEP_MHZ) {
    out.push(Number(f.toFixed(3)));
    if (f + half >= ORION_HIGH_MHZ) break;
  }
  return out;
}
const ORION_HOPS = orion_hops();

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
    args: '-f 915M -s 1024k -C customary',
    window: '914.488 - 915.512 MHz',
    hears: 'the neighbours\' utility meters and weather stations -- NOT your meter',
    blurb: 'Deliberately does not cover 916.45, so your own meter will never appear here. That is\n' +
           '  correct behaviour, not a fault. Use it to see what else is on the air, and to prove\n' +
           '  the dongle works when your meter has gone quiet.',
  },
  wide: {
    label: 'Survey including my meter',
    args: '-f 916M -s 2400k -C customary',
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
  hop: {
    label: 'Hopping endpoints — my window only',
    args: '-f 916.45M -s 1600k ' + ORION_PROTOCOLS + ' ' + ORION_META,
    window: '915.650 - 917.250 MHz',
    hears: 'protocols 223, 282 and 290 -- but only the ~6% of the band this window covers',
    optional_protocols: [282, 290],
    blurb: 'A cheap first look. 282/290 endpoints hop across all of 902-928, so this window sees\n' +
           '  roughly one slice in sixteen: SILENCE HERE PROVES NOTHING. A decode, on the other\n' +
           '  hand, is real and immediately interesting -- run "hopsweep" next to find where it\n' +
           '  actually lives.',
    tally: true,
  },
  hopsweep: {
    label: 'Hopping endpoints — hop the whole band',
    args: ORION_HOPS.map((f) => '-f ' + f + 'M').join(' ') + ' -s ' + ORION_RATE_KHZ + 'k ' +
      ORION_PROTOCOLS + ' ' + ORION_META + ' -H ' + SWEEP_DWELL_S,
    window: ORION_RATE_KHZ / 1000 + ' MHz at a time, ' + ORION_HOPS.length + ' positions covering ' +
      ORION_LOW_MHZ + ' - ' + ORION_HIGH_MHZ + ' MHz',
    hears: 'protocols 223, 282 and 290 across the Orion Endpoint hop range -- one slice at a time',
    optional_protocols: [282, 290],
    hops: ORION_HOPS,
    blurb: 'THE actual test for 282/290, over the 904.4-924.6 MHz range and at the 1600k sample\n' +
      '  rate rtl_433 documents for these endpoints. The rate matters: a decoder run at the\n' +
      '  wrong rate may never sync, which looks exactly like an absent transmitter.\n' +
      '  You still hear any one slice ' + (1 / ORION_HOPS.length * 100).toFixed(0) + '% of the time, so run SEVERAL full passes\n' +
      '  (~' + Math.round(ORION_HOPS.length * SWEEP_DWELL_S / 60) + ' min each). One minute proves nothing. Ctrl-C prints every\n' +
      '  endpoint heard, by protocol and by frequency.',
    warn: 'This holds the dongle for as long as you leave it running. Leak detection is off throughout.',
    tally: true,
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


/**
 * The endpoint scoreboard.
 *
 * The question these modes exist to answer is not "what does one packet look like" but "IS anything
 * on 282/290 within reach". That is a question about the WHOLE run, so it needs a summary rather
 * than a scrolling log -- twenty minutes of hopping produces far more output than anyone reads, and
 * the one interesting line would go by at 3am on a Tuesday.
 *
 * Live rows still print, because watching nothing happen for four minutes with no feedback is
 * indistinguishable from a crashed process. But the deliverable is what prints on Ctrl-C.
 *
 * Keyed on (protocol, id): the same endpoint decoded by two protocols is genuinely two findings,
 * and collapsing them would hide exactly the thing being tested.
 */
function make_tally() {
  const seen = new Map();
  let n = 0;
  const started = Date.now();

  console.log(c(DIM, '   #  time      proto  meter        freq MHz    snr   model'));
  console.log(c(DIM, '  ─────────────────────────────────────────────────────────────────'));

  function on_line(line) {
    if (line.charAt(0) !== '{') { if (line) console.log(c(DIM, '  ' + line)); return; }
    let m;
    try { m = JSON.parse(line); } catch (e) { return; }

    n += 1;
    const proto = m.protocol !== undefined && m.protocol !== null ? String(m.protocol) : '?';
    const id = m.id !== undefined ? String(m.id) : (m.Id !== undefined ? String(m.Id) : '?');
    const freq = pick(m, ['freq', 'freq1', 'frequency']);
    const snr = pick(m, ['snr']);
    const model = typeof m.model === 'string' ? m.model : '';
    const t = String(m.time || '').slice(11, 19) || '--:--:--';

    const key = proto + '|' + id;
    let e = seen.get(key);
    if (!e) {
      e = { proto, id, model, count: 0, lo: null, hi: null, snr_sum: 0, snr_n: 0, first: t, last: t };
      seen.set(key, e);
      // A brand-new endpoint is THE event. Say so at the moment it happens rather than only in the
      // summary, because that is when you might still be standing next to the antenna.
      console.log(c(GREEN + BOLD, '  ** new endpoint: protocol ' + proto + ', id ' + id +
        (model ? ' (' + model + ')' : '') + ' **'));
    }
    e.count += 1;
    e.last = t;
    if (model && !e.model) e.model = model;
    if (freq !== null) {
      if (e.lo === null || freq < e.lo) e.lo = freq;
      if (e.hi === null || freq > e.hi) e.hi = freq;
    }
    if (snr !== null) { e.snr_sum += snr; e.snr_n += 1; }

    console.log(
      '  ' + String(n).padStart(3) + '  ' + t + '  ' + proto.padStart(5) + '  ' + id.padStart(10) + '  ' +
      (freq === null ? c(DIM, '      --') : freq.toFixed(3).padStart(8)) + '  ' +
      (snr === null ? c(DIM, '   --') : snr.toFixed(1).padStart(5)) + '   ' + c(DIM, model)
    );
  }

  function summary() {
    const mins = Math.max(1, Math.round((Date.now() - started) / 60000));
    console.log('');
    console.log(c(BOLD + CYAN, '  Endpoints heard in ' + mins + ' min'));
    console.log(c(DIM, '  ─────────────────────────────────────────────────────────────────'));
    if (!seen.size) {
      console.log(c(YELLOW, '  Nothing decoded at all.'));
      console.log(c(DIM, '  Not even protocol 223, which normally arrives every ~4s -- so this is more'));
      console.log(c(DIM, '  likely the dongle, the antenna or a build without the Orion decoders than'));
      console.log(c(DIM, '  a real absence. Try:  node ' + path.relative(process.cwd(), __filename) + ' check'));
      return;
    }
    console.log(c(DIM, '  proto  meter        packets   freq range (MHz)     mean snr'));
    const rows = [...seen.values()].sort((a, b) => (a.proto === b.proto ? b.count - a.count : a.proto.localeCompare(b.proto)));
    rows.forEach((e) => {
      const range = e.lo === null ? '--'
        : (e.lo === e.hi ? e.lo.toFixed(3) : e.lo.toFixed(3) + ' - ' + e.hi.toFixed(3));
      console.log(
        '  ' + e.proto.padStart(5) + '  ' + e.id.padStart(10) + '  ' + String(e.count).padStart(7) + '   ' +
        range.padEnd(19) + '  ' + (e.snr_n ? (e.snr_sum / e.snr_n).toFixed(1) : '--').padStart(6)
      );
    });

    // The verdict, stated plainly, with the caveat attached to it rather than left implicit.
    const hopping = rows.filter((e) => e.proto === '282' || e.proto === '290');
    console.log('');
    if (hopping.length) {
      console.log(c(GREEN + BOLD, '  ' + hopping.length + ' endpoint(s) on protocol 282/290 are within reach of this antenna.'));
      console.log(c(DIM, '  A frequency RANGE above (rather than one value) is the hopping confirming itself.'));
      console.log(c(DIM, '  Coverage will still be partial on a fixed collector window -- see the note below.'));
    } else {
      console.log(c(YELLOW, '  Nothing on protocol 282 or 290.'));
      console.log(c(DIM, '  This is weak evidence, not a conclusion. A hopping endpoint is only inside any'));
      console.log(c(DIM, '  one 2.4 MHz slice a fraction of the time, so a short run misses it easily.'));
      console.log(c(DIM, '  Run hopsweep for several full passes before deciding it is not there.'));
    }
    console.log('');
  }

  return { on_line, summary };
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

/**
 * Read the FULL protocol table out of `rtl_433 -R help`.
 *
 * Returns Map(number -> name). Lines look like "    [223]  Badger ORION water meter, 100kbps",
 * sometimes with a `*` after the bracket marking "disabled by default".
 */
function protocol_table(cmd) {
  const r = spawnSync(cmd, ['-R', 'help'], { encoding: 'utf8', windowsHide: true });
  if (r.error) return { error: r.error.message, list: new Map() };
  const text = String(r.stdout || '') + String(r.stderr || '');
  const list = new Map();
  text.split(/\r?\n/).forEach(function (l) {
    const m = l.match(/^\s*\[\s*(\d+)\s*\]\*?\s+(.*)$/);
    if (m) list.set(m[1], m[2].trim());
  });
  return { error: null, list };
}

/**
 * Which of `wanted` this build actually has. Used to filter -R before launching, because rtl_433
 * EXITS on an unknown protocol number -- so a mode asking for a decoder that is not compiled in
 * does not degrade, it fails to start at all.
 */
function present_protocols(list, wanted) {
  return wanted.filter(function (n) { return list.has(String(n)); });
}

function run_check(cmd) {
  console.log('\n  ' + c(BOLD, 'Which decoders are in this rtl_433 build?') + '\n');
  const { error, list } = protocol_table(cmd);
  if (error) {
    console.log(c(RED, '  Could not run ' + cmd + ': ' + error));
    console.log(c(DIM, '  Set WATER_RTL433_CMD (or _LINUX / _WINDOWS) in .env.'));
    return 1;
  }
  if (!list.size) {
    console.log(c(RED, '  Could not parse any protocols out of -R help.'));
    return 1;
  }
  console.log(c(DIM, '  ' + list.size + ' protocols in this build.\n'));

  // BY NAME first. This is the part that survives being wrong about the numbers -- and the earlier
  // version of this check was: it filtered to Orion-named lines and THEN looked for 282/290 in
  // them, so a protocol 282 that exists under any other name was reported "not in this build".
  // The list is the authority; a number written down in a note is not.
  const orion = [...list.entries()].filter(function (e) { return /orion|badger/i.test(e[1]); });
  console.log('  ' + c(BOLD, 'Orion / Badger decoders, by name'));
  if (orion.length) {
    orion.forEach(function (e) { console.log(c(GREEN, '    ✓ [' + e[0] + ']  ' + e[1])); });
  } else {
    console.log(c(RED, '    ✗ none — the apt build is often too old.'));
    console.log(c(DIM, '    Build rtl_433 from source; see plans_and_notes/water/UBUNTU_DEPLOY.md'));
  }

  // BY NUMBER second, and printing WHAT each number actually is. If 282/290 turn out to be
  // something unrelated here, that is the useful finding, not a missing feature.
  console.log('\n  ' + c(BOLD, 'The numbers hop / hopsweep ask for'));
  [223, 282, 290].forEach(function (n) {
    const name = list.get(String(n));
    if (!name) { console.log(c(YELLOW, '    – ' + n) + c(DIM, '   not in this build')); return; }
    const is_orion = /orion|badger/i.test(name);
    console.log((is_orion ? c(GREEN, '    ✓ ' + n) : c(YELLOW, '    ? ' + n)) + '   ' + name +
      (is_orion ? '' : c(DIM, '   <- not an Orion decoder')));
  });

  const have = present_protocols(list, [282, 290]);
  console.log('');
  if (have.length) {
    console.log(c(GREEN, '  hop / hopsweep will run with ' + have.join(' and ') + ' enabled.'));
  } else {
    console.log(c(YELLOW, '  Neither 282 nor 290 exists in this build, so hop / hopsweep can only'));
    console.log(c(YELLOW, '  report 223 and an empty result would prove nothing.'));
    console.log('');
    // Not a guess. These two lines are verbatim from rtl_433's own conf/rtl_433.example.conf on
    // master, which is what makes "your build is too old" a diagnosis rather than a hope.
    console.log(c(DIM, '  On rtl_433 master these exist and are exactly what you want:'));
    console.log(c(DIM, '    [282]  Orion Endpoint from Badger Meter, GIF2014W-OSE,  hopping 904.4 - 924.6 MHz'));
    console.log(c(DIM, '    [290]  Orion Endpoint from Badger Meter, GIF2020OCECNA, hopping 904.4 - 924.6 MHz'));
    const highest = Math.max.apply(null, [...list.keys()].map(Number));
    console.log(c(DIM, '\n  This build stops at [' + highest + ']; master reaches [337]. Nothing about this'));
    console.log(c(DIM, '  is fixable from the command line -- build rtl_433 from source:'));
    console.log(c(DIM, '    plans_and_notes/water/UBUNTU_DEPLOY.md'));
  }
  return 0;
}

function main() {
  const key = (process.argv[2] || '').toLowerCase();
  const cmd = rtl433.resolve_cmd();

  if (key === 'check') { process.exit(run_check(cmd)); }

  const mode = MODES[key];
  if (!mode) {
    console.log('\n  Usage: node ' + path.relative(process.cwd(), __filename) + ' <mode>\n');
    Object.keys(MODES).forEach((k) => {
      console.log('    ' + c(BOLD, k.padEnd(10)) + MODES[k].label + c(DIM, '   ' + MODES[k].window));
    });
    console.log('    ' + c(BOLD, 'check     ') + 'Are the Orion decoders in this rtl_433 build (no dongle needed)');
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

  let arg_text = mode.args;

  // rtl_433 EXITS on an unknown -R number, so a mode asking for a decoder this build does not have
  // fails to start rather than degrading. Drop the missing ones and say so, so the run still
  // produces its 223 baseline instead of a usage error nobody reads.
  if (mode.optional_protocols) {
    const { list } = protocol_table(cmd);
    if (list.size) {
      const missing = mode.optional_protocols.filter(function (n) { return !list.has(String(n)); });
      if (missing.length) {
        missing.forEach(function (n) {
          arg_text = arg_text.replace(new RegExp('\\s-R ' + n + '(?=\\s|$)'), '');
        });
        console.log(c(YELLOW, '  Protocol ' + missing.join(' and ') + ' is not in this rtl_433 build.'));
        console.log(c(YELLOW, '  Dropped from the command — this run can only report the decoders that ARE here,'));
        console.log(c(YELLOW, '  so an empty result says nothing about the hopping endpoints.'));
        console.log(c(DIM, '  Check what you do have:  npm run water_rtl_check\n'));
      }
    }
  }

  const args = rtl433.parse_args(arg_text);
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const format = mode.format ? make_formatter() : null;
  const tally = mode.tally ? make_tally() : null;

  child.on('error', function (err) {
    console.log(c(RED, '  Could not start ' + cmd + ': ' + err.message));
    if (err.code === 'ENOENT') console.log(c(DIM, '  Set WATER_RTL433_CMD (or _LINUX / _WINDOWS) in .env.'));
  });

  createInterface({ input: child.stdout }).on('line', function (line) {
    const t = String(line).trim();
    if (tally) tally.on_line(t);
    else if (format) format(t);
    else if (t) console.log('  ' + t);
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
    // Summary BEFORE the collector restart line, so the answer you ran this for is the last thing
    // on screen rather than buried above a pm2 message.
    if (tally) { try { tally.summary(); } catch (e) { /* never swallow the restart */ } }
    give_back();
    process.exit(0);
  });

  // SIGINT is the expected exit. Kill the radio and let 'close' restore the collector; the extra
  // give_back() on 'exit' is the belt-and-braces path for a kill that never produces 'close'.
  process.on('SIGINT', function () { try { child.kill(); } catch (e) { /* gone */ } });
  process.on('exit', give_back);
}

if (require.main === module) main();

module.exports = { MODES, pm2_state, hop_centres, orion_hops, make_tally, protocol_table, present_protocols,
  ORION_LOW_MHZ, ORION_HIGH_MHZ, ORION_RATE_KHZ,
  SWEEP_LOW_MHZ, SWEEP_HIGH_MHZ, SWEEP_RATE_KHZ, ORION_PROTOCOLS };
