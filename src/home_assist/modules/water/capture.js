#!/usr/bin/env node
'use strict';
/**
 * capture.js — save raw rtl_433 output to a .jsonl file in the out-of-repo data folder.
 *
 *   node src/home_assist/modules/water/capture.js [minutes]
 *
 * Two reasons this exists:
 *
 *  1. Forensics. If the meter's field names ever differ from what ingest.js expects, a capture is
 *     the evidence — far better than "it didn't work last night".
 *  2. Replay. A real capture makes a far more honest test than the synthetic generator:
 *     `node collector_water.js --replay --file <the capture>` replays exactly what the radio heard.
 *
 * Files land in <data dir>/captures/, which is outside the repo, so a big capture never ends up
 * staged for commit.
 */
require('../../env');
const path = require('path');
const fs = require('fs');

const data_dir = require('../../data_dir');
const rtl433 = require('./collector/rtl433');
const time = require('../../time');

const minutes = Number(process.argv[2]) || 10;
const dir = data_dir.captures_dir();
const stamp = time.sql_utc(new Date()).replace(/[: ]/g, '-');
const file = path.join(dir, 'rtl433-' + stamp + '.jsonl');

console.log('capturing rtl_433 output for ' + minutes + ' minute(s)');
console.log('  -> ' + file);
console.log('  (Ctrl-C to stop early)\n');

const out = fs.createWriteStream(file, { flags: 'a' });
let lines = 0;
let ours = 0;
const meter_id = Number(process.env.WATER_METER_ID) || 16642655;

const source = rtl433.start({
  mode: process.env.WATER_COLLECTOR_MODE === 'replay' ? 'replay' : 'live',
  cmd: rtl433.resolve_cmd(),
  args: rtl433.resolve_args(),
  meter_id: meter_id,
  log: console.log,
  onLine: function (line) {
    if (!line || line[0] !== '{') return;
    out.write(line + '\n');
    lines++;
    if (line.includes(String(meter_id))) ours++;
    process.stdout.write('\r  lines: ' + lines + '   ours: ' + ours + '   ');
  },
});

function finish() {
  try { source.stop(); } catch (e) { /* ignore */ }
  out.end();
  console.log('\n\ncaptured ' + lines + ' line(s), ' + ours + ' from meter ' + meter_id);
  if (!ours && lines) {
    console.log('\nNothing from YOUR meter. Either the antenna needs to move (a window facing the pit),');
    console.log('or the radio id is wrong — check a captured line for the real "id" value.');
  }
  if (!lines) {
    console.log('\nNothing decoded at all. Check that rtl_433 runs standalone and the dongle is seated:');
    console.log('  ' + rtl433.resolve_cmd() + ' ' + rtl433.resolve_args());
  }
  console.log('\nReplay it with:  node collector_water.js --replay --file "' + file + '"');
  process.exit(0);
}

setTimeout(finish, minutes * 60 * 1000);
process.on('SIGINT', finish);
process.on('SIGTERM', finish);
