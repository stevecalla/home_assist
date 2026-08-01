'use strict';
/**
 * env.js — load the repo-root .env, from anywhere in the tree.
 *
 * Every entry point needs this, and hand-counting '..' segments per file is exactly the kind of
 * quiet bug that shows up as "Access denied for user 'root'@'localhost' (using password: NO)" —
 * dotenv silently loaded nothing, so MYSQL_PASSWORD was never set.
 *
 * Walk up until we find the package.json that owns this repo, and load the .env beside it.
 * Require this ONCE, first thing, in any file that can be run directly.
 */
const fs = require('fs');
const path = require('path');

function repo_root() {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(__dirname, '..', '..');
}

const ROOT = repo_root();
let loaded = false;

function load() {
  if (loaded) return ROOT;
  loaded = true;
  try { require('dotenv').config({ path: path.join(ROOT, '.env') }); }
  catch (e) { /* dotenv not installed yet (fresh clone) — env vars may still be set by the shell */ }
  return ROOT;
}

load();

/**
 * platform_env — read a setting that differs per machine, using the same suffix convention as
 * wrestling_stats' .env:
 *
 *     GOOGLE_APPLICATION_CREDENTIALS_LINUX / _MAC / _WINDOWS
 *
 * Applied here so ONE .env can be kept in sync across the Windows laptop and the Ubuntu box,
 * instead of maintaining a separate file per machine and remembering which line to comment out.
 *
 * Resolution order, first non-empty wins:
 *   1. NAME                — an explicit override, always wins
 *   2. NAME_<PLATFORM>     — _WINDOWS / _LINUX / _MAC
 *   3. the supplied default
 *
 * Empty strings count as unset, so a stray `WATER_RTL433_CMD=` does not silently defeat the
 * platform value — which is exactly the kind of thing that would look like "it just stopped
 * finding the radio".
 */
const PLATFORM_SUFFIX = { win32: 'WINDOWS', linux: 'LINUX', darwin: 'MAC' };

function platform_env(name, fallback) {
  const direct = process.env[name];
  if (direct !== undefined && String(direct).trim() !== '') return String(direct).trim();

  const suffix = PLATFORM_SUFFIX[process.platform];
  if (suffix) {
    const scoped = process.env[name + '_' + suffix];
    if (scoped !== undefined && String(scoped).trim() !== '') return String(scoped).trim();
  }
  return fallback;
}

// Which key actually supplied the value — for the preflight, so "where did that come from?" is
// answerable without reading .env.
function platform_env_source(name) {
  const direct = process.env[name];
  if (direct !== undefined && String(direct).trim() !== '') return name;
  const suffix = PLATFORM_SUFFIX[process.platform];
  if (suffix) {
    const key = name + '_' + suffix;
    const scoped = process.env[key];
    if (scoped !== undefined && String(scoped).trim() !== '') return key;
  }
  return null;
}

module.exports = { ROOT, load, repo_root, platform_env, platform_env_source, PLATFORM_SUFFIX };
