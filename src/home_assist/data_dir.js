'use strict';
/**
 * data_dir.js — the home for home_assist runtime data, OUTSIDE the repo.
 *
 * A thin wrapper over utilities/directory_tools/{determine_os_path, create_directory} — the same
 * two-function pair wrestling_stats uses. Same role as src/usat_apps/data_dir.js.
 *
 *   <determine_os_path()>/
 *     auth.json           local user store (scrypt-hashed passwords + session secret)
 *     panel_access.json   per-user panel allow-list (default + per-user overrides)
 *     captures/           saved rtl_433 .jsonl captures (for replay + field-name forensics)
 *     logs/               anything written to disk rather than to pm2
 *
 * Nothing here is ever committed — the repo has no data/ folder at all, which is why a `git clean`
 * or a fresh clone on the Ubuntu box cannot destroy your credentials.
 *
 * Unlike usat_apps, no project subfolder is appended: the resolved base is already scoped to
 * home_assist on every platform (`.../development/home_assist/data`, `.../Uploads/data/home_assist`),
 * whereas usat's `.../usat/data/` is shared across several usat apps and needs the extra level.
 *
 * Override the base with HOMEASSIST_DATA_DIR.
 */
const path = require('path');
const { determine_os_path, determine_os_path_sync, determine_os_user_sync } =
  require('../../utilities/directory_tools/determine_os_path');
const { create_directory, create_directory_sync } =
  require('../../utilities/directory_tools/create_directory');

function base_sync() { return determine_os_path_sync(); }
async function base() { return determine_os_path(); }

async function ensure(sub) { return create_directory(sub); }
function ensure_sync(sub) { return create_directory_sync(sub); }

// Sync resolver (no mkdir) for modules that compute a file path at read/write time
// (auth/auth_store.js, access/panel_access.js).
function file_sync(name) { return path.join(base_sync(), name); }

// Named subfolders, created on demand.
function captures_dir() { return ensure_sync('captures'); }
function logs_dir() { return ensure_sync('logs'); }

// What `node src/home_assist/admin.js where` prints.
function describe() {
  return {
    platform: process.platform,
    user: determine_os_user_sync(),
    app_data: base_sync(),
    overridden: !!process.env.HOMEASSIST_DATA_DIR,
  };
}

module.exports = { base, base_sync, ensure, ensure_sync, file_sync, captures_dir, logs_dir, describe };
