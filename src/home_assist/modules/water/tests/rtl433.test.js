'use strict';
/**
 * rtl433.test.js — argument parsing and "can we actually run the decoder?".
 *
 * The command check matters more now that WATER_RTL433_CMD is a bare `rtl_433` resolved from PATH.
 * A PATH that works in your shell but not under pm2 or systemd is a classic silent failure: the
 * collector's restart loop just backs off forever in a log nobody is reading.
 *
 * `node` stands in for `rtl_433` here — it is guaranteed present and on PATH wherever these tests
 * run, so the resolution logic is exercised without requiring the SDR toolchain.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const rtl433 = require('../collector/rtl433');

// ───────────────────────── parse_args ─────────────────────────

test('parses the real decoder args', function () {
  assert.deepStrictEqual(
    rtl433.parse_args('-f 916.45M -s 1600k -R 223 -F json'),
    ['-f', '916.45M', '-s', '1600k', '-R', '223', '-F', 'json']
  );
});

test('keeps double-quoted segments together', function () {
  assert.deepStrictEqual(rtl433.parse_args('-F "json:/tmp/a b.json"'), ['-F', 'json:/tmp/a b.json']);
});

test('tolerates extra whitespace and an empty string', function () {
  assert.deepStrictEqual(rtl433.parse_args('  -f   916.45M  '), ['-f', '916.45M']);
  assert.deepStrictEqual(rtl433.parse_args(''), []);
  assert.deepStrictEqual(rtl433.parse_args(undefined), []);
});

// ───────────────────────── check_command ─────────────────────────

test('an empty command is reported, not ignored', function () {
  const r = rtl433.check_command('');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.how, 'unset');
});

test('a bare name that resolves on PATH is ok', function () {
  const r = rtl433.check_command('node');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.how, 'PATH');
  assert.ok(r.detail, 'should report what it found');
});

test('a bare name that is NOT on PATH says so plainly', function () {
  const r = rtl433.check_command('definitely-not-a-real-binary-xyzzy');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.how, 'PATH');
  assert.match(r.reason, /not on PATH/);
});

test('a full path that exists is ok, and is not executed', function () {
  // Deliberately points at a file, not a program: an explicit path is checked for existence only,
  // so a Windows .exe path can be validated on any machine.
  const self = path.join(__dirname, 'rtl433.test.js');
  const r = rtl433.check_command(self);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.how, 'path');
});

test('a full path that does not exist names the path', function () {
  const missing = path.join(__dirname, 'no-such-rtl_433.exe');
  const r = rtl433.check_command(missing);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.how, 'path');
  assert.match(r.reason, /no file at/);
});

test('a Windows-style path is treated as a path, not a PATH lookup', function () {
  const r = rtl433.check_command('C:\\Users\\calla\\development\\tools\\rtl_433-win-x64\\rtl_433_64bit_static.exe');
  assert.strictEqual(r.how, 'path', 'backslashes must be recognised as a path on every platform');
  assert.strictEqual(r.ok, false);   // not present in the test env, which is the point
});

// ───────────────────────── has_orion_decoder ─────────────────────────

test('a program with no Orion protocol list is reported as a problem, not a crash', function () {
  // `node -R help` does not print a protocol list; the check must degrade to a clear message.
  const r = rtl433.has_orion_decoder('node');
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason, 'must explain itself');
});

test('a missing binary does not throw', function () {
  assert.doesNotThrow(function () { rtl433.has_orion_decoder('definitely-not-a-real-binary-xyzzy'); });
});

test('the live spawn hides the Windows console window', function () {
  // Not cosmetic on a machine that lives in a basement: rtl_433 is a console-subsystem exe, Node's
  // spawn defaults to windowsHide:false, and the collector relaunches the radio on every failure.
  // A dongle that cannot tune therefore opens a cmd window per retry until someone notices.
  const src = require('fs').readFileSync(require.resolve('../collector/rtl433'), 'utf8');
  const spawns = src.match(/spawn(?:Sync)?\([^;]*?\{[^}]*\}/gs) || [];
  assert.ok(spawns.length >= 3, 'expected to find the spawn calls');
  spawns.forEach(function (s) {
    assert.match(s, /windowsHide:\s*true/, 'a spawn without windowsHide:true -> ' + s.slice(0, 80));
  });
});
