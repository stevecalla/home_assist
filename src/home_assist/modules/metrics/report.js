'use strict';
/**
 * report.js — the events table, aggregated into the shape the Metrics page draws.
 *
 * Ported from usat_apps/metrics/metrics_report.js and trimmed. Two things were dropped on purpose:
 * the per-actor leaderboard (a house has one or two users, so "top operators" is a list of you) and
 * ask-your-data (needs an API key and answers questions a team asks).
 *
 * What was KEPT and reweighted is the part that earns its place here: 404s, access denials and
 * errors. On a single-user dashboard "which panel is popular" is trivia, but "which link is broken"
 * and "what threw last Tuesday at 3am" are the questions you cannot answer any other way once the
 * moment has passed.
 *
 * The window is a MTN CALENDAR-DAY boundary, not a rolling 24h. "Today" has to mean since midnight
 * at the house, or the figure straddles two days and matches nothing else in the app.
 */
const db = require('../../store/db');
const retention = require('../../analytics/retention');
const cfg = require('./metrics_config');

const TABLE = cfg.TABLE;

function n0(v) { return v == null ? 0 : Number(v); }

// Midnight, `days - 1` days ago, in the reporting zone — formatted for created_at_mtn. Pure
// calendar arithmetic on a UTC-anchored date, so a DST change cannot shift the boundary.
function window_start(days, tz) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || cfg.REPORTING_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).reduce(function (o, x) { o[x.type] = x.value; return o; }, {});
  const base = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  const start = new Date(base - (Math.max(1, Number(days) || 1) - 1) * 86400000);
  return start.toISOString().slice(0, 10) + ' 00:00:00';
}

async function build_report(opts) {
  opts = opts || {};
  const days = Math.max(1, Math.min(Number(opts.days) || 7, 365));
  const since = window_start(days);

  // Test rows are excluded from the headline unless asked for, so a session spent clicking around
  // with ?metrics_test=1 never inflates the numbers you are trying to read.
  const test_filter = opts.include_test ? '' : ' AND (is_test IS NULL OR is_test = 0)';
  let W = '`' + TABLE + '` WHERE app = ? AND created_at_mtn >= ?' + test_filter;
  const A = [cfg.APP, since];
  const panel = opts.panel && String(opts.panel).trim();
  if (panel) { W += ' AND panel = ?'; A.push(panel); }

  const counts = await db.query('SELECT event_name, COUNT(*) AS n FROM ' + W + ' GROUP BY event_name', A);
  const c = {};
  counts.forEach(function (r) { c[r.event_name] = n0(r.n); });

  const who = (await db.query(
    'SELECT COUNT(DISTINCT visitor_id) AS visitors, COUNT(DISTINCT session_id) AS sessions, ' +
    '       COUNT(DISTINCT actor) AS actors FROM ' + W, A))[0] || {};

  const by_panel = await db.query(
    "SELECT panel, SUM(event_name IN ('panel_view','page_view')) AS views, COUNT(*) AS events " +
    'FROM ' + W + " AND panel IS NOT NULL AND panel <> '' GROUP BY panel ORDER BY events DESC", A);

  const by_day = await db.query(
    "SELECT DATE(created_at_mtn) AS d, SUM(event_name IN ('panel_view','page_view')) AS views, " +
    "       SUM(event_name = 'error') AS errors, COUNT(*) AS events " +
    'FROM ' + W + ' GROUP BY d ORDER BY d', A);

  const by_hour = await db.query(
    'SELECT HOUR(created_at_mtn) AS h, COUNT(*) AS n FROM ' + W + ' GROUP BY h ORDER BY h', A);

  // ── the three that actually matter on a one-house dashboard ──
  const top_not_found = await db.query(
    "SELECT view, COUNT(*) AS n FROM " + W + " AND event_name = 'not_found' AND view IS NOT NULL " +
    "AND view <> '' GROUP BY view ORDER BY n DESC LIMIT 10", A);
  const access_denied = await db.query(
    "SELECT panel, actor, COUNT(*) AS n FROM " + W + " AND event_name = 'not_authorized' " +
    'GROUP BY panel, actor ORDER BY n DESC LIMIT 10', A);
  const errors = await db.query(
    "SELECT error_type, COALESCE(error_msg, '') AS error_msg, COUNT(*) AS n, " +
    "       MAX(created_at_mtn) AS last_mtn " +
    'FROM ' + W + " AND event_name = 'error' GROUP BY error_type, error_msg ORDER BY n DESC LIMIT 15", A);

  const sessions = await db.query(
    "SELECT session_id, MAX(actor) AS actor, MAX(viewport) AS viewport, MAX(theme) AS theme, " +
    "       MAX(client_tz) AS client_tz, COUNT(*) AS events, " +
    '       MIN(created_at_mtn) AS started_mtn, MAX(created_at_mtn) AS last_mtn ' +
    'FROM ' + W + " AND session_id IS NOT NULL AND session_id <> '' " +
    'GROUP BY session_id ORDER BY MAX(created_at_mtn) DESC LIMIT 15', A);

  const health = await retention.size(TABLE).catch(function () { return null; });
  const test_rows = (await db.query(
    'SELECT COUNT(*) AS n FROM `' + TABLE + '` WHERE is_test = 1'))[0] || {};

  const day = function (d) {
    return d && d.toISOString ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  };

  return {
    days: days,
    since: since,
    tz: cfg.REPORTING_TZ,
    include_test: !!opts.include_test,
    panel: panel || null,
    totals: {
      events: Object.keys(c).reduce(function (a, k) { return a + c[k]; }, 0),
      panel_views: (c.panel_view || 0) + (c.page_view || 0),
      sessions: n0(who.sessions),
      visitors: n0(who.visitors),
      actors: n0(who.actors),
      not_found: c.not_found || 0,
      not_authorized: c.not_authorized || 0,
      errors: c.error || 0,
      logins: c.login || 0,
    },
    by_event: Object.keys(c).sort(function (a, b) { return c[b] - c[a]; })
      .map(function (k) { return { event: k, n: c[k] }; }),
    by_panel: by_panel.map(function (r) {
      return { panel: r.panel, views: n0(r.views), events: n0(r.events) };
    }),
    by_day: by_day.map(function (r) {
      return { day: day(r.d), views: n0(r.views), errors: n0(r.errors), events: n0(r.events) };
    }),
    // Every hour 0-23, zero-filled. A missing hour and a quiet hour look identical in a bare list,
    // and this app has a standing rule about that.
    by_hour: Array.from({ length: 24 }, function (_, h) {
      const hit = by_hour.find(function (r) { return Number(r.h) === h; });
      return { hour: h, n: hit ? n0(hit.n) : 0 };
    }),
    top_not_found: top_not_found.map(function (r) { return { path: r.view, n: n0(r.n) }; }),
    access_denied: access_denied.map(function (r) {
      return { panel: r.panel || '—', actor: String(r.actor || 'anon'), n: n0(r.n) };
    }),
    errors: errors.map(function (r) {
      return { type: r.error_type || '?', message: r.error_msg || '', n: n0(r.n), last_mtn: r.last_mtn || null };
    }),
    sessions: sessions.map(function (r) {
      return {
        session_id: String(r.session_id || '').slice(0, 8),
        actor: r.actor || 'anon', viewport: r.viewport || '—', theme: r.theme || '—',
        client_tz: r.client_tz || null, events: n0(r.events),
        started_mtn: r.started_mtn || null, last_mtn: r.last_mtn || null,
      };
    }),
    health: {
      rows: health ? health.rows : null,
      mb: health ? health.mb : null,
      test_rows: n0(test_rows.n),
      first_mtn: health ? health.min_mtn : null,
      last_mtn: health ? health.max_mtn : null,
      by_year: health ? health.by_year : [],
      keep_years: cfg.KEEP_YEARS,
    },
  };
}

module.exports = { build_report, window_start, TABLE: TABLE, APP: cfg.APP };
