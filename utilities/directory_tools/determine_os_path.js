'use strict';
/**
 * determine_os_path.js — where home_assist keeps its runtime data, per platform.
 *
 * Same pattern as wrestling_stats/utilities/directory_tools/determine_os_path.js: three flat
 * constants and one ternary. Deliberately NOT usat_apps' per-username map — that exists because
 * usat runs on a multi-account deployed server (`usat-server` alongside `steve-calla`) and has to
 * branch on who is running it. home_assist, like wrestling_stats, is a personal project on personal
 * machines: one account per platform. Copying the map would mean inheriting machinery for a problem
 * this repo does not have, plus its failure mode (an unlisted username silently resolving to
 * someone else's path).
 *
 * WHY WINDOWS POINTS AT THE MYSQL UPLOADS FOLDER
 *
 * MySQL's `secure_file_priv` restricts the directory the MySQL *server* may read from and write to
 * (LOAD DATA INFILE / SELECT ... INTO OUTFILE). On Windows that is
 * `C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/`, and it is not relocatable without editing my.ini.
 * Rather than maintain two data locations per platform — one for anything MySQL touches and one for
 * everything else — the constrained requirement picks the location and everything else follows it.
 * One path per project, matching usat_apps and wrestling_stats exactly.
 *
 * CAVEAT worth knowing: that Windows path is version-numbered. A MySQL 8.0 -> 8.4 upgrade or an
 * uninstall can remove or relocate the folder, taking auth.json and panel_access.json with it. Low
 * stakes — auth.json regenerates and the .env recovery admin means you cannot be locked out — but it
 * is a surprise rather than a mystery if you know in advance.
 *
 * Override the whole thing with HOMEASSIST_DATA_DIR (used by the tests).
 */
const os = require('os');

// USERNAME NOTE: your repos currently disagree about the Mac account name — wrestling_stats'
// determine_os_path.js says `stevecalla`, its .env says `steve-calla`, and usat says `teamkwsc`.
// `steve-calla` is used here because it is the majority spelling and the one in the file you
// maintain by hand. If it is wrong, this is the only line to change.
const data_path_linux = '/home/steve-calla/development/home_assist/data';
const data_path_mac = '/Users/steve-calla/development/home_assist/data';
const data_path_windows = 'C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/data/home_assist';

// Exported so the tests can assert each platform's path without mocking process.platform.
const PATHS = { linux: data_path_linux, darwin: data_path_mac, win32: data_path_windows };

function determine_os_user_sync() {
  try { return os.userInfo().username; }
  catch (e) { return process.env.USER || process.env.USERNAME || 'unknown'; }
}

async function determine_os_user() { return determine_os_user_sync(); }

/**
 * The synchronous resolver. auth/auth_store.js and access/panel_access.js read and write with
 * sync fs, so they need the path without awaiting — the same reason usat_apps carries
 * determineOSPathSync alongside its async version. wrestling_stats' is declared `async` but does
 * nothing asynchronous inside, so this is the same function without the wrapper.
 */
function determine_os_path_sync() {
  if (process.env.HOMEASSIST_DATA_DIR) return process.env.HOMEASSIST_DATA_DIR;
  const is_mac = process.platform === 'darwin';
  const is_linux = process.platform === 'linux';
  const os_path = is_mac ? data_path_mac : (is_linux ? data_path_linux : data_path_windows);
  return os_path;
}

async function determine_os_path() { return determine_os_path_sync(); }

module.exports = {
  PATHS,
  determine_os_path,
  determine_os_path_sync,
  determine_os_user,
  determine_os_user_sync,
};
