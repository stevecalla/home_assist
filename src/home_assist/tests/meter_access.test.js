'use strict';
/**
 * meter_access.test.js — WHOSE DATA a user may see.
 *
 * This is an authorization boundary, so the tests are written the paranoid way round: they assert
 * that a refused meter is REFUSED, not merely that an allowed one is allowed. The failure mode that
 * matters is the quiet one — a restriction that returns an empty list instead of a 403, or an "all
 * meters" view that forgets to filter and hands over the neighbour's data.
 *
 * No MySQL: meter_clause() is a pure string builder and resolve_meter() only reads the grant file,
 * which is redirected here to a temp path via HOMEASSIST_METER_ACCESS_FILE.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-meter-access-'));
const FILE = path.join(TMP, 'meter_access.json');
process.env.HOMEASSIST_METER_ACCESS_FILE = FILE;

const meter_access = require('../access/meter_access');
const readings = require('../modules/water/store/readings');
const water_api = require('../modules/water/api');

const CFG = { meter_id: 111 };                       // the collector's own meter
const req = (user, role) => ({ user: user, role: role || 'user' });

function grant(o) {
  if (o === null) { try { fs.unlinkSync(FILE); } catch (e) { /* already gone */ } return; }
  fs.writeFileSync(FILE, JSON.stringify(o));
}

test.beforeEach(function () { grant(null); });

// ── the default: nothing changes for an install that never touches this ────────────────────────

test('with no grant file at all, everyone sees every meter', function () {
  // The migration story. If this flips, deploying the feature silently locks people out of data
  // they had yesterday, which is worse than the feature being absent.
  assert.strictEqual(meter_access.allowed('bob', 'user'), 'all');
  assert.strictEqual(meter_access.is_allowed('bob', 'user', 999), true);
});

test('an admin gets all meters whatever the grant says', function () {
  grant({ default: [222], users: { root: [] } });
  assert.strictEqual(meter_access.allowed('root', 'admin'), 'all');
  assert.strictEqual(meter_access.is_allowed('root', 'admin', 999), true);
});

// ── the grant itself ───────────────────────────────────────────────────────────────────────────

test('a per-user grant beats the default, and an empty grant means nothing', function () {
  grant({ default: 'all', users: { bob: [222], carol: [] } });
  assert.deepStrictEqual(meter_access.allowed('bob', 'user'), [222]);
  assert.deepStrictEqual(meter_access.allowed('carol', 'user'), []);
  assert.strictEqual(meter_access.is_allowed('carol', 'user', 111), false);
});

test('normalize keeps positive safe integers only, deduped', function () {
  assert.deepStrictEqual(meter_access.normalize([222, '222', 0, -1, 'x', 1.5, 333]), [222, 333]);
  assert.strictEqual(meter_access.normalize('all'), 'all');
});

// ── "mine" is per user, which is the whole point ───────────────────────────────────────────────

test('primary() resolves “mine” to the user’s own meter, not the collector’s', function () {
  grant({ default: 'all', users: { bob: [222] } });
  assert.strictEqual(meter_access.primary('bob', 'user', 111), 222);
  assert.strictEqual(meter_access.primary('ann', 'user', 111), 111);   // unrestricted → collector's
});

test('a restricted user whose grant includes the collector’s meter still lands there', function () {
  grant({ default: 'all', users: { bob: [222, 111] } });
  assert.strictEqual(meter_access.primary('bob', 'user', 111), 111);
});

// ── resolve_meter: the request-level gate ──────────────────────────────────────────────────────

test('asking for a meter outside the grant is REFUSED, not silently emptied', function () {
  // The distinction is the test. An empty result set reads as "no water used", which on a leak
  // monitor is a statement, not an absence.
  grant({ default: 'all', users: { bob: [222] } });
  assert.strictEqual(water_api.resolve_meter('111', CFG, req('bob')), null);
});

test('resolve_meter allows a meter inside the grant', function () {
  grant({ default: 'all', users: { bob: [222] } });
  const sel = water_api.resolve_meter('222', CFG, req('bob'));
  assert.strictEqual(sel.meter_id, 222);
  assert.strictEqual(sel.scope, 'mine');
});

test('“mine” and junk both fall back to the user’s primary, never to the collector’s', function () {
  grant({ default: 'all', users: { bob: [222] } });
  ['mine', '', undefined, 'nonsense', '../../etc/passwd'].forEach(function (raw) {
    const sel = water_api.resolve_meter(raw, CFG, req('bob'));
    assert.strictEqual(sel.meter_id, 222, 'raw=' + String(raw));
  });
});

test('“all” carries the grant along so the store can filter on it', function () {
  grant({ default: 'all', users: { bob: [222, 333] } });
  const sel = water_api.resolve_meter('all', CFG, req('bob'));
  assert.strictEqual(sel.scope, 'all');
  assert.deepStrictEqual(sel.allowed, [222, 333]);
});

// ── the store clause: “all” must never mean “no WHERE clause” ───────────────────────────────────

test('scope “all” is an IN list for a restricted user, never unfiltered', function () {
  const sql = readings.meter_clause(222, 'all', [222, 333]);
  assert.match(sql, /IN \(222,333\)/);
});

test('scope “all” with an unrestricted grant is genuinely unfiltered', function () {
  assert.strictEqual(readings.meter_clause(222, 'all', 'all'), '');
  assert.strictEqual(readings.meter_clause(222, 'all', null), '');
});

test('an empty grant returns no rows rather than every row', function () {
  // The dangerous direction: an empty IN () list is a SQL error, and "just drop the clause" is the
  // tempting fix that turns "sees nothing" into "sees everything".
  assert.strictEqual(readings.meter_clause(222, 'all', []).trim(), 'AND 1 = 0');
});

test('scope “mine” pins one meter, and a junk id matches nothing instead of erroring', function () {
  assert.strictEqual(readings.meter_clause(222, 'mine').trim(), 'AND meter_id = 222');
  ['222; DROP TABLE water_readings', 'all', '', null, -1].forEach(function (bad) {
    assert.strictEqual(readings.meter_clause(bad, 'mine').trim(), 'AND meter_id = 0', 'id=' + String(bad));
  });
});

// ── other_ids: the sidebar that used to leak ───────────────────────────────────────────────────

// ── the admin UI ───────────────────────────────────────────────────────────────────────────────

test('the admin page can edit meter grants, and shows the meter list in every mode', function () {
  const ui = fs.readFileSync(require.resolve('../web/src/pages/Admin.jsx'), 'utf8');
  assert.match(ui, /Meter access — general default/);
  assert.match(ui, /Meter access — per user/);
  assert.match(ui, /const mlist = \(set, setSet, readOnly\)/);
  // Same rule as the panel grid: never hidden behind the mode you did not pick.
  assert.ok(ui.indexOf("{mDefMode === 'some' && mlist") === -1, 'the default card must always render it');
  assert.ok(ui.indexOf("{mUMode === 'some' && mlist") === -1, 'the per-user card must always render it');
  // A grant naming a meter the radio has not heard yet must stay visible, or the next save deletes it.
  assert.match(ui, /unheard: true/);
  // The per-user summary answers BOTH questions in one place.
  assert.match(ui, /— pages:/);
  assert.match(ui, /— meters:/);
});

test('other_ids is filtered to the grant', function () {
  assert.strictEqual(water_api.filter_other_ids('111x4 222x9 333x1', [222]), '222x9');
  assert.strictEqual(water_api.filter_other_ids('111x4 222x9', [999]), null);
  assert.strictEqual(water_api.filter_other_ids('111x4 222x9', 'all'), '111x4 222x9');
  assert.strictEqual(water_api.filter_other_ids('', [222]), null);
});
