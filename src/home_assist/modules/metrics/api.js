'use strict';
/**
 * metrics/api.js — the ingest endpoint and the report the Metrics page reads.
 *
 *   POST /api/event            any signed-in user. The browser's fire-and-forget write.
 *   GET  /api/metrics          the report                     — panel 'metrics'
 *   GET  /api/metrics/events   the raw tail, for reading one incident — panel 'metrics'
 *   POST /api/metrics/purge    delete test rows / old years / everything — ADMIN ONLY
 *
 * Note the asymmetry, which is the whole access design: WRITING an event needs nothing more than
 * being signed in, because every page writes them and a page that 403s on its own analytics is a
 * page that logs an error about failing to log. READING them is a panel, because the events table
 * says which pages a user visited and when — that is the most personal thing this app stores.
 * DELETING is admin-only regardless of the panel grant: an audit trail that its subject can erase
 * is not an audit trail.
 */
const { require_auth, require_admin, require_panel } = require('../../auth/require_auth');
const events = require('./events');
const report = require('./report');
const retention = require('../../analytics/retention');
const cfg = require('./metrics_config');
const db = require('../../store/db');

function guard(fn) {
  return function (req, res) {
    fn(req, res).catch(function (e) {
      res.status(500).json({ ok: false, error: e.message });
    });
  };
}

function mount(app) {
  // ── ingest ───────────────────────────────────────────────────────────────────────────────────
  //
  // Always 204, always fast, never an error the page can see. The browser sends this with
  // navigator.sendBeacon, which cannot read a response and does not wait for one — so returning a
  // meaningful status would be writing to nobody.
  app.post('/api/event', require_auth, function (req, res) {
    res.status(204).end();                       // answer first; the write is not worth waiting on
    events.ingest_http(req, req.user, req.role).catch(function () { /* never throws */ });
  });

  app.get('/api/metrics', require_panel('metrics'), guard(async function (req, res) {
    const data = await report.build_report({
      days: req.query.days,
      panel: req.query.panel,
      include_test: String(req.query.include_test || '') === '1',
    });
    res.json(Object.assign({ ok: true }, data));
  }));

  // The tail, for looking at one incident rather than a distribution. Capped, newest first, and
  // deliberately NOT filtered to a panel — when you are chasing "what happened at 3am" the events
  // either side of the error are the point.
  app.get('/api/metrics/events', require_panel('metrics'), guard(async function (req, res) {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 1000));
    const rows = await db.query(
      'SELECT id, created_at_mtn, event_name, actor, role, panel, view, page_path, ' +
      '       error_type, error_msg, viewport, theme, client_tz, session_id, is_test, env, source ' +
      'FROM `' + cfg.TABLE + '` WHERE app = ? ORDER BY id DESC LIMIT ?', [cfg.APP, limit]);
    res.json({ ok: true, rows: rows, tz: cfg.REPORTING_TZ });
  }));

  // Destructive, so: admin role, and the mode is named explicitly rather than defaulted. A purge
  // endpoint whose default action is "everything" is one typo away from erasing the record.
  app.post('/api/metrics/purge', require_admin, guard(async function (req, res) {
    const mode = String((req.body && req.body.mode) || '');
    let r;
    if (mode === 'test') r = await retention.purge_test(cfg.TABLE);
    else if (mode === 'old') r = await retention.purge_keep_years(cfg.TABLE, cfg.KEEP_YEARS, cfg.REPORTING_TZ);
    else if (mode === 'all') r = await retention.purge_all(cfg.TABLE);
    else return res.status(400).json({ ok: false, error: 'mode must be one of: test, old, all' });
    res.json({ ok: true, mode: mode, deleted: r.deleted, cutoff_year: r.cutoff_year });
  }));
}

module.exports = { mount };
