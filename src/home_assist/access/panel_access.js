'use strict';
// Panel access for home_assist: a gateable panel catalog + a default allow-list and optional per-user
// overrides, persisted to a JSON file outside the repo. Same interface as usat_apps' panel_access
// (catalog / keys / get / set_default / set_user / clear_user / effective_panels / is_allowed).
//
// The catalog is built DYNAMICALLY from the module registry — each module contributes its own panel
// keys — plus the platform-level panels below. So adding a module automatically adds its panels here;
// no edits to this file. That is the module contract's authorization surface. Admins see everything.
//
// The registry is required LAZILY (inside catalog(), not at load time) because module manifests pull
// in require_auth, which pulls in this file. Lazy resolution breaks that cycle.
const fs = require('fs');
const path = require('path');
const data_dir = require('../data_dir');

// Platform panels — owned by the shell itself, not by any feature module.
const PLATFORM_PANELS = [
  { key: 'admin', label: 'Users & access', group: 'Admin' },
];

// Sensitive panels excluded from the default 'all' grant — they need an explicit per-user grant
// (admins always see everything regardless). 'admin' is additionally hard-gated in is_allowed().
const DEFAULT_ALL_EXCLUDE = ['admin', 'water-admin'];

function module_panels() {
  let registry;
  try { registry = require('../modules/registry'); } catch (e) { return []; }
  try { return registry.panels(); } catch (e) { return []; }
}

function catalog() {
  const out = [];
  const seen = {};
  module_panels().forEach(function (p) {
    if (seen[p.key]) return;
    seen[p.key] = 1;
    out.push({ key: p.key, label: p.label, group: p.group || null });
  });
  PLATFORM_PANELS.forEach(function (p) {
    if (seen[p.key]) return;
    seen[p.key] = 1;
    out.push({ key: p.key, label: p.label, group: p.group || null });
  });
  return out;
}

function keys() { return catalog().map(function (p) { return p.key; }); }

function file() { return process.env.HOMEASSIST_PANEL_ACCESS_FILE || data_dir.file_sync('panel_access.json'); }

function ensure(o) {
  o = o || {};
  if (o.default === undefined) o.default = 'all'; // every non-admin sees every panel until narrowed
  if (!o.users || typeof o.users !== 'object') o.users = {};
  return o;
}
function read() { try { return ensure(JSON.parse(fs.readFileSync(file(), 'utf8'))); } catch (e) { return ensure({}); } }
function write(o) {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(ensure(o), null, 2) + '\n', { mode: 0o600 });
  } catch (e) { /* read-only data dir — best-effort */ }
}

function get() { return read(); }

function normalize(list) {
  if (list === 'all') return 'all';
  if (!Array.isArray(list)) return [];
  const k = keys();
  return list.filter(function (x) { return k.indexOf(x) >= 0; });
}
function set_default(list) { const o = read(); o.default = normalize(list); write(o); return o; }
function set_user(user, list) { const o = read(); o.users[String(user)] = normalize(list); write(o); return o; }
function clear_user(user) { const o = read(); delete o.users[String(user)]; write(o); return o; }

// The panels a specific user effectively has. Admins get everything.
function effective_panels(user, role) {
  if ((role || 'user') === 'admin') return keys();
  const o = read();
  const per = o.users[String(user)];
  const allow = per !== undefined ? per : o.default;
  return allow === 'all' ? keys().filter(function (k) { return DEFAULT_ALL_EXCLUDE.indexOf(k) < 0; }) : normalize(allow);
}

function is_allowed(user, role, panel) {
  if ((role || 'user') === 'admin') return true;
  if (panel === 'admin') return false; // only admins reach the admin panel
  return effective_panels(user, role).indexOf(panel) >= 0;
}

module.exports = {
  catalog, keys, get, set_default, set_user, clear_user, effective_panels, is_allowed,
  DEFAULT_ALL_EXCLUDE, PLATFORM_PANELS,
};
