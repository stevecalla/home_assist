'use strict';
/**
 * auth.test.js — authentication + authorization, with no database and no network.
 *
 * Exercises the whole chain the platform depends on: password hashing, the .env recovery account
 * that must never lock you out, session signing and tamper rejection, the module-driven panel
 * catalog, and the default/per-user/admin access model.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the runtime data dir at a throwaway folder BEFORE anything resolves a file path.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'home_assist-test-'));
process.env.HOMEASSIST_DATA_DIR = TMP;
process.env.HOMEASSIST_ADMIN_USER = 'skip';
process.env.HOMEASSIST_ADMIN_PASS = 'recovery-pass';
delete process.env.HOMEASSIST_SESSION_SECRET;

const store = require('../auth/auth_store');
const session = require('../auth/session');
const panel_access = require('../access/panel_access');

test.after(function () { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ } });

// ───────────────────────────── passwords ─────────────────────────────

test('password hashing round-trips and rejects the wrong password', function () {
  const h = store.hash_password('correct horse');
  assert.match(h, /^scrypt\$/);
  assert.strictEqual(store.verify_password('correct horse', h), true);
  assert.strictEqual(store.verify_password('wrong horse', h), false);
});

test('the same password hashes differently each time (per-user salt)', function () {
  assert.notStrictEqual(store.hash_password('same'), store.hash_password('same'));
});

test('a malformed stored hash is rejected, not crashed on', function () {
  assert.strictEqual(store.verify_password('x', 'garbage'), false);
  assert.strictEqual(store.verify_password('x', null), false);
});

// ───────────────────────────── users ─────────────────────────────

test('the .env recovery account always works and is an admin', function () {
  const v = store.valid_user('skip', 'recovery-pass');
  assert.ok(v);
  assert.strictEqual(v.role, 'admin');
  assert.strictEqual(v.env, true);
});

test('the recovery account rejects a wrong password', function () {
  assert.strictEqual(store.valid_user('skip', 'nope'), null);
});

test('add / validate / remove a stored user', function () {
  store.add_user('helper', 'hunter22', 'user');
  const v = store.valid_user('helper', 'hunter22');
  assert.ok(v);
  assert.strictEqual(v.role, 'user');
  assert.ok(store.list_users().some(function (u) { return u.user === 'helper'; }));

  assert.strictEqual(store.remove_user('helper'), true);
  assert.strictEqual(store.valid_user('helper', 'hunter22'), null);
  assert.strictEqual(store.remove_user('helper'), false);
});

test('add_user on an existing user updates the password', function () {
  store.add_user('rotate', 'first-pass', 'user');
  store.add_user('rotate', 'second-pass');
  assert.strictEqual(store.valid_user('rotate', 'first-pass'), null);
  assert.ok(store.valid_user('rotate', 'second-pass'));
  store.remove_user('rotate');
});

test('login_configured sees the recovery account', function () {
  assert.strictEqual(store.login_configured(), true);
});

// ───────────────────────────── sessions ─────────────────────────────

test('a session signs and verifies', function () {
  const secret = store.session_secret();
  const token = session.sign({ user: 'skip', role: 'admin', ts: Date.now() }, secret);
  const p = session.verify(token, secret);
  assert.strictEqual(p.user, 'skip');
  assert.strictEqual(p.role, 'admin');
});

test('a tampered session is rejected', function () {
  const secret = store.session_secret();
  const token = session.sign({ user: 'skip', role: 'user', ts: Date.now() }, secret);
  const [body, mac] = token.split('.');
  // Re-encode the payload as an admin, keeping the original signature.
  const forged = Buffer.from(JSON.stringify({ user: 'skip', role: 'admin', ts: Date.now() }))
    .toString('base64url') + '.' + mac;
  assert.strictEqual(session.verify(forged, secret), null);
  assert.ok(body);
});

test('a session signed with a different secret is rejected', function () {
  const token = session.sign({ user: 'skip', role: 'admin', ts: Date.now() }, 'secret-a');
  assert.strictEqual(session.verify(token, 'secret-b'), null);
});

test('an expired session is rejected', function () {
  const secret = store.session_secret();
  const old = Date.now() - session.MAX_AGE_MS - 1000;
  const token = session.sign({ user: 'skip', role: 'admin', ts: old }, secret);
  assert.strictEqual(session.verify(token, secret), null);
});

test('garbage is rejected without throwing', function () {
  assert.strictEqual(session.verify('', 'k'), null);
  assert.strictEqual(session.verify('no-dot', 'k'), null);
  assert.strictEqual(session.verify('a.b', 'k'), null);
});

test('cookie parsing handles the usual header shapes', function () {
  const c = session.parse_cookies('a=1; home_assist_session=abc.def; other=x');
  assert.strictEqual(c[session.COOKIE], 'abc.def');
  assert.deepStrictEqual(session.parse_cookies(''), {});
  assert.deepStrictEqual(session.parse_cookies(undefined), {});
});

// ───────────────────────── panel catalog + access ─────────────────────────

test('the panel catalog is built from the module registry', function () {
  const keys = panel_access.keys();
  // Contributed by modules/water/module.js — proof the registry drives the catalog.
  assert.ok(keys.includes('water'), 'water panel missing');
  assert.ok(keys.includes('water-admin'), 'water-admin panel missing');
  // Contributed by the platform itself.
  assert.ok(keys.includes('admin'), 'admin panel missing');
});

test('catalog entries carry a label and a group for the rail', function () {
  const water = panel_access.catalog().find(function (p) { return p.key === 'water'; });
  assert.ok(water);
  assert.strictEqual(water.group, 'Water');
  assert.ok(water.label);
});

test('an admin sees every panel', function () {
  const panels = panel_access.effective_panels('skip', 'admin');
  assert.deepStrictEqual(panels.slice().sort(), panel_access.keys().slice().sort());
  assert.strictEqual(panel_access.is_allowed('skip', 'admin', 'admin'), true);
});

test('a default user sees the monitor but not the knobs', function () {
  const panels = panel_access.effective_panels('nobody', 'user');
  assert.ok(panels.includes('water'), 'a new user should see the water monitor');
  assert.ok(!panels.includes('water-admin'), 'settings must need an explicit grant');
  assert.ok(!panels.includes('admin'), 'user admin must need an explicit grant');
});

test('the admin panel is hard-gated even if somehow granted', function () {
  panel_access.set_user('sneaky', ['water', 'admin']);
  assert.strictEqual(panel_access.is_allowed('sneaky', 'user', 'admin'), false);
  panel_access.clear_user('sneaky');
});

test('a per-user override narrows access', function () {
  panel_access.set_user('narrow', ['water']);
  assert.deepStrictEqual(panel_access.effective_panels('narrow', 'user'), ['water']);
  assert.strictEqual(panel_access.is_allowed('narrow', 'user', 'water'), true);
  assert.strictEqual(panel_access.is_allowed('narrow', 'user', 'water-admin'), false);
  panel_access.clear_user('narrow');
  assert.ok(panel_access.effective_panels('narrow', 'user').includes('water'));
});

test('a per-user override can grant a restricted panel', function () {
  panel_access.set_user('trusted', ['water', 'water-admin']);
  assert.strictEqual(panel_access.is_allowed('trusted', 'user', 'water-admin'), true);
  panel_access.clear_user('trusted');
});

test('unknown panel keys are dropped rather than stored', function () {
  panel_access.set_user('typo', ['water', 'not-a-real-panel']);
  assert.deepStrictEqual(panel_access.effective_panels('typo', 'user'), ['water']);
  panel_access.clear_user('typo');
});

test('the default grant can be narrowed for everyone at once', function () {
  panel_access.set_default([]);
  assert.deepStrictEqual(panel_access.effective_panels('anyone', 'user'), []);
  assert.strictEqual(panel_access.is_allowed('anyone', 'user', 'water'), false);
  // ...but never for an admin
  assert.strictEqual(panel_access.is_allowed('skip', 'admin', 'water'), true);
  panel_access.set_default('all');
});
