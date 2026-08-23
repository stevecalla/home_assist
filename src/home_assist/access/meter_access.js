'use strict';
/**
 * meter_access.js — which METERS a user may see. The sibling of access/panel_access.js, and
 * deliberately the same shape (get / set_default / set_user / clear_user / allowed / is_allowed),
 * persisted to meter_access.json in the same data dir outside the repo.
 *
 * Two independent questions, and conflating them is what this file exists to prevent:
 *
 *   panel_access  WHICH PAGES you can open        (Monitor, History, Settings…)
 *   meter_access  WHOSE DATA those pages show     (your meter, a neighbour's, all of them)
 *
 * Someone can legitimately have the Monitor page and only one meter on it.
 *
 * Unlike panels there is NO fixed catalog to validate against: meters appear in water_meters as the
 * radio decodes them, so a grant may name an id that has not been heard yet (a meter about to be
 * installed) and that is not an error. Validation is therefore shape-only — a positive safe integer.
 *
 * NOTE the default: 'all'. Every existing install keeps behaving exactly as it did until someone
 * narrows it, which is what makes this safe to deploy without a migration.
 */
const fs = require('fs');
const path = require('path');
const data_dir = require('../data_dir');

function file() {
  return process.env.HOMEASSIST_METER_ACCESS_FILE || data_dir.file_sync('meter_access.json');
}

function ensure(o) {
  o = o || {};
  if (o.default === undefined) o.default = 'all';   // every meter until narrowed
  if (!o.users || typeof o.users !== 'object') o.users = {};
  return o;
}
function read() { try { return ensure(JSON.parse(fs.readFileSync(file(), 'utf8'))); } catch (e) { return ensure({}); } }
function write(o) {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(ensure(o), null, 2) + '\n', { mode: 0o600 });
  } catch (e) { /* read-only data dir — the in-memory object still works */ }
}

/** Shape-only: positive safe integers, deduped, order preserved. */
function normalize(list) {
  if (list === 'all') return 'all';
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach(function (x) {
    const n = Number(x);
    if (!Number.isSafeInteger(n) || n <= 0) return;
    if (out.indexOf(n) < 0) out.push(n);
  });
  return out;
}

function get() { return read(); }
function set_default(list) { const o = read(); o.default = normalize(list); write(o); return o; }
function set_user(user, list) { const o = read(); o.users[String(user)] = normalize(list); write(o); return o; }
function clear_user(user) { const o = read(); delete o.users[String(user)]; write(o); return o; }

/**
 * The meters this user may see: an array of ids, or the string 'all'.
 *
 * Admins get 'all' unconditionally — the same rule panel_access uses, and for the same reason: the
 * person who can edit the grants must not be able to lock themselves out of the data.
 */
function allowed(user, role) {
  if ((role || 'user') === 'admin') return 'all';
  const o = read();
  const per = o.users[String(user)];
  return normalize(per !== undefined ? per : o.default);
}

function is_allowed(user, role, meter_id) {
  const a = allowed(user, role);
  if (a === 'all') return true;
  const n = Number(meter_id);
  return Number.isSafeInteger(n) && a.indexOf(n) >= 0;
}

/**
 * The meter `?meter=mine` resolves to FOR THIS USER.
 *
 * This is the change that makes the feature real rather than cosmetic. `mine` used to mean "the
 * meter the collector is configured for" — one global id. Restrict someone to a neighbour's meter
 * under that rule and `mine` would still hand them the owner's data, which is the exact thing the
 * restriction was meant to stop.
 *
 * `fallback` is the collector's own meter, used when the user has no restriction (or is an admin).
 */
function primary(user, role, fallback) {
  const a = allowed(user, role);
  if (a === 'all') return Number(fallback) || 0;
  // A restricted user whose set happens to include the collector's meter should still land there
  // first — it is the one they are most likely to mean.
  const fb = Number(fallback) || 0;
  if (fb && a.indexOf(fb) >= 0) return fb;
  return a.length ? a[0] : 0;
}

module.exports = {
  get, set_default, set_user, clear_user, allowed, is_allowed, primary, normalize,
};
