'use strict';
/**
 * metrics.test.js — the usage-analytics stack.
 *
 * All pure: the column whitelist, the timestamp stamping, the reporting window, the access wiring.
 * Nothing here needs MySQL, which is the point — the parts worth pinning are the boundaries, and
 * every one of them is a plain function or a string in a file.
 *
 * The boundary that matters most is the WHITELIST. It is not a performance detail: it is the
 * privacy statement. A browser posts JSON, and the only thing standing between that and the table
 * is a Set. If it ever stops being enforced, the failure is silent and the evidence accumulates.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const cfg = require('../modules/metrics/metrics_config');
const { build_insert, fmt_in_tz } = require('../analytics/event_ingest');
const report = require('../modules/metrics/report');
const panel_access = require('../access/panel_access');
const registry = require('../modules/registry');

const SRC = path.join(__dirname, '..');

// ── the whitelist ──────────────────────────────────────────────────────────────────────────────

test('a client cannot write a column nobody designed for', function () {
  // The whole ingest boundary in one assertion. build_insert intersects what arrived with what is
  // allowed, so an unknown key never reaches the SQL and its value is never bound.
  const q = build_insert(cfg.TABLE, new Set(cfg.COLUMNS), 'America/Denver', {
    event_name: 'panel_view', panel: 'water-monitor',
    password: 'hunter2', ip: '10.0.0.4', user_agent: 'Mozilla/5.0', meter_reading: 835371,
  });
  for (const bad of ['password', 'ip', 'user_agent', 'meter_reading']) {
    assert.ok(q.sql.indexOf(bad) === -1, bad + ' must never reach the INSERT');
  }
  assert.match(q.sql, /`event_name`/);
  assert.match(q.sql, /`panel`/);
  assert.ok(!q.vals.includes('hunter2'), 'and its value must not be bound either');
  assert.ok(!q.vals.includes('10.0.0.4'));

  // An event of nothing but rejected keys writes no row at all, rather than a row of two timestamps.
  assert.strictEqual(build_insert(cfg.TABLE, new Set(cfg.COLUMNS), 'UTC', { ip: '1.2.3.4' }), null);
});

test('the whitelist carries no PII columns', function () {
  // A list, so adding one is a deliberate edit that shows up in a diff rather than a field that
  // quietly appears because some library offered it.
  for (const banned of ['ip', 'ip_address', 'user_agent', 'referrer', 'email', 'query', 'password']) {
    assert.ok(cfg.COLUMNS.indexOf(banned) < 0, banned + ' must not be collectable');
  }
});

test('every whitelisted column exists in the table DDL', function () {
  // The two halves of the contract. A column in the whitelist but not the table makes every event
  // carrying it fail its INSERT -- silently, because analytics swallows its errors, so the first
  // symptom would be an empty report weeks later.
  //
  // Read from schema.TABLES, not from the source text: the DDL is a template literal, so the file
  // contains `${CREATED_AT}` where the evaluated string contains the timestamp columns.
  const schema = require('../store/schema');
  const t = schema.TABLES.find(function (x) { return x.name === 'home_assist_events'; });
  assert.ok(t, 'the events table must be in the schema');
  for (const col of cfg.COLUMNS) {
    assert.match(t.ddl, new RegExp('\\b' + col + '\\s'), col + ' is whitelisted but not in the DDL');
  }
  assert.match(t.ddl, /created_at_mtn/);
  assert.match(t.ddl, /created_at_utc/);
});

// ── timestamps ─────────────────────────────────────────────────────────────────────────────────

test('both timestamps are stamped in Node, in the right zones', function () {
  // Same rule as every other table here: no CONVERT_TZ, which needs MySQL's tz tables loaded and
  // returns NULL when they are not -- and they are not, on a stock local install.
  const at = new Date('2026-08-31T03:38:00Z');
  assert.strictEqual(fmt_in_tz(at, 'UTC'), '2026-08-31 03:38:00');
  assert.strictEqual(fmt_in_tz(at, 'America/Denver'), '2026-08-30 21:38:00');
});

test('the report window is a calendar-day boundary, not a rolling 24 hours', function () {
  // "Today" has to mean since midnight at the house. A NOW() - INTERVAL window straddles two days
  // and agrees with nothing else in the app.
  const start = report.window_start(1, 'America/Denver');
  assert.match(start, /^\d{4}-\d{2}-\d{2} 00:00:00$/);
  const week = report.window_start(7, 'America/Denver');
  assert.match(week, / 00:00:00$/);
  assert.ok(week < start, 'a longer window starts earlier');
});

// ── access ─────────────────────────────────────────────────────────────────────────────────────

test('the metrics panel is registered, and appears in the access panel', function () {
  // It has to be VISIBLE in the access catalog to be grantable at all -- that is what makes it
  // possible to hand out deliberately rather than only by making somebody an admin.
  const keys = panel_access.keys();
  assert.ok(keys.indexOf('metrics') >= 0, 'metrics must be in the panel catalog');
  const entry = panel_access.catalog().find(function (p) { return p.key === 'metrics'; });
  assert.strictEqual(entry.group, 'Admin');
  assert.ok(registry.list().some(function (m) { return m.id === 'metrics'; }), 'and be a registered module');
});

test('metrics is admin-only by default, but still grantable', function () {
  // The distinction this whole design turns on. `admin` is NOT_GRANTABLE -- ticking it would store
  // a permission the authorization check ignores. `metrics` is the opposite: an admin CAN grant it,
  // it simply is not part of the 'all' default, because it records which pages each user opened.
  assert.ok(panel_access.DEFAULT_ALL_EXCLUDE.indexOf('metrics') >= 0,
    "the 'all' default must not include metrics");
  assert.ok(panel_access.NOT_GRANTABLE.indexOf('metrics') < 0, 'but it must remain grantable');

  // A default-'all' user does not get it...
  assert.strictEqual(panel_access.is_allowed('someone', 'user', 'metrics'), false);
  // ...and an admin always does.
  assert.strictEqual(panel_access.is_allowed('boss', 'admin', 'metrics'), true);
});

test('reading is a panel, writing is any session, deleting is the admin role', function () {
  // Three different gates on purpose. Every page writes events, so ingest cannot 403 -- a page that
  // fails to log would log an error about failing to log. Reading is a panel because the table says
  // where each user went. Deleting is role-gated whatever the panel says: an audit trail its own
  // subject can erase is not an audit trail.
  const api = fs.readFileSync(path.join(SRC, 'modules', 'metrics', 'api.js'), 'utf8');
  assert.match(api, /app\.post\('\/api\/event',\s*require_auth/);
  assert.match(api, /app\.get\('\/api\/metrics',\s*require_panel\('metrics'\)/);
  assert.match(api, /app\.post\('\/api\/metrics\/purge',\s*require_admin/);
});

test('the purge endpoint has no default mode', function () {
  // Three named modes, and an unnamed one is a 400. A destructive endpoint that defaults to
  // "everything" is one typo from erasing the record.
  const api = fs.readFileSync(path.join(SRC, 'modules', 'metrics', 'api.js'), 'utf8');
  assert.match(api, /mode must be one of/);
  for (const m of ["'test'", "'old'", "'all'"]) assert.ok(api.indexOf('mode === ' + m) >= 0, m);
});

// ── the browser client ─────────────────────────────────────────────────────────────────────────

test('the client is switched on, and still refuses to track what it should not', function () {
  const src = fs.readFileSync(path.join(SRC, 'web', 'src', 'lib', 'track.js'), 'utf8');
  assert.ok(src.indexOf('const ENABLED = false') === -1, 'the no-op guard must be gone');
  assert.match(src, /doNotTrack/, 'Do-Not-Track is still honoured');
  assert.match(src, /navigator\.webdriver/, 'and automation is still skipped');
  assert.match(src, /sendBeacon/, 'sent without blocking the page');
  // Every storage read is wrapped -- Safari private mode throws on write, and an analytics helper
  // that throws inside a render is a blank page.
  assert.ok(src.indexOf('localStorage.getItem') === -1 || /try\s*\{[\s\S]*localStorage/.test(src));
});

test('the server stamps identity over anything the browser claims', function () {
  // The client sends descriptive fields; who you are comes from the session. Otherwise a page could
  // post actor:'someone_else' and the table would believe it.
  const ev = fs.readFileSync(path.join(SRC, 'modules', 'metrics', 'events.js'), 'utf8');
  const i = ev.indexOf('ingest_http');
  const seg = ev.slice(i);
  for (const f of ['actor:', 'role:', 'env:', 'is_test:', 'app:']) {
    assert.ok(seg.indexOf(f) >= 0, f + ' must be stamped by the server');
  }
  assert.match(seg, /delete clean\.is_test/, 'and the client copy discarded');
});

test('the event vocabulary covers what the report reads', function () {
  // A report section querying an event_name nobody emits renders an empty table that looks like
  // good news. These are the names the aggregation actually groups on.
  const all = cfg.all_events();
  for (const name of ['panel_view', 'not_found', 'not_authorized', 'error', 'login']) {
    assert.ok(all.indexOf(name) >= 0, name + ' must be in the vocabulary');
  }
});

// ── the palette scope ──────────────────────────────────────────────────────────────────────────

test('a page using the --w-* palette carries the class that defines it', function () {
  // The bug this test exists for, found by measuring computed styles rather than by reading code:
  // the chart and status palette is declared on `.w-root`, NOT on :root. A page that uses
  // var(--w-serious) without that class gets an empty string, so the colour silently becomes the
  // inherited text colour — the bars still draw and the "alarm" border comes out the same shade as
  // everything else. Nothing errors, nothing looks broken, and the page just stops meaning what it
  // says. Exactly the failure mode as the undefined-token bug on the meter dropdown.
  const water_css = fs.readFileSync(path.join(SRC, 'web', 'src', 'modules', 'water', 'water.css'), 'utf8');
  assert.match(water_css, /^\.w-root \{/m, 'the palette is scoped to .w-root');

  const strip = function (s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); };
  const pages = [['metrics', 'Metrics.jsx', 'metrics.css']];
  for (const [mod, jsx, css] of pages) {
    const sheet = strip(fs.readFileSync(path.join(SRC, 'web', 'src', 'modules', mod, css), 'utf8'));
    if (!/var\(--w-/.test(sheet)) continue;
    const page = strip(fs.readFileSync(path.join(SRC, 'web', 'src', 'modules', mod, jsx), 'utf8'));
    assert.match(page, /className="page w-root/,
      mod + '/' + css + ' uses --w-* tokens, so ' + jsx + ' must carry w-root on its root element');
  }
});

test('every custom property the metrics sheet reads is actually defined', function () {
  const strip = function (s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); };
  const base = path.join(SRC, 'web', 'src');
  const defined = new Set(
    (fs.readFileSync(path.join(base, 'styles.css'), 'utf8') +
     fs.readFileSync(path.join(base, 'modules', 'water', 'water.css'), 'utf8'))
      .match(/--[a-z0-9-]+\s*:/g).map(function (m) { return m.replace(/\s*:$/, ''); })
  );
  const used = strip(fs.readFileSync(path.join(base, 'modules', 'metrics', 'metrics.css'), 'utf8'))
    .match(/var\((--[a-z0-9-]+)/g) || [];
  const missing = used.map(function (m) { return m.slice(4); })
    .filter(function (t) { return !defined.has(t); });
  assert.deepStrictEqual([...new Set(missing)], [], 'undefined custom properties in metrics.css');
});
