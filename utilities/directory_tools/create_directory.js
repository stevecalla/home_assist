'use strict';
/**
 * create_directory.js — mkdir -p a named folder under the platform data path.
 *
 * Same shape as wrestling_stats/utilities/directory_tools/create_directory.js: resolve the base,
 * join the subfolder, create it recursively, hand back the path.
 *
 * The sync sibling exists for the same reason determine_os_path_sync does — the auth and
 * panel-access stores write with sync fs.
 *
 * Never throws. A read-only data directory degrades to "the in-memory object still works" rather
 * than taking down a process whose actual job is watching for a flooded basement.
 */
const fs = require('fs');
const path = require('path');
const { determine_os_path, determine_os_path_sync } = require('./determine_os_path');

function create_directory_sync(directory_name) {
  const os_path = determine_os_path_sync();
  const directory_path = directory_name ? path.join(os_path, directory_name) : os_path;
  try { fs.mkdirSync(directory_path, { recursive: true }); } catch (e) { /* best-effort */ }
  return directory_path;
}

async function create_directory(directory_name) {
  const os_path = await determine_os_path();
  const directory_path = directory_name ? path.join(os_path, directory_name) : os_path;
  try { fs.mkdirSync(directory_path, { recursive: true }); } catch (e) { /* best-effort */ }
  return directory_path;
}

module.exports = { create_directory, create_directory_sync };
