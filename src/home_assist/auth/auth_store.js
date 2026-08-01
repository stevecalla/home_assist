'use strict';
// Local user store for home_assist: scrypt-hashed passwords (per-user salt, timing-safe compare),
// persisted to a JSON file OUTSIDE the repo. A generated session_secret signs cookies.
// Ported from src/usat_apps/auth/auth_store.js with HOMEASSIST_* env names.
//
// AUTHENTICATION SEAM: this store owns the *local password* login method. If you ever want SSO,
// it resolves to the same user records by login string; nothing here changes except adding an
// alternate "verify identity" path. Users carry a role — panel access is separate (access/panel_access.js).
//
// .env recovery accounts are ALWAYS valid (so you can't lock yourself out) and carry role 'admin':
//   HOMEASSIST_ADMIN_USER / HOMEASSIST_ADMIN_PASS
//   HOMEASSIST_TEST_USER  / HOMEASSIST_TEST_PASS    (optional second admin)
//
// Stored users live in <data_dir>/auth.json (override HOMEASSIST_USERS_FILE).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const data_dir = require('../data_dir');

// Resolved lazily so tests can set HOMEASSIST_DATA_DIR / HOMEASSIST_USERS_FILE after require().
function file() { return process.env.HOMEASSIST_USERS_FILE || data_dir.file_sync('auth.json'); }

// Recovery accounts (role admin, always valid, never removable). A pair counts only if BOTH the user
// AND the password are set. Deduped by username; evaluated fresh each call so .env edits apply on restart.
function recovery_accounts() {
  const raw = [
    { u: process.env.HOMEASSIST_ADMIN_USER, p: process.env.HOMEASSIST_ADMIN_PASS, role: 'admin' },
    { u: process.env.HOMEASSIST_TEST_USER, p: process.env.HOMEASSIST_TEST_PASS, role: 'admin' },
  ];
  const seen = {}; const out = [];
  for (const a of raw) { if (a.u && a.p && !seen[a.u]) { seen[a.u] = 1; out.push(a); } }
  return out;
}

function hash_password(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw == null ? '' : pw), salt, 32);
  return 'scrypt$' + salt.toString('base64') + '$' + h.toString('base64');
}

function verify_password(pw, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const p = stored.split('$');
  if (p.length !== 3 || p[0] !== 'scrypt') return false;
  const salt = Buffer.from(p[1], 'base64'); const exp = Buffer.from(p[2], 'base64');
  let act; try { act = crypto.scryptSync(String(pw == null ? '' : pw), salt, exp.length); } catch (e) { return false; }
  return act.length === exp.length && crypto.timingSafeEqual(act, exp);
}

function ensure(o) {
  o = o || {};
  if (!o.session_secret) o.session_secret = crypto.randomBytes(32).toString('base64');
  if (!Array.isArray(o.users)) o.users = [];
  return o;
}
function read() { try { return ensure(JSON.parse(fs.readFileSync(file(), 'utf8'))); } catch (e) { return ensure({}); } }
// Best-effort persist: if the data dir is read-only, don't crash — the in-memory object still works.
function write(o) {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(ensure(o), null, 2) + '\n', { mode: 0o600 });
  } catch (e) { /* read-only data dir — fall back to in-memory */ }
}
function load_or_init() { const had = fs.existsSync(file()); const o = read(); if (!had) write(o); return o; }

// Cookie-signing secret: HOMEASSIST_SESSION_SECRET if set, else the one persisted in auth.json
// (auto-generated on first run). Cached after the first resolve (called on EVERY authed request).
let _secret_cache = null;
function session_secret() {
  if (process.env.HOMEASSIST_SESSION_SECRET) return process.env.HOMEASSIST_SESSION_SECRET;
  if (_secret_cache) return _secret_cache;
  _secret_cache = load_or_init().session_secret;
  return _secret_cache;
}
// Test hook: forget the cached secret (used when a test points HOMEASSIST_DATA_DIR somewhere new).
function _reset_secret_cache() { _secret_cache = null; }

function list_users() { return read().users.map(function (u) { return { user: u.user, role: u.role || 'user' }; }); }

// .env accounts surfaced for the Access pane (recovery accounts — always valid, never removable).
function env_accounts() {
  return recovery_accounts().map(function (a) { return { user: a.u, role: a.role, source: 'env' }; });
}

// role is optional; defaults to 'user'. add_user updates password/role if the user exists.
function add_user(user, pass, role) {
  const o = read();
  const ex = o.users.filter(function (u) { return u.user === user; })[0];
  const hash = hash_password(pass);
  const r = (role === 'admin' || role === 'user') ? role : null;
  if (ex) { ex.hash = hash; if (r) ex.role = r; }
  else o.users.push({ user: String(user), hash: hash, role: r || 'user' });
  write(o);
  return { user: user, role: r || (ex && ex.role) || 'user' };
}

function remove_user(user) {
  const o = read(); const n = o.users.length;
  o.users = o.users.filter(function (u) { return u.user !== user; });
  write(o);
  return o.users.length < n;
}

function valid_user(user, pass) {
  if (!user) return null;
  const p = String(pass == null ? '' : pass);
  const env_list = recovery_accounts();
  for (let i = 0; i < env_list.length; i++) {
    const a = env_list[i];
    if (user === a.u && p === String(a.p)) return { user: user, env: true, role: a.role };
  }
  const u = read().users.filter(function (x) { return x.user === user; })[0];
  if (u && verify_password(pass, u.hash)) return { user: u.user, role: u.role || 'user' };
  return null;
}

function login_configured() {
  return recovery_accounts().length > 0 || read().users.length > 0;
}

module.exports = {
  hash_password, verify_password, session_secret, list_users, env_accounts,
  add_user, remove_user, valid_user, login_configured, load_or_init, _reset_secret_cache,
};
