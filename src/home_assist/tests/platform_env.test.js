'use strict';
/**
 * platform_env.test.js — one .env, two machines.
 *
 * Mirrors the suffix convention already used in wrestling_stats' .env
 * (`GOOGLE_APPLICATION_CREDENTIALS_LINUX / _MAC / _WINDOWS`) so the Windows laptop and the Ubuntu
 * box can share a single file instead of each keeping its own and remembering which line to
 * comment out.
 *
 * The case worth pinning hardest is the empty string: a stray `WATER_RTL433_CMD=` left in the file
 * must NOT defeat the platform-specific value. That failure would look like "it just stopped
 * finding the radio", with a .env that reads as if it were configured.
 */
const test = require('node:test');
const assert = require('node:assert');

const { platform_env, platform_env_source, PLATFORM_SUFFIX } = require('../env');

const NAME = 'HA_TEST_SETTING';
const SUFFIX = PLATFORM_SUFFIX[process.platform];
const SCOPED = NAME + '_' + SUFFIX;
const OTHER = NAME + '_' + (SUFFIX === 'LINUX' ? 'WINDOWS' : 'LINUX');

function clear() { delete process.env[NAME]; delete process.env[SCOPED]; delete process.env[OTHER]; }
test.beforeEach(clear);
test.after(clear);

test('falls back to the default when nothing is set', function () {
  assert.strictEqual(platform_env(NAME, 'fallback'), 'fallback');
  assert.strictEqual(platform_env_source(NAME), null);
});

test('uses the platform-suffixed value', function () {
  process.env[SCOPED] = 'for-this-platform';
  assert.strictEqual(platform_env(NAME, 'fallback'), 'for-this-platform');
  assert.strictEqual(platform_env_source(NAME), SCOPED);
});

test('ignores another platform\'s value', function () {
  process.env[OTHER] = 'for-the-other-machine';
  assert.strictEqual(platform_env(NAME, 'fallback'), 'fallback',
    'a Windows path must not be picked up on Linux, or vice versa');
});

test('the unsuffixed name overrides the platform value', function () {
  process.env[SCOPED] = 'platform';
  process.env[NAME] = 'explicit';
  assert.strictEqual(platform_env(NAME, 'fallback'), 'explicit');
  assert.strictEqual(platform_env_source(NAME), NAME);
});

test('an EMPTY unsuffixed value does not defeat the platform value', function () {
  // The trap: `WATER_RTL433_CMD=` left in the file. dotenv sets it to '', which is truthy-enough
  // for a naive `process.env.X || default` to... actually fall through, but NOT for `!== undefined`
  // checks. Treating empty as unset is the only reading that matches what someone typing that line
  // intends.
  process.env[NAME] = '';
  process.env[SCOPED] = 'platform';
  assert.strictEqual(platform_env(NAME, 'fallback'), 'platform');
  assert.strictEqual(platform_env_source(NAME), SCOPED);
});

test('whitespace-only is also treated as unset', function () {
  process.env[NAME] = '   ';
  process.env[SCOPED] = 'platform';
  assert.strictEqual(platform_env(NAME, 'fallback'), 'platform');
});

test('values are trimmed — a trailing space in .env must not break a path', function () {
  process.env[SCOPED] = '  /usr/local/bin/rtl_433  ';
  assert.strictEqual(platform_env(NAME, 'x'), '/usr/local/bin/rtl_433');
});

test('every platform we support has a suffix', function () {
  assert.deepStrictEqual(
    Object.keys(PLATFORM_SUFFIX).sort(),
    ['darwin', 'linux', 'win32']
  );
  assert.ok(SUFFIX, 'the current platform must map to a suffix');
});

// ───────────────────── the real consumer ─────────────────────

test('the rtl_433 resolver uses the convention end to end', function () {
  const rtl433 = require('../modules/water/collector/rtl433');
  const saved = { c: process.env.WATER_RTL433_CMD, s: process.env['WATER_RTL433_CMD_' + SUFFIX] };
  try {
    delete process.env.WATER_RTL433_CMD;
    process.env['WATER_RTL433_CMD_' + SUFFIX] = '/some/platform/rtl_433';
    assert.strictEqual(rtl433.resolve_cmd(), '/some/platform/rtl_433');
    assert.strictEqual(rtl433.cmd_source(), 'WATER_RTL433_CMD_' + SUFFIX);

    process.env.WATER_RTL433_CMD = '/override/rtl_433';
    assert.strictEqual(rtl433.resolve_cmd(), '/override/rtl_433');
  } finally {
    if (saved.c === undefined) delete process.env.WATER_RTL433_CMD; else process.env.WATER_RTL433_CMD = saved.c;
    if (saved.s === undefined) delete process.env['WATER_RTL433_CMD_' + SUFFIX]; else process.env['WATER_RTL433_CMD_' + SUFFIX] = saved.s;
  }
});

test('with nothing set at all, the resolver still returns a usable default', function () {
  const rtl433 = require('../modules/water/collector/rtl433');
  const saved = { c: process.env.WATER_RTL433_CMD, s: process.env['WATER_RTL433_CMD_' + SUFFIX] };
  try {
    delete process.env.WATER_RTL433_CMD;
    delete process.env['WATER_RTL433_CMD_' + SUFFIX];
    assert.strictEqual(rtl433.resolve_cmd(), 'rtl_433');
    assert.match(rtl433.resolve_args(), /-R 223/);
  } finally {
    if (saved.c === undefined) delete process.env.WATER_RTL433_CMD; else process.env.WATER_RTL433_CMD = saved.c;
    if (saved.s === undefined) delete process.env['WATER_RTL433_CMD_' + SUFFIX]; else process.env['WATER_RTL433_CMD_' + SUFFIX] = saved.s;
  }
});
