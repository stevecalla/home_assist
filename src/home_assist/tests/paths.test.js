'use strict';
/**
 * paths.test.js — where runtime data lands, per platform.
 *
 * Worth pinning because it is silent when wrong: a bad path means auth.json is written somewhere
 * unexpected, which looks like "my users disappeared" rather than like an error. And this repo moves
 * between Windows and Ubuntu, so the platform branch is exercised for real.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const osp = require('../../../utilities/directory_tools/determine_os_path');
const { create_directory_sync } = require('../../../utilities/directory_tools/create_directory');

test('every platform has a path, and they are absolute', function () {
  ['linux', 'darwin', 'win32'].forEach(function (p) {
    assert.ok(osp.PATHS[p], p + ' has no path');
    assert.ok(/^(\/|[A-Za-z]:)/.test(osp.PATHS[p]), p + ' path is not absolute: ' + osp.PATHS[p]);
  });
});

test('the mac path uses /Users and the linux path uses /home', function () {
  // Guards the exact copy-paste slip present in wrestling_stats, where a `mac:` key holds a
  // /home/... path — silently correct-looking, always wrong.
  assert.ok(osp.PATHS.darwin.startsWith('/Users/'), 'mac path must start with /Users/');
  assert.ok(osp.PATHS.linux.startsWith('/home/'), 'linux path must start with /home/');
});

test('the windows path is the MySQL secure_file_priv folder', function () {
  // Deliberate: MySQL cannot read or write outside it, so the constrained requirement picks the
  // location and everything else follows. Matches usat_apps and wrestling_stats.
  assert.match(osp.PATHS.win32, /ProgramData\/MySQL\/MySQL Server .*\/Uploads\/data\//);
});

test('every path is scoped to this project', function () {
  ['linux', 'darwin', 'win32'].forEach(function (p) {
    assert.ok(osp.PATHS[p].includes('home_assist'), p + ' path is not project-scoped');
  });
});

test('HOMEASSIST_DATA_DIR overrides everything', function () {
  const saved = process.env.HOMEASSIST_DATA_DIR;
  process.env.HOMEASSIST_DATA_DIR = '/tmp/override-me';
  try {
    assert.strictEqual(osp.determine_os_path_sync(), '/tmp/override-me');
  } finally {
    if (saved === undefined) delete process.env.HOMEASSIST_DATA_DIR;
    else process.env.HOMEASSIST_DATA_DIR = saved;
  }
});

test('the sync and async resolvers agree', async function () {
  assert.strictEqual(await osp.determine_os_path(), osp.determine_os_path_sync());
});

test('there is no username-map fallback to go wrong', function () {
  // usat_apps (and the copy of it in wrestling_stats) falls back to a hardcoded account name when
  // the running user is not in its map — in wrestling that key does not exist, so path.join gets
  // undefined and throws. Three flat constants make that failure mode impossible, so assert the
  // resolver returns a usable string no matter who is running it.
  const p = osp.determine_os_path_sync();
  assert.strictEqual(typeof p, 'string');
  assert.ok(p.length > 0);
});

test('create_directory_sync makes the folder and returns the path', function () {
  const saved = process.env.HOMEASSIST_DATA_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-paths-'));
  process.env.HOMEASSIST_DATA_DIR = tmp;
  try {
    const made = create_directory_sync('captures');
    assert.strictEqual(made, path.join(tmp, 'captures'));
    assert.ok(fs.existsSync(made));
    // no argument -> the base itself
    assert.strictEqual(create_directory_sync(), tmp);
  } finally {
    if (saved === undefined) delete process.env.HOMEASSIST_DATA_DIR;
    else process.env.HOMEASSIST_DATA_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('create_directory_sync does not throw when the directory cannot be created', function () {
  // A read-only or impossible data dir must degrade to "the in-memory object still works", never
  // take down the process whose job is watching for a flooded basement.
  //
  // Uses a regular FILE as the parent (guaranteed ENOTDIR, instantly, on every platform) rather
  // than a permission-denied path — /proc paths in particular can block indefinitely in a
  // container, which is a hang in the test rather than a finding about the code.
  const saved = process.env.HOMEASSIST_DATA_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-nodir-'));
  const blocker = path.join(tmp, 'i-am-a-file');
  fs.writeFileSync(blocker, 'not a directory');
  process.env.HOMEASSIST_DATA_DIR = blocker;
  try {
    let out;
    assert.doesNotThrow(function () { out = create_directory_sync('x'); });
    assert.strictEqual(out, path.join(blocker, 'x'), 'still returns the path it would have used');
    assert.ok(!fs.existsSync(out), 'and did not somehow create it');
  } finally {
    if (saved === undefined) delete process.env.HOMEASSIST_DATA_DIR;
    else process.env.HOMEASSIST_DATA_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
