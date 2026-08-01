'use strict';
/**
 * api.js — /api/water/* — everything the dashboard reads.
 *
 * Read-only with respect to the meter. The only writes here are settings changes and the manual
 * test alert, both gated behind the 'water-admin' panel.
 */
const { require_panel } = require('../../auth/require_auth');
const time = require('../../time');
const db = require('../../store/db');
const schema = require('../../store/schema');
const settings = require('./store/settings');
const readings = require('./store/readings');
const alerts = require('./store/alerts');
const rules = require('./rules/leak_rules');
const mailer = require('../../notify/mailer');

// One place to turn an exception into a clean 500 instead of an unhandled rejection.
function guard(fn) {
  return function (req, res) {
    Promise.resolve(fn(req, res)).catch(function (e) {
      console.error('[water] ' + req.path + ': ' + e.message);
      res.status(500).json({ ok: false, error: e.message });
    });
  };
}

function keys_for_today(now, tz) {
  const day = time.day_key(now, tz);
  const out = [];
  for (let h = 0; h <= time.local_hour(now, tz); h++) out.push(day + 'T' + String(h).padStart(2, '0'));
  return out;
}

function mount(app) {
  // ── the dashboard's heartbeat: everything the top of the page needs, in one call ──
  app.get('/api/water/status', require_panel('water'), guard(async function (req, res) {
    const cfg = await settings.all();
    const tz = time.zone();
    const now = new Date();
    const meter_id = cfg.meter_id;

    const [state, hours, recent] = await Promise.all([
      readings.get_state(meter_id),
      readings.hour_map(meter_id, 72),
      // Enough rows to see back through a long run. A leak at 1 gal/min for 8 hours is 480 rows;
      // recent_readings caps at 500, and current_run reports `truncated` if it hits the end rather
      // than pretending it knows when the run began.
      readings.recent_readings(meter_id, 500),
    ]);

    // MySQL DATETIMEs come back as strings (dateStrings) and are stored in UTC — append Z so the
    // browser gets an unambiguous instant rather than a local-time guess.
    const last_read_at = state && state.last_read_at_utc ? new Date(state.last_read_at_utc + 'Z') : null;
    const heartbeat_at = state && state.last_heartbeat_utc ? new Date(state.last_heartbeat_utc + 'Z') : null;

    const started_at = state && state.started_at_utc ? new Date(state.started_at_utc + 'Z') : null;
    const run = rules.current_run(recent, now, cfg);
    // `run` is passed in so the banner cannot say "All clear" while the run meter says otherwise.
    const leak = rules.status({ hours, now, cfg, tz, last_read_at, started_at, run });

    const today = rules.sum_hours(hours, keys_for_today(now, tz)).total;
    const overnight = rules.sum_hours(hours, rules.overnight_keys(now, cfg, tz)).total;
    const last24 = rules.sum_hours(hours, time.recent_hour_keys(now, 24, tz)).total;
    const last7d = await readings.daily_series(meter_id, 8);
    const complete_days = last7d.slice(0, 7);            // drop today, which is partial
    const avg_day = complete_days.length
      ? complete_days.reduce(function (a, d) { return a + d.gallons; }, 0) / complete_days.length
      : 0;

    res.json({
      ok: true,
      now: now.toISOString(),
      tz: tz,
      meter_id: meter_id,
      meter_name: cfg.meter_name || null,
      leak: leak,
      // The measurement the app exists for: is water running RIGHT NOW, and for how long without
      // stopping. The hourly rules need 6 hours to speak; this answers in minutes.
      run: run,
      receiver: {
        // "online" means we heard the METER recently, not merely that the collector is up. Both
        // matter: a live collector hearing nothing is exactly the dangerous case.
        collector_up: !!heartbeat_at && (now - heartbeat_at) < 5 * 60 * 1000,
        heartbeat_at: heartbeat_at ? heartbeat_at.toISOString() : null,
        last_read_at: last_read_at ? last_read_at.toISOString() : null,
        quiet_minutes: last_read_at ? Math.round((now - last_read_at) / 60000) : null,
        stale_minutes: cfg.stale_minutes,
        radio_quiet: !!(state && state.radio_quiet),
        mode: state ? state.collector_mode : null,
        started_at: started_at ? started_at.toISOString() : null,
      },
      meter: {
        odometer_gallons: state && state.last_gallons !== null ? Number(state.last_gallons) : null,
        gallons_per_unit: cfg.gallons_per_unit,
      },
      totals: {
        today: today,
        overnight: overnight,
        overnight_window: [cfg.overnight_start_hour, cfg.overnight_end_hour],
        overnight_threshold: cfg.overnight_threshold_gal,
        last_24h: last24,
        avg_day_7d: avg_day,
      },
    });
  }));

  // ── charts ──
  app.get('/api/water/hourly', require_panel('water'), guard(async function (req, res) {
    const cfg = await settings.all();
    const series = await readings.hourly_series(cfg.meter_id, req.query.hours || 48);
    res.json({
      ok: true,
      series: series,
      overnight_window: [cfg.overnight_start_hour, cfg.overnight_end_hour],
      tz: time.zone(),
    });
  }));

  app.get('/api/water/daily', require_panel('water'), guard(async function (req, res) {
    const cfg = await settings.all();
    const series = await readings.daily_series(cfg.meter_id, req.query.days || 30);
    res.json({ ok: true, series: series, tz: time.zone() });
  }));

  app.get('/api/water/readings', require_panel('water'), guard(async function (req, res) {
    const cfg = await settings.all();
    res.json({ ok: true, readings: await readings.recent_readings(cfg.meter_id, req.query.limit || 25) });
  }));

  // ── alert history ──
  app.get('/api/water/alerts', require_panel('water'), guard(async function (req, res) {
    const rows = await alerts.recent(req.query.limit || 50);
    res.json({
      ok: true,
      alerts: rows.map(function (r) {
        let detail = null;
        // mysql2 returns JSON columns already parsed on some versions, as a string on others.
        if (r.detail) { try { detail = typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail; } catch (e) { detail = null; } }
        return {
          id: r.id, alert_key: r.alert_key, kind: r.kind, severity: r.severity,
          message: r.message, detail: detail,
          delivered: !!r.delivered, delivery_note: r.delivery_note,
          fired_at: new Date(r.fired_at_utc + 'Z').toISOString(),
          fired_at_local: r.fired_at_mtn,
        };
      }),
    });
  }));

  // ── settings (admin) ──
  app.get('/api/water/settings', require_panel('water-admin'), guard(async function (req, res) {
    const values = await settings.all({ force: true });
    res.json({
      ok: true,
      settings: settings.describe(values),
      email: { configured: mailer.configured(), sender: mailer.config().sender, recipient: mailer.config().recipient },
      tz: time.zone(),
    });
  }));

  app.post('/api/water/settings', require_panel('water-admin'), guard(async function (req, res) {
    await schema.ensure_schema(db);
    const values = await settings.set_many(req.body || {}, req.user);
    res.json({ ok: true, settings: settings.describe(values) });
  }));

  app.post('/api/water/test-alert', require_panel('water-admin'), guard(async function (req, res) {
    const cfg = await settings.all({ force: true });
    const r = await alerts.send_test(cfg, req.user);
    res.json({ ok: true, result: r });
  }));

  app.get('/api/water/email-check', require_panel('water-admin'), guard(async function (req, res) {
    res.json({ ok: true, email: await mailer.verify(), config: { sender: mailer.config().sender, host: mailer.config().host, port: mailer.config().port } });
  }));

  // ── diagnostics: the raw decoder lines, for "are the field names what we think?" ──
  app.get('/api/water/raw', require_panel('water-admin'), guard(async function (req, res) {
    const rows = await db.query(
      'SELECT id, seen_at_utc, reason, line FROM water_raw_samples ORDER BY id DESC LIMIT ?',
      [Math.max(1, Math.min(Number(req.query.limit) || 20, 200))]
    );
    res.json({ ok: true, samples: rows });
  }));
}

module.exports = { mount };
