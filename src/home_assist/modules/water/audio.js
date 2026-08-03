#!/usr/bin/env node
/**
 * audio.js — listen to ANALOGUE radio with the same dongle, and record it to a .wav.
 *
 *   node src/home_assist/modules/water/audio.js fm 98.5        # FM broadcast
 *   node src/home_assist/modules/water/audio.js am 124.0       # airband (AM is standard there)
 *   node src/home_assist/modules/water/audio.js weather        # NOAA Weather Radio, 162.550
 *   node src/home_assist/modules/water/audio.js weather 162.475
 *   node src/home_assist/modules/water/audio.js nfm 146.940    # any narrowband FM
 *   node src/home_assist/modules/water/audio.js fm 98.5 --record 30
 *
 * Nothing here has anything to do with water, and as a DIAGNOSTIC it is weaker than it first looks:
 * hearing FM proves the dongle, USB, driver and tuner work, but 98.5 MHz is not 916 MHz and it says
 * nothing about the antenna at the frequency that matters. `listen.js nearby` tests the same chain
 * AT 915 with the decoder in the loop, and is the better check.
 *
 * The mode that actually earns its keep is `weather` -- NOAA Weather Radio is a continuous voice
 * broadcast carrying severe-weather alerts, and it works when the internet does not. Flash-flood
 * warning and leak detection are the same job: know before the basement does.
 *
 * DIFFERENT BINARY. `rtl_433` is a packet decoder — it has no audio path at all. Analogue
 * demodulation is `rtl_fm`, which ships in the same `rtl-sdr` package that provides `rtl_test`.
 * Both talk to the same dongle, so the same one-owner rule applies and the collector is stopped
 * for the duration.
 *
 * --record IS THE ANSWER TO "I AM ON THE SERVER OVER RDP". Audio played on a headless box comes out
 * of THAT box's sound card, which is not where you are. Recording writes a plain .wav you can copy
 * to your laptop and play anywhere. The WAV header is written here in Node — no ffmpeg, no sox, no
 * aplay — because a diagnostic that needs three packages installed first is not a diagnostic.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execSync } = require('child_process');
const readline = require('readline');
const { platform_env } = require('../../env');
const data_dir = require('../../data_dir');
const rtl433 = require('./collector/rtl433');

const RESET = '\x1b[0m', BOLD = '\x1b[1m', DIM = '\x1b[2m';
const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m';
const c = (color, t) => `${color}${t}${RESET}`;

const PM2_NAME = 'water_collector';

// The R820T tuner's usable span. Below this the dongle needs a direct-sampling modification or an
// upconverter -- which is why an RTL-SDR cannot hear the AM BROADCAST band (530-1700 kHz) out of
// the box, however much the word "AM" suggests it should.
const TUNER_LOW_MHZ = 24;
const TUNER_HIGH_MHZ = 1766;

// The seven NOAA Weather Radio channels. Every US transmitter uses one of these and nothing else,
// so "which frequency" is a seven-way guess rather than a search. In any given place one or two are
// strong and the rest are silent.
const NOAA_CHANNELS = [162.400, 162.425, 162.450, 162.475, 162.500, 162.525, 162.550];

const MODES = {
  fm: {
    label: 'FM broadcast',
    mod: 'wbfm',
    // 200 kHz because that is how wide an FM broadcast channel is. Same principle as -s on
    // rtl_433: you set the window to match the signal. 48 kHz out is ordinary audio rate.
    sample_hz: 200000,
    audio_hz: 48000,
    default_mhz: 98.5,
    // US FM broadcast sits on odd tenths, so one press is 0.2 MHz -- the next real station,
    // not the next arbitrary number.
    step_mhz: 0.2,
    band: [88.1, 107.9],
    band_label: 'US FM broadcast, 88.1 - 107.9 MHz',
    blurb: 'Wideband FM. The loudest, easiest thing an RTL-SDR can receive — if a local station\n' +
           '  is silent, the fault is the dongle or the antenna, not the software.',
  },
  am: {
    label: 'AM (narrow) / airband',
    mod: 'am',
    // AM voice is ~8 kHz of audio; 12 kHz of window is the conventional choice and keeps the
    // adjacent channel out. No resampling stage needed, so audio rate matches.
    sample_hz: 12000,
    audio_hz: 12000,
    default_mhz: 124.0,
    step_mhz: 0.025,
    band: [108, 137],
    band_label: 'civil airband, 108 - 137 MHz (AM is still standard there)',
    blurb: 'Narrowband AM. Aviation is the practical use — the AM BROADCAST band (530-1700 kHz)\n' +
           '  is below what this tuner can reach without a hardware modification. Expect long\n' +
           '  silences between transmissions; that is what airband sounds like.',
  },
  nfm: {
    label: 'Narrowband FM',
    mod: 'fm',
    // A narrowband FM channel is 25 kHz wide, so 32 kHz of window covers it with room to spare.
    // -E deemp applies the standard FM de-emphasis curve (without it voice sounds thin and hissy);
    // -l 0 disables squelch so you hear the noise floor rather than silence, which is what you want
    // when the question is "is anything there at all".
    sample_hz: 32000,
    audio_hz: 32000,
    extra: ['-E', 'deemp', '-l', '0'],
    default_mhz: 162.550,
    step_mhz: 0.025,
    band: [136, 174],
    band_label: 'VHF narrowband FM, 136 - 174 MHz',
    blurb: 'The general-purpose narrowband mode. Weather radio, ham repeaters, business band.\n' +
           '  Use the `weather` mode instead if NOAA is what you are after — same demodulator,\n' +
           '  but it knows the channel list.',
  },
  weather: {
    label: 'NOAA Weather Radio',
    mod: 'fm',
    sample_hz: 32000,
    audio_hz: 32000,
    extra: ['-E', 'deemp', '-l', '0'],
    default_mhz: 162.550,
    band: [162.400, 162.550],
    band_label: 'NOAA Weather Radio, 162.400 - 162.550 MHz',
    channels: NOAA_CHANNELS,
    blurb: 'A continuous synthesised-voice forecast loop, 24/7 — this is a real broadcast you\n' +
           '  listen to, not a data feed. It also carries a 1050 Hz alarm tone and SAME digital\n' +
           '  headers ahead of warnings, which is the machine-readable half.',
    tip: 'Seven channels exist and only one or two will be strong here. Try each in turn; the\n' +
         '  right one is unmistakable — a voice reading the forecast.',
  },
};

// ------------------------------------------------------------------------------------------------
// binaries

/**
 * rtl_fm lives beside rtl_433 in every packaging of the rtl-sdr tools, so if WATER_RTL433_CMD is a
 * PATH we look next door before falling back to a bare name. That makes the Windows laptop work
 * without a second env var pointing at the same folder.
 */
function resolve_fm_cmd() {
  const explicit = platform_env('WATER_RTL_FM_CMD', '');
  if (explicit) return explicit;
  const r433 = rtl433.resolve_cmd();
  if (r433 && (r433.includes('/') || r433.includes('\\'))) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const sibling = path.join(path.dirname(r433), 'rtl_fm' + ext);
    if (fs.existsSync(sibling)) return sibling;
  }
  return 'rtl_fm';
}

function on_path(name) {
  try {
    execSync((process.platform === 'win32' ? 'where ' : 'command -v ') + name,
      { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch (e) { return false; }
}

/**
 * Something to push PCM into. Deliberately ordered by how likely it is to already be installed:
 * aplay comes with alsa-utils on any desktop Ubuntu, ffplay with ffmpeg, play with sox.
 */
function resolve_player(rate) {
  const custom = platform_env('WATER_AUDIO_PLAYER', '');
  if (custom) {
    const parts = rtl433.parse_args(custom.replace(/\{rate\}/g, String(rate)));
    return { cmd: parts[0], args: parts.slice(1), name: parts[0] + ' (WATER_AUDIO_PLAYER)' };
  }
  if (on_path('aplay')) {
    return { cmd: 'aplay', args: ['-r', String(rate), '-f', 'S16_LE', '-t', 'raw', '-c', '1', '-'], name: 'aplay' };
  }
  if (on_path('ffplay')) {
    return { cmd: 'ffplay', args: ['-f', 's16le', '-ar', String(rate), '-ac', '1', '-nodisp', '-autoexit', '-loglevel', 'quiet', '-i', '-'], name: 'ffplay' };
  }
  if (on_path('play')) {
    return { cmd: 'play', args: ['-q', '-t', 'raw', '-r', String(rate), '-e', 'signed', '-b', '16', '-c', '1', '-'], name: 'play (sox)' };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// wav

/**
 * A 44-byte canonical PCM header. rtl_fm already emits signed 16-bit little-endian mono, which is
 * exactly what a .wav contains after the header -- so "converting" is prepending 44 bytes and then
 * patching two length fields once we know how much arrived. No transcoder involved.
 */
function wav_header(rate, data_bytes) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + data_bytes, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);          // PCM chunk size
  b.writeUInt16LE(1, 20);           // format = PCM
  b.writeUInt16LE(1, 22);           // channels
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);    // byte rate (16-bit mono)
  b.writeUInt16LE(2, 32);           // block align
  b.writeUInt16LE(16, 34);          // bits per sample
  b.write('data', 36);
  b.writeUInt32LE(data_bytes, 40);
  return b;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// ------------------------------------------------------------------------------------------------
// pm2

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
  try { execSync(`pm2 ${verb} ${PM2_NAME}`, { stdio: ['ignore', 'ignore', 'ignore'] }); return true; }
  catch (e) { return false; }
}

// ------------------------------------------------------------------------------------------------
function usage(code) {
  console.log('\n  Usage: node ' + path.relative(process.cwd(), __filename) +
    ' <' + Object.keys(MODES).join('|') + '|scan> [MHz] [--record <seconds>]\n');
  Object.keys(MODES).forEach((k) => {
    const m = MODES[k];
    console.log('    ' + c(BOLD, k.padEnd(8)) + m.label.padEnd(22) + c(DIM, m.band_label));
    console.log('             ' + c(DIM, 'default ' + m.default_mhz + ' MHz'));
  });
  console.log('    ' + c(BOLD, 'scan    ') + 'Which NOAA channel is receivable here'.padEnd(22) +
    c(DIM, 'measures all seven, no listening'));
  console.log('\n    ' + c(DIM, 'With no frequency given you are asked for one; Enter takes the default.'));
  console.log('    ' + c(DIM, 'While playing:  [n]/[p] step   [1-9] pick a channel   [q] quit'));
  console.log('\n    ' + c(DIM, '--record N   write N seconds to a .wav instead of playing it.'));
  console.log('    ' + c(DIM, '             Audio plays on the SERVER\'s sound card, not on your laptop.\n'));
  process.exit(code);
}

// ------------------------------------------------------------------------------------------------
// scan — which NOAA channel actually reaches this house

/**
 * Listening to seven channels of hiss to find the one with a voice on it is a bad use of a
 * Saturday. `rtl_power` measures received power across a span and prints it as CSV, so one six
 * second sweep answers the question numerically.
 *
 * It is a different binary again -- rtl_power, also from the rtl-sdr package -- and it takes the
 * dongle like everything else here.
 */
function scan_noaa() {
  const cmd = resolve_fm_cmd().replace(/rtl_fm(\.exe)?$/, function (m) {
    return m.replace('rtl_fm', 'rtl_power');
  });
  const use = cmd.endsWith('rtl_power') || cmd.endsWith('rtl_power.exe') ? cmd : 'rtl_power';

  // 12.5 kHz bins over a span that brackets all seven channels with a margin either side, so every
  // channel lands well inside rather than on an edge bin.
  const args = ['-f', '162.380M:162.570M:12.5k', '-i', '6', '-1', '-'];

  console.log('');
  console.log(c(BOLD + CYAN, '  Scanning the seven NOAA channels'));
  console.log(c(DIM, '  ─────────────────────────────────────────────────────────────────'));
  console.log(c(DIM, '  $ ' + use + ' ' + args.join(' ')));
  console.log(c(DIM, '  About 6 seconds.\n'));

  const state = pm2_state();
  let restore = false;
  if (state === 'online') {
    process.stdout.write(c(YELLOW, '  Stopping the collector… '));
    if (pm2_do('stop')) { restore = true; console.log(c(YELLOW, 'stopped.')); }
    else console.log(c(RED, 'failed.'));
  }

  const r = spawnSync(use, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });

  if (restore) {
    process.stdout.write(c(YELLOW, '  Restarting the collector… '));
    console.log(pm2_do('start') || pm2_do('restart') ? c(GREEN, 'back up.') : c(RED, 'FAILED.'));
  }

  if (r.error) {
    console.log(c(RED, '\n  Could not run ' + use + ': ' + r.error.message));
    if (r.error.code === 'ENOENT') console.log(c(DIM, '  rtl_power ships with the rtl-sdr package: sudo apt install rtl-sdr'));
    return 1;
  }

  // rtl_power CSV: date, time, Hz_low, Hz_high, Hz_step, samples, dbm, dbm, ...
  const bins = [];
  String(r.stdout || '').split(/\r?\n/).forEach(function (line) {
    const f = line.split(',').map(function (x) { return x.trim(); });
    if (f.length < 7) return;
    const low = Number(f[2]), step = Number(f[4]);
    if (!Number.isFinite(low) || !Number.isFinite(step) || step <= 0) return;
    for (let i = 6; i < f.length; i += 1) {
      const db = Number(f[i]);
      if (Number.isFinite(db)) bins.push({ mhz: (low + step * (i - 6 + 0.5)) / 1e6, db: db });
    }
  });

  if (!bins.length) {
    console.log(c(RED, '\n  No usable output from rtl_power.'));
    if (r.stderr) console.log(c(DIM, String(r.stderr).trim()));
    return 1;
  }

  // Noise floor as the MEDIAN of every bin, not the mean. A strong carrier drags a mean upward and
  // makes itself look less exceptional than it is; the median ignores it.
  const sorted = bins.map(function (b) { return b.db; }).sort(function (a, b) { return a - b; });
  const floor = sorted[Math.floor(sorted.length / 2)];

  const rows = NOAA_CHANNELS.map(function (ch) {
    // Take the strongest bin within half a channel of the nominal centre -- the tuner is not exact
    // and a carrier can sit a bin either side.
    let best = -999;
    bins.forEach(function (b) { if (Math.abs(b.mhz - ch) <= 0.0125 && b.db > best) best = b.db; });
    return { ch: ch, db: best, over: best - floor };
  }).sort(function (a, b) { return b.over - a.over; });

  console.log('\n  noise floor  ' + c(DIM, floor.toFixed(1) + ' dB') + c(DIM, '   (median of ' + bins.length + ' bins)'));
  console.log('');
  console.log(c(DIM, '  channel     dB      above floor'));
  console.log(c(DIM, '  ─────────────────────────────────────────────'));
  rows.forEach(function (r2) {
    const strong = r2.over >= 10;
    const maybe = r2.over >= 5 && r2.over < 10;
    const bar = '█'.repeat(Math.max(0, Math.min(24, Math.round(r2.over))));
    const mark = strong ? c(GREEN, '✓') : maybe ? c(YELLOW, '?') : c(DIM, '·');
    console.log('  ' + mark + ' ' + r2.ch.toFixed(3) + '  ' + r2.db.toFixed(1).padStart(7) + '   ' +
      (strong ? c(GREEN, bar) : maybe ? c(YELLOW, bar) : c(DIM, bar)) + '  ' +
      (r2.over >= 0 ? '+' : '') + r2.over.toFixed(1));
  });

  const winner = rows[0];
  console.log('');
  if (winner.over >= 10) {
    console.log(c(GREEN, '  ✓ ' + winner.ch.toFixed(3) + ' is clearly transmitting. Listen to it:'));
    console.log('    ' + c(BOLD, 'node ' + path.relative(process.cwd(), __filename) + ' weather ' + winner.ch.toFixed(3)));
  } else if (winner.over >= 5) {
    console.log(c(YELLOW, '  ? ' + winner.ch.toFixed(3) + ' is the strongest but marginal. Worth trying; may be'));
    console.log(c(YELLOW, '    intelligible with a better antenna position.'));
    console.log('    ' + c(BOLD, 'node ' + path.relative(process.cwd(), __filename) + ' weather ' + winner.ch.toFixed(3)));
  } else {
    console.log(c(RED, '  ✗ Nothing above the noise floor on any of the seven.'));
    console.log(c(DIM, '    Either no NWR transmitter reaches this spot, or the antenna is the problem.'));
    console.log(c(DIM, '    The stub is cut for 915 MHz; 162 MHz wants something much longer (~46 cm'));
    console.log(c(DIM, '    for a quarter wave). Try moving it to a window before concluding anything.'));
  }
  console.log('');
  return 0;
}

// ------------------------------------------------------------------------------------------------
// interactive frequency choice

function ask(question, def) {
  return new Promise(function (resolve) {
    if (!process.stdin.isTTY) return resolve(def);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, function (a) {
      rl.close();
      const t = String(a).trim();
      resolve(t === '' ? def : t);
    });
  });
}

async function choose_frequency(mode) {
  if (mode.channels) {
    console.log('  ' + c(BOLD, 'Pick a channel:'));
    mode.channels.forEach(function (f, i) {
      console.log('    ' + c(BOLD, String(i + 1)) + '. ' + f.toFixed(3) +
        (f === mode.default_mhz ? c(DIM, '   (default)') : ''));
    });
    const a = await ask('\n  Channel 1-' + mode.channels.length + ', a frequency, or Enter for ' +
      mode.default_mhz.toFixed(3) + ': ', String(mode.default_mhz));
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= mode.channels.length) return mode.channels[n - 1];
    return Number.isFinite(n) && n > 1 ? n : mode.default_mhz;
  }
  const a = await ask('  Frequency in MHz, or Enter for ' + mode.default_mhz + ': ', String(mode.default_mhz));
  const n = Number(a);
  return Number.isFinite(n) && n > 0 ? n : mode.default_mhz;
}

// ------------------------------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const key = (argv[0] || '').toLowerCase();

  if (key === 'scan') process.exit(scan_noaa());

  const mode = MODES[key];
  if (!mode) usage(key ? 1 : 0);

  const ri = argv.indexOf('--record');
  const record_s = ri === -1 ? 0 : Math.max(1, Math.round(Number(argv[ri + 1]) || 30));
  const freq_arg = argv.slice(1).find(function (a) {
    return /^[\d.]+$/.test(a) && (ri === -1 || argv.indexOf(a) !== ri + 1);
  });

  const cmd = resolve_fm_cmd();

  console.log('');
  console.log(c(BOLD + CYAN, '  ' + mode.label));
  console.log(c(DIM, '  ─────────────────────────────────────────────────────────────────'));
  console.log('  band    ' + mode.band_label);
  console.log('  window  ' + c(BOLD, (mode.sample_hz / 1000) + ' kHz') + c(DIM, '  — matched to the signal, same idea as -s on rtl_433'));
  console.log('  audio   ' + (mode.audio_hz / 1000) + ' kHz, 16-bit mono');
  console.log('');
  console.log('  ' + mode.blurb);
  if (mode.tip) console.log('\n  ' + c(DIM, mode.tip));
  console.log('');

  // A frequency on the command line wins. Otherwise ask, with the default one Enter away.
  let mhz = Number(freq_arg);
  if (!Number.isFinite(mhz) || mhz <= 0) mhz = await choose_frequency(mode);
  console.log('');

  if (mhz < TUNER_LOW_MHZ) {
    console.log(c(RED, '  ' + mhz + ' MHz is below this tuner\'s floor of ' + TUNER_LOW_MHZ + ' MHz.'));
    console.log(c(DIM, '  The AM broadcast band (0.53 - 1.7 MHz) needs a direct-sampling modification or an'));
    console.log(c(DIM, '  upconverter. A stock RTL-SDR cannot receive it, and no flag changes that.\n'));
    process.exit(1);
  }
  if (mhz > TUNER_HIGH_MHZ) {
    console.log(c(RED, '  ' + mhz + ' MHz is above this tuner\'s ceiling of ' + TUNER_HIGH_MHZ + ' MHz.\n'));
    process.exit(1);
  }
  if (mhz < mode.band[0] || mhz > mode.band[1]) {
    console.log(c(YELLOW, '  Note: ' + mhz + ' MHz is outside ' + mode.band_label + '.'));
    console.log(c(YELLOW, '  The tuner will go there; whether anything is transmitting is another matter.\n'));
  }

  let player = null;
  let out_file = null;
  if (record_s) {
    const dir = path.join(data_dir.captures_dir(), 'audio');
    fs.mkdirSync(dir, { recursive: true });
    out_file = path.join(dir, key + '_' + String(mhz).replace('.', 'p') + 'MHz_' + stamp() + '.wav');
    console.log('  Recording ' + c(BOLD, record_s + 's') + ' to:');
    console.log('  ' + c(CYAN, out_file) + '\n');
  } else {
    player = resolve_player(mode.audio_hz);
    if (!player) {
      console.log(c(RED, '  No audio player found (looked for aplay, ffplay, play).'));
      console.log(c(DIM, '  Ubuntu:  sudo apt install alsa-utils'));
      console.log(c(DIM, '  Or set WATER_AUDIO_PLAYER in .env; {rate} is substituted.'));
      console.log(c(DIM, '  Or record instead:  --record 30\n'));
      process.exit(1);
    }
    console.log('  Playing through ' + c(BOLD, player.name) + c(DIM, ' — on THIS machine\'s sound card.'));
    if (process.env.SSH_CONNECTION || process.env.SSH_TTY) {
      console.log(c(YELLOW, '  You appear to be connected remotely. The sound comes out where the dongle is,'));
      console.log(c(YELLOW, '  not where you are. Use --record 30 and copy the .wav instead.'));
    }
  }

  // --- take the dongle ONCE, for the whole session including retunes ------------------------------
  const state = pm2_state();
  let restore = false;
  if (state === 'online') {
    process.stdout.write(c(YELLOW, '\n  Stopping the collector so this can have the dongle… '));
    if (pm2_do('stop')) { restore = true; console.log(c(YELLOW, 'stopped.')); }
    else console.log(c(RED, 'failed — expect usb_claim_interface error -6.'));
    console.log(c(BOLD + YELLOW, '  LEAK DETECTION IS OFF until this finishes. It restarts automatically.'));
  } else if (state === 'no-pm2' || state === 'absent') {
    console.log(c(DIM, '\n  (No pm2 collector found. If one is running in another terminal, stop it first.)'));
  } else {
    console.log(c(DIM, '\n  (Collector already stopped — leaving it that way.)'));
  }

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

  // ------------------------------------------------------------------------------------------------
  // the stream, which can be torn down and rebuilt on a different frequency

  let radio = null;
  let sink = null;
  let fd = null;
  let bytes = 0;
  let timer = null;
  let switching = false;
  let quitting = false;

  function args_for(f) {
    return ['-f', f + 'M', '-M', mode.mod, '-s', String(mode.sample_hz), '-r', String(mode.audio_hz)]
      .concat(mode.extra || [], ['-']);
  }

  function start_stream(f) {
    const args = args_for(f);
    console.log(c(DIM, '\n  $ ' + cmd + ' ' + args.join(' ')));

    radio = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    radio.on('error', function (err) {
      console.log(c(RED, '  Could not start ' + cmd + ': ' + err.message));
      if (err.code === 'ENOENT') {
        console.log(c(DIM, '  rtl_fm ships with the rtl-sdr package, same as rtl_test.'));
        console.log(c(DIM, '  Ubuntu:  sudo apt install rtl-sdr'));
        console.log(c(DIM, '  Or set WATER_RTL_FM_CMD in .env.'));
      }
    });

    radio.stderr.on('data', function (d) {
      const s = String(d);
      if (/usb_claim_interface error/.test(s)) console.log(c(RED, '\n  Something else already has the dongle.'));
      process.stderr.write(d);
    });

    if (out_file) {
      let last = 0;
      radio.stdout.on('data', function (chunk) {
        fs.writeSync(fd, chunk);
        bytes += chunk.length;
        const secs = Math.floor(bytes / (mode.audio_hz * 2));
        if (secs > last) { last = secs; process.stdout.write('\r  ' + c(DIM, '  recorded ' + secs + 's / ' + record_s + 's')); }
      });
      timer = setTimeout(function () { try { radio.kill(); } catch (e) { /* gone */ } }, record_s * 1000);
    } else {
      // A FRESH player per tune. Reusing one across a retune sounds like a click and, if the two
      // frequencies had different audio rates, would play at the wrong speed.
      sink = spawn(player.cmd, player.args, { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
      sink.on('error', function (err) { console.log(c(RED, '  ' + player.cmd + ' failed: ' + err.message)); });
      sink.stdin.on('error', function () { /* player gone */ });
      radio.stdout.on('data', function (chunk) { try { sink.stdin.write(chunk); } catch (e) { /* player gone */ } });
    }

    radio.on('close', function (code) {
      // A close we caused by retuning is not the end of the session.
      if (switching) return;
      if (timer) clearTimeout(timer);
      if (sink) { try { sink.stdin.end(); } catch (e) { /* closed */ } }
      if (fd !== null) finish_recording();
      else console.log(c(DIM, '\n  rtl_fm exited (' + code + ').'));
      shutdown();
    });
  }

  function stop_stream() {
    switching = true;
    try { if (radio) radio.kill(); } catch (e) { /* gone */ }
    try { if (sink) sink.stdin.end(); } catch (e) { /* closed */ }
    radio = null; sink = null;
    switching = false;
  }

  function finish_recording() {
    fs.writeSync(fd, wav_header(mode.audio_hz, bytes), 0, 44, 0);
    fs.closeSync(fd);
    fd = null;
    const secs = (bytes / (mode.audio_hz * 2)).toFixed(1);
    console.log('\n');
    if (bytes === 0) {
      console.log(c(RED, '  Nothing was recorded — the radio produced no samples.'));
    } else {
      console.log(c(GREEN, '  ✓ ' + secs + 's written (' + (bytes / 1024 / 1024).toFixed(1) + ' MB)'));
      console.log('  ' + c(CYAN, out_file));
      console.log(c(DIM, '\n  Copy it to your laptop and play it there:'));
      console.log(c(DIM, '    scp <user>@<server>:"' + out_file + '" .'));
    }
  }

  function shutdown() {
    if (quitting) return;
    quitting = true;
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch (e) { /* not a tty */ } }
    give_back();
    process.exit(0);
  }

  // ------------------------------------------------------------------------------------------------
  // live retuning

  function step(dir) {
    if (mode.channels) {
      let i = mode.channels.findIndex(function (f) { return Math.abs(f - mhz) < 1e-9; });
      if (i === -1) i = 0;
      i = (i + dir + mode.channels.length) % mode.channels.length;
      return mode.channels[i];
    }
    const s = mode.step_mhz || 0.025;
    let f = Number((mhz + dir * s).toFixed(4));
    if (f < mode.band[0]) f = mode.band[1];
    if (f > mode.band[1]) f = mode.band[0];
    return f;
  }

  function retune(f) {
    if (!Number.isFinite(f) || f === mhz) return;
    stop_stream();
    mhz = f;
    console.log('\n' + c(BOLD + CYAN, '  → ' + mhz.toFixed(3) + ' MHz') +
      (mode.channels ? c(DIM, '   channel ' + (mode.channels.indexOf(mhz) + 1) + ' of ' + mode.channels.length) : ''));
    start_stream(mhz);
  }

  function wire_keys() {
    if (!process.stdin.isTTY) return;
    readline.emitKeypressEvents(process.stdin);
    try { process.stdin.setRawMode(true); } catch (e) { return; }
    process.stdin.resume();
    process.stdin.on('keypress', function (str, k) {
      if (k && k.ctrl && k.name === 'c') return shutdown();
      if (str === 'q') return shutdown();
      if (str === 'n' || (k && (k.name === 'right' || k.name === 'up'))) return retune(step(1));
      if (str === 'p' || (k && (k.name === 'left' || k.name === 'down'))) return retune(step(-1));
      if (mode.channels && /^[1-9]$/.test(String(str))) {
        const i = Number(str) - 1;
        if (i < mode.channels.length) return retune(mode.channels[i]);
      }
    });
  }

  if (out_file) {
    fd = fs.openSync(out_file, 'w');
    fs.writeSync(fd, wav_header(mode.audio_hz, 0));
    console.log(c(DIM, '  Ctrl-C to stop early.'));
  } else {
    console.log('');
    console.log('  ' + c(BOLD, '[n]') + c(DIM, ' next  ') + c(BOLD, '[p]') + c(DIM, ' previous  ') +
      (mode.channels ? c(BOLD, '[1-' + mode.channels.length + ']') + c(DIM, ' channel  ') : '') +
      c(BOLD, '[q]') + c(DIM, ' quit'));
    wire_keys();
  }

  start_stream(mhz);
  process.on('SIGINT', function () { if (timer) clearTimeout(timer); shutdown(); });
  process.on('exit', give_back);
}

if (require.main === module) main();

module.exports = { MODES, NOAA_CHANNELS, wav_header, resolve_fm_cmd, TUNER_LOW_MHZ, TUNER_HIGH_MHZ };
