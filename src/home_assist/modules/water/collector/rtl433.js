'use strict';
/**
 * rtl433.js — the radio source.
 *
 * Two sources behind one interface, so everything downstream (ingest, rules, alerts, the UI) is
 * identical whether or not a dongle is plugged in:
 *
 *   live    spawn rtl_433 and read its JSON lines, restarting with exponential backoff if it dies
 *   replay  read a captured .jsonl file, or generate a synthetic meter, at an accelerated rate
 *
 * Replay is not a toy: it is how the UI gets built on the Windows laptop, how the leak rules get
 * exercised without waiting until 2am, and how you sanity-check a threshold change before trusting
 * it overnight.
 *
 * The working live command, confirmed on real hardware:
 *   rtl_433 -f 916.45M -s 1600k -R 223 -F json
 * Protocol 223 = "Badger ORION water meter, 100kbps". The classic Orion sits on one fixed
 * frequency — 282/290 are for the newer frequency-hopping endpoints (a neighbour has one).
 */
const { spawn, spawnSync } = require('child_process');
const { createInterface } = require('readline');
const fs = require('fs');
const { platform_env, platform_env_source } = require('../../../env');

const DEFAULT_ARGS = '-f 916.45M -s 1600k -R 223 -F json';

/**
 * The decoder command for THIS machine.
 *
 * Uses the platform-suffix convention from wrestling_stats' .env
 * (`GOOGLE_APPLICATION_CREDENTIALS_LINUX / _MAC / _WINDOWS`) so one .env can be shared between the
 * Windows laptop and the Ubuntu box:
 *
 *   WATER_RTL433_CMD_WINDOWS=C:/.../rtl_433_64bit_static.exe
 *   WATER_RTL433_CMD_LINUX=rtl_433
 *   WATER_RTL433_CMD=            <- set this to override both
 */
function resolve_cmd() { return platform_env('WATER_RTL433_CMD', 'rtl_433'); }
function resolve_args() { return platform_env('WATER_RTL433_ARGS', DEFAULT_ARGS); }
function cmd_source() { return platform_env_source('WATER_RTL433_CMD'); }

function parse_args(str) {
  // Split on whitespace, honouring simple double-quoted segments.
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(str || ''))) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/**
 * start_live — spawn rtl_433 and stream its JSON lines to onLine.
 * Returns { stop() }. Restarts itself on exit until stop() is called.
 */
function start_live(opts) {
  const cmd = opts.cmd;
  const args = Array.isArray(opts.args) ? opts.args : parse_args(opts.args);
  const onLine = opts.onLine;
  const log = opts.log || console.log;

  let child = null;
  let stopping = false;
  let delay = 1000;

  function launch() {
    if (stopping) return;
    log('starting: ' + cmd + ' ' + args.join(' '));
    // windowsHide: rtl_433 is a console-subsystem .exe, so Windows gives it its OWN console window
    // unless we say otherwise. Node's default for spawn is windowsHide:false, which means a black
    // cmd window pops up on every launch — and because the collector restarts the radio on failure
    // with exponential backoff, a dongle that cannot tune produces a window every second.
    // No effect on Linux/macOS, where the flag is ignored. The preflight checks below already set
    // it, which is why `--check` never did this and the running collector always did.
    child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    child.on('error', function (err) {
      log('could not start rtl_433: ' + err.message);
      if (err.code === 'ENOENT') {
        log('  WATER_RTL433_CMD does not point at an executable.');
        log('  Ubuntu:  which rtl_433');
        log('  Windows: set the full path to rtl_433_64bit_static.exe in .env');
      }
    });

    const rl = createInterface({ input: child.stdout });
    rl.on('line', function (line) {
      const t = String(line).trim();
      // Reset the backoff only on a line that could actually BE a meter packet.
      //
      // The bug this fixes: newer rtl_433 builds print their banner ("rtl_433 version ...",
      // "New defaults active...", "Found Rafael Micro R820T tuner") to stdout. Treating any line as
      // proof of health reset the delay to 1s on every launch, so a dongle that could not tune was
      // retried once a second forever — futile, unreadable in the log, and actively harmful, since
      // hammering the USB device is itself a cause of "[R82XX] PLL not locked!".
      if (t.charAt(0) === '{') delay = 1000;
      onLine(t);
    });

    child.stderr.on('data', function (d) { process.stderr.write(d); });

    child.on('close', function (code) {
      if (stopping) return;
      log('rtl_433 exited (' + code + '); restarting in ' + (delay / 1000) + 's' +
        (delay >= 30000 ? '  — it has been failing for a while; check the dongle, not the software' : ''));
      setTimeout(launch, delay);
      delay = Math.min(delay * 2, 60000);
    });
  }

  launch();

  return {
    stop: function () {
      stopping = true;
      try { if (child) child.kill(); } catch (e) { /* already gone */ }
    },
  };
}

/**
 * start_replay — feed lines from a captured .jsonl, or synthesise a plausible meter.
 *
 * The synthetic meter mimics the real one: it ticks every few seconds, mostly with no change, with
 * occasional household draws. Pass leak:true to make it trickle continuously, which is how you
 * prove the continuous-flow and overnight rules actually fire.
 */
function start_replay(opts) {
  const onLine = opts.onLine;
  const log = opts.log || console.log;
  const meter_id = opts.meter_id;
  const interval = Number(opts.interval_ms) || 3000;

  let timer = null;
  let stopped = false;

  // File replay
  if (opts.file && fs.existsSync(opts.file)) {
    log('replaying from ' + opts.file);
    const lines = fs.readFileSync(opts.file, 'utf8').split(/\r?\n/).filter(function (l) { return l.trim(); });
    let i = 0;
    timer = setInterval(function () {
      if (stopped) return;
      if (i >= lines.length) { log('replay file exhausted; looping'); i = 0; }
      onLine(lines[i++]);
    }, interval);
    return { stop: function () { stopped = true; clearInterval(timer); } };
  }

  // Synthetic meter
  log('replaying a SYNTHETIC meter (no dongle, no capture file). id=' + meter_id);
  let volume = Number(opts.start_volume) || 794120;   // continues from the real hose-test reading
  let tick = 0;
  timer = setInterval(function () {
    if (stopped) return;
    tick++;
    if (opts.leak) {
      volume += 1;                                     // a steady trickle — a running flapper
    } else if (tick % 20 === 0) {
      volume += 1 + Math.floor(Math.random() * 6);     // an occasional household draw
    }
    onLine(JSON.stringify({
      time: new Date().toISOString(),
      model: 'Badger-ORION',
      id: meter_id,
      'Flags-1': 0,
      Volume: volume,
      'Flags-2': 0,
      Integrity: 'CRC',
    }));
  }, interval);

  return { stop: function () { stopped = true; clearInterval(timer); } };
}

function start(opts) {
  return opts.mode === 'replay' ? start_replay(opts) : start_live(opts);
}

/**
 * check_command — can we actually run the decoder?
 *
 * Matters more since WATER_RTL433_CMD became a bare `rtl_433` resolved from PATH: a PATH that is
 * right in your shell but missing under pm2 or systemd is a classic silent failure. Without this,
 * the first sign of trouble is the collector's restart loop backing off in a log nobody is reading.
 *
 * Two modes, because the answer is found differently:
 *   the value looks like a path  -> does the file exist?
 *   the value is a bare name     -> does it resolve on PATH and run?
 */
function check_command(cmd) {
  if (!cmd) return { ok: false, how: 'unset', reason: 'WATER_RTL433_CMD is empty' };

  if (cmd.indexOf('/') >= 0 || cmd.indexOf('\\') >= 0) {
    if (fs.existsSync(cmd)) return { ok: true, how: 'path', detail: cmd };
    return { ok: false, how: 'path', reason: 'no file at ' + cmd };
  }

  const r = spawnSync(cmd, ['-V'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.error) {
    return {
      ok: false,
      how: 'PATH',
      reason: r.error.code === 'ENOENT'
        ? '"' + cmd + '" is not on PATH'
        : r.error.message,
    };
  }
  // rtl_433 prints its banner to stderr and may exit non-zero for -V; running at all is the signal.
  const first = String((r.stdout || '') + (r.stderr || '')).split('\n')[0].trim();
  return { ok: true, how: 'PATH', detail: first || cmd };
}

/**
 * has_orion_decoder — is protocol 223 compiled into THIS build?
 *
 * The apt rtl_433 is frequently too old to include the Badger ORION decoder, and the symptom is
 * simply that nothing ever decodes — indistinguishable from bad reception. This is UBUNTU_DEPLOY
 * step 2, run automatically so it is answered before you go looking at antennas.
 */
function has_orion_decoder(cmd) {
  const r = spawnSync(cmd, ['-R', 'help'], {
    encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) return { ok: false, reason: r.error.message };
  const out = String((r.stdout || '') + (r.stderr || ''));
  if (!out) return { ok: false, reason: 'no protocol list returned' };
  const line = out.split('\n').find(function (l) { return /orion/i.test(l); });
  if (line) return { ok: true, detail: line.trim() };
  return { ok: false, reason: 'protocol 223 (Badger ORION) is not in this build — build rtl_433 from source' };
}

module.exports = {
  start, start_live, start_replay, parse_args, check_command, has_orion_decoder,
  resolve_cmd, resolve_args, cmd_source, DEFAULT_ARGS,
};
