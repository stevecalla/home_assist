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
//
// These are the three that CHANGE something or expose the plumbing: thresholds and recipients
// (settings), which meters may email whom (meters), and the raw decoder feed plus the SMTP check
// (diagnostics). Reading the water data is the default; altering who gets woken at 3am is not.
const DEFAULT_ALL_EXCLUDE = ['admin', 'water-settings', 'water-meters', 'water-diagnostics'];

/**
 * Panel keys that no longer exist, and what they meant.
 *
 * Access moved from two coarse water panels to one per page. A stored grant of `['water']` would
 * otherwise be filtered out by normalize() as an unknown key and leave that user with NOTHING --
 * a silent lockout, discovered only when someone says the app went blank. Expanding instead of
 * dropping keeps every existing grant meaning exactly what it meant before the split.
 *
 * The old file is never rewritten in place; expansion happens on read, and the new keys are what
 * get persisted the next time an admin saves that user. So a rollback still finds a file it
 * understands.
 */
/**
 * Panels that appear in the catalog but can NEVER be granted through panel access.
 *
 * `admin` is governed by the ROLE, and is_allowed() hard-refuses it for a non-admin regardless of
 * what any list says. Leaving it grantable produced a control that silently did nothing: an admin
 * ticks "Users & access" for a user, the key is stored, the summary line dutifully reports that
 * they can see it -- and they cannot. A stored permission that the authorization check ignores is
 * worse than a missing feature, because it reads as done.
 *
 * It stays in the catalog so its label still resolves wherever a key is rendered; it is simply not
 * storable. To make someone an admin, change their role.
 */
const NOT_GRANTABLE = ['admin'];

const LEGACY_PANELS = {
  water: ['water-monitor', 'water-history', 'water-alerts', 'water-reference'],
  'water-admin': ['water-settings', 'water-meters', 'water-diagnostics'],
};

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
  const out = [];
  list.forEach(function (x) {
    // A retired key expands to the panels it used to cover. Filtering it out instead would silently
    // revoke access rather than migrate it.
    const expanded = LEGACY_PANELS[x] || [x];
    expanded.forEach(function (key) {
      if (NOT_GRANTABLE.indexOf(key) >= 0) return;   // role-governed; a stored grant would be a lie
      if (k.indexOf(key) >= 0 && out.indexOf(key) < 0) out.push(key);
    });
  });
  return out;
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
  DEFAULT_ALL_EXCLUDE, PLATFORM_PANELS, LEGACY_PANELS, NOT_GRANTABLE,
};
