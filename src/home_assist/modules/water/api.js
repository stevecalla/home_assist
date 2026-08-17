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
const meters = require('./store/meters');
const alerts = require('./store/alerts');
const rules = require('./rules/leak_rules');
const mailer = require('../../notify/mailer');
const rtl433 = require('./collector/rtl433');

// One place to turn an exception into a clean 500 instead of an unhandled rejection.
function guard(fn) {
  return function (req, res) {
    Promise.resolve(fn(req, res)).catch(function (e) {
      console.error('[water] ' + req.path + ': ' + e.message);
      res.status(500).json({ ok: false, error: e.message });
    });
  };
}

/**
 * Resolve the `?meter=` selector.
 *
 * Three shapes, and the third is the new one:
 *   'mine' (or absent)  your meter
 *   'all'               no meter filter
 *   a numeric id        that meter only
 *
 * Deliberately resolved to the SAME (meter_id, scope) pair the queries already took, so adding a
 * per-meter selection changed no SQL at all -- 'mine' with a different id is exactly what the store
 * layer was already doing. An unknown id simply returns no rows, which is the right answer and
 * leaks nothing about which meters exist.
 */
function resolve_meter(raw, cfg) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (s === 'all') return { scope: 'all', meter_id: cfg.meter_id, selection: 'all' };
  if (/^[0-9]{1,20}$/.test(s)) {
    const id = Number(s);
    if (id > 0 && Number.isSafeInteger(id)) {
      return { scope: 'mine', meter_id: id, selection: String(id) };
    }
  }
  return { scope: 'mine', meter_id: cfg.meter_id, selection: 'mine' };
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
    // The whole page follows the selection, so the banner, the run meter and the four tiles all
    // describe the SAME meter. Rules are pure functions over hour buckets, so running them for a
    // neighbour is a display calculation only — nothing here fires an alert. The collector, which
    // does fire them, stays owned-only.
    const sel = resolve_meter(req.query.meter, cfg);
    const meter_id = sel.meter_id;
    const is_owned = meter_id === cfg.meter_id;

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
    // The collector's heartbeat is a property of the PROCESS, not of whichever meter you are
    // looking at. Read it from the owned meter's row always, or selecting a neighbour would report
    // the receiver as down.
    const own_state = is_owned ? state : await readings.get_state(cfg.meter_id);
    const heartbeat_at = own_state && own_state.last_heartbeat_utc ? new Date(own_state.last_heartbeat_utc + 'Z') : null;

    const started_at = own_state && own_state.started_at_utc ? new Date(own_state.started_at_utc + 'Z') : null;
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
      own_meter_id: cfg.meter_id,
      selection: sel.selection,
      is_owned: is_owned,
      meter_name: is_owned ? (cfg.meter_name || null) : null,
      // What is actually on the air. Read from the SAME resolved rtl_433 arguments the collector
      // launches with, not retyped here — if someone retunes the radio in .env, this line follows.
      // Worth showing because "no readings" has two very different causes, and one of them is
      // being tuned to the wrong frequency or running a build without the Orion decoder.
      radio: radio_info(),
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
        radio_quiet: !!(own_state && own_state.radio_quiet),
        mode: own_state ? own_state.collector_mode : null,
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

  // ── reference: the alert schedule and the operational facts, rendered from the same source the
  //    rules use. Panel 'water' (not water-admin) — knowing when you WILL be woken is not an
  //    administrative privilege, and a reference page nobody can reach documents nothing.
  app.get('/api/water/reference', require_panel('water'), guard(async function (req, res) {
    const cfg = await settings.all();
    const described = settings.describe(cfg);
    const by_name = {};
    described.forEach(function (s) { by_name[s.name] = s; });

    res.json({
      ok: true,
      tz: time.zone(),
      tick_seconds: 60,
      // Each catalog entry carries its settings' CURRENT values, so the page shows what will
      // actually happen tonight rather than what the defaults once were.
      alerts: rules.ALERT_CATALOG.map(function (a) {
        return Object.assign({}, a, {
          settings: (a.settings || []).map(function (n) {
            const d = by_name[n] || {};
            return { name: n, label: d.label || n, value: cfg[n], help: d.help || '' };
          }),
        });
      }),
      channels: {
        email: { enabled: !!cfg.alert_email_enabled, to: mailer.config().recipient || mailer.config().sender, configured: mailer.configured() },
        ntfy: { enabled: !!cfg.alert_ntfy_enabled, server: cfg.ntfy_server, topic_set: !!cfg.ntfy_topic },
      },
      retention: {
        raw_sample_keep: cfg.raw_sample_keep,
        readings_retention_days: cfg.readings_retention_days,
        hourly_retention_days: cfg.hourly_retention_days,
        observed_retention_days: cfg.observed_retention_days,
        reception_retention_days: cfg.reception_retention_days,
        packets_retention_days: cfg.packets_retention_days,
        alerts_retention_days: cfg.alerts_retention_days,
      },
      meter: { id: cfg.meter_id, name: cfg.meter_name, gallons_per_unit: cfg.gallons_per_unit },
      // The Real time tab's vocabulary, served from the SAME constants the badge and the gap
      // detector use — so the Reference page cannot drift from the thing it documents.
      signal_quality: rules.SIGNAL_QUALITY,
      packet_columns: PACKET_COLUMNS,
    });
  }));

  // ── the Monitor's meter card: two modes behind one endpoint ──────────────────────────────
  //
  // heartbeat  the reading minute-by-minute + the packet pulse + where the runs were  (<= 72h)
  // long       daily totals from the hourly rollup                                    (any range)
  //
  // One endpoint rather than two so the card can switch modes without the UI having to know which
  // table backs which mode — and so `sql` below can always describe what was actually run.
  app.get('/api/water/meter', require_panel('water'), guard(async function (req, res) {
    const cfg = await settings.all();
    const tz = time.zone();
    const now = new Date();
    const sel = resolve_meter(req.query.meter, cfg);
    const meter_id = sel.meter_id;
    const mode = req.query.mode === 'long' ? 'long' : 'heartbeat';

    // 72h is a deliberate ceiling on the detailed mode: past that, per-minute rows stop being
    // readable on an 800px chart and the long view is the honest answer.
    const HEARTBEAT_MAX_HOURS = 72;

    const state = await readings.get_state(meter_id);
    const last_read_at = state && state.last_read_at_utc ? new Date(state.last_read_at_utc + 'Z') : null;
    const live = {
      odometer: state && state.last_gallons !== null ? Number(state.last_gallons) : null,
      last_read_at: last_read_at ? last_read_at.toISOString() : null,
      seconds_since_last: last_read_at ? Math.max(0, Math.round((now - last_read_at) / 1000)) : null,
    };

    if (mode === 'long') {
      const days = Math.max(1, Math.min(Number(req.query.days) || 30, 400));
      const series = await readings.daily_series_range(meter_id, days);
      const observed = series.filter(function (d) { return d.observed; });
      const avg = observed.length
        ? observed.reduce(function (a, d) { return a + d.gallons; }, 0) / observed.length : 0;
      return res.json({
        ok: true, mode, tz, days, live,
        meter_id: meter_id, own_meter_id: cfg.meter_id, selection: sel.selection,
        series,
        summary: {
          total: series.reduce(function (a, d) { return a + d.gallons; }, 0),
          avg_day: avg,
          // "Unusual" is relative to this window, not an absolute — a house that uses 40 gal/day and
          // one that uses 400 both deserve the same treatment.
          high_threshold: avg * 1.5,
        },
        sql: long_sql(meter_id, days),
      });
    }

    const hours = Math.max(1, Math.min(Number(req.query.hours) || HEARTBEAT_MAX_HOURS, HEARTBEAT_MAX_HOURS));
    const [rx, recent] = await Promise.all([
      readings.reception_series(meter_id, hours * 60),
      readings.recent_readings(meter_id, 500),
    ]);

    // Only the readings inside the window get spans — a run that ended before the window opened
    // would draw a band with no line under it.
    const cutoff = now.getTime() - hours * 3600 * 1000;
    const in_window = recent.filter(function (r) {
      return new Date(String(r.read_at_utc).replace(' ', 'T') + 'Z').getTime() >= cutoff;
    });

    res.json({
      ok: true, mode, tz, hours, live,
      meter_id: meter_id, own_meter_id: cfg.meter_id, selection: sel.selection,
      max_hours: HEARTBEAT_MAX_HOURS,
      series: rx.map(function (r) {
        return {
          minute_utc: new Date(r.minute_utc + 'Z').toISOString(),
          minute_mtn: r.minute_mtn,
          odometer: r.odometer === null ? null : Number(r.odometer),
          // packets_meter, not packets_ours: on a neighbour's row "ours" is zero by definition and
          // the chart would draw a flatline that reads as "the radio heard nothing".
          packets: Number(r.packets_meter),
          rssi: r.rssi_avg === null ? null : Number(r.rssi_avg),
          snr: r.snr_avg === null ? null : Number(r.snr_avg),
        };
      }),
      runs: rules.run_spans(in_window, cfg),
      run: rules.current_run(recent, now, cfg),
      overnight: [cfg.overnight_start_hour, cfg.overnight_end_hour],
      sql: heartbeat_sql(meter_id, hours),
    });
  }));

  // ── packets: the granular, near-real-time record ─────────────────────────────────────────
  //
  // One row per decoded transmission. `meter=all` is a DISPLAY filter — what gets captured is
  // decided by packets_capture_all_meters in settings, not by this query string.
  app.get('/api/water/packets', require_panel('water'), guard(async function (req, res) {
    const cfg = await settings.all();
    const tz = time.zone();
    const now = new Date();
    const sel = resolve_meter(req.query.meter, cfg);
    const scope = sel.scope;
    const hours = Math.max(0.05, Math.min(Number(req.query.hours) || 1, cfg.packets_retention_days * 24));

    // The fetch limit is a RENDER and TRANSFER limit, not a claim about the window. Everything
    // downstream that reasons about coverage uses `counts`, not the length of this array.
    const LIMIT = Math.max(1, Math.min(Number(req.query.limit) || 3000, 20000));
    const [rows, heard, counts] = await Promise.all([
      readings.packet_series(sel.meter_id, hours, scope, LIMIT),
      readings.meters_heard(hours),
      readings.packet_count(sel.meter_id, hours, scope),
    ]);

    const packets = rows.map(function (r) {
      return {
        meter_id: Number(r.meter_id),
        heard_at_utc: new Date(String(r.heard_at_utc).replace(' ', 'T') + 'Z').toISOString(),
        heard_at_mtn: r.heard_at_mtn,
        is_ours: !!r.is_ours,
        volume: r.volume === null ? null : Number(r.volume),
        delta: r.delta === null ? null : Number(r.delta),
        flags_1: r.flags_1, flags_2: r.flags_2, integrity: r.integrity,
        rssi: r.rssi === null ? null : Number(r.rssi),
        snr: r.snr === null ? null : Number(r.snr),
        noise: r.noise === null ? null : Number(r.noise),
        freq_mhz: r.freq_mhz === null ? null : Number(r.freq_mhz),
      };
    });

    // The stats below are about the meter IN FOCUS, which is not always yours any more. On "all
    // meters" that stays your meter -- mixing several endpoints' arrival times into one median
    // interval would describe no real transmitter. On a specific selection it is that meter, so a
    // neighbour's decode rate and gaps describe the neighbour rather than reporting a flat zero.
    const focus = sel.selection === 'all'
      ? packets.filter(function (p) { return p.is_ours; })
      : packets;
    const focus_total = sel.selection === 'all' ? counts.ours : counts.total;
    const interval = rules.median_interval(focus);

    const window_seconds = Math.round(hours * 3600);
    const first_at = counts.first_utc
      ? new Date(String(counts.first_utc).replace(' ', 'T') + 'Z') : null;
    const covered = first_at
      ? Math.min(window_seconds, Math.max(interval, Math.round((now - first_at) / 1000)))
      : 0;
    const coverage = {
      seconds: covered,
      window_seconds: window_seconds,
      // Below ~95% the window reaches back further than the recording does, and the UI should say
      // "recording since 12:31" rather than quote a percentage of something it never saw.
      partial: covered < window_seconds * 0.95,
      first_mtn: counts.first_mtn || null,
    };
    res.json({
      ok: true, tz, hours, scope,
      // What was returned vs what is there. The UI must be able to tell the difference, or a
      // truncated window looks like a quiet one.
      counts: {
        returned: packets.length,
        window_total: counts.total,
        window_ours: counts.ours,
        limit: LIMIT,
        truncated: counts.total > packets.length,
      },
      // Measured against the FULL window count, never against the truncated array — and against
      // the span actually COVERED, not the span requested.
      //
      // The bug this replaces: dividing by the whole window. Enable packet recording, open the 24h
      // view three hours later, and the tab reported 13.9% decoded — which reads as "the radio is
      // missing six packets in seven" when the real answer is "we have only been recording for
      // three of these twenty-four hours". Same number, opposite conclusions, and the alarming one
      // was the one on screen. Coverage and reception are different facts and now they are two
      // different fields.
      decode: rules.decode_rate({ length: focus_total }, interval, coverage.seconds),
      coverage: coverage,
      meter_id: sel.meter_id,
      own_meter_id: cfg.meter_id,
      selection: sel.selection,
      enabled: !!cfg.packets_enabled,
      capture_all: !!cfg.packets_capture_all_meters,
      retention_days: cfg.packets_retention_days,
      max_hours: cfg.packets_retention_days * 24,
      // The expected interval is measured, not assumed. A Badger Orion is nominally ~4s, but the
      // number that matters for "how many did I miss" is what THIS endpoint actually does at THIS
      // antenna — and that is only knowable by looking.
      interval_seconds: interval,
      gaps: rules.gap_spans(focus, interval),
      packets: packets,
      meters: heard.map(function (m) {
        return {
          meter_id: Number(m.meter_id),
          is_ours: !!m.is_ours,
          packets: Number(m.packets),
          rssi_avg: m.rssi_avg === null ? null : Number(Number(m.rssi_avg).toFixed(2)),
          snr_avg: m.snr_avg === null ? null : Number(Number(m.snr_avg).toFixed(2)),
          first_seen: m.first_seen,
          last_seen: m.last_seen,
        };
      }),
      // Thresholds live here, next to the data, so the badge in the UI and any future alert on
      // signal quality can never disagree about what "weak" means.
      quality: rules.SIGNAL_QUALITY,
      columns: PACKET_COLUMNS,
      sql: packets_sql(sel.meter_id, hours, scope),
      now: now.toISOString(),
    });
  }));

  // ── the meter selector's list ──────────────────────────────────────────────────────────────
  //
  // Panel 'water', not 'water-admin': choosing which meter you are looking at is not an
  // administrative act. Served from water_meters rather than derived from water_packets, because
  // packets are pruned within a day and a dropdown whose options vanish overnight reads as a bug.
  app.get('/api/water/meters', require_panel('water'), guard(async function (req, res) {
    const cfg = await settings.all();
    const list = await meters.list();
    res.json({
      ok: true,
      own_meter_id: cfg.meter_id,
      observed_retention_days: cfg.observed_retention_days,
      // The fallback shown beside an empty per-meter address box, so "blank" is never a mystery.
      default_email_to: mailer.parse_recipients(cfg.alert_email_to).join(', ')
        || mailer.config().recipient || mailer.config().sender || '',
      email_enabled: !!cfg.alert_email_enabled,
      meters: list,
    });
  }));

  // ── editing a meter ────────────────────────────────────────────────────────────────────────
  //
  // water-admin, not water: choosing which meter you LOOK at is not administrative, but deciding
  // which meter is allowed to email you at 3am certainly is.
  app.post('/api/water/meters/:id', require_panel('water-admin'), guard(async function (req, res) {
    const cfg = await settings.all();
    const r = await meters.update(req.params.id, req.body || {}, cfg.meter_id);
    if (!r.ok) return res.status(400).json(r);
    res.json({ ok: true, meters: await meters.list() });
  }));

  // Prove the address works BEFORE a leak has to. A per-meter test send, using exactly the same
  // resolution the collector will use -- the meter's own list if it has one, otherwise the global.
  app.post('/api/water/meters/:id/test', require_panel('water-admin'), guard(async function (req, res) {
    const cfg = await settings.all();
    const id = Number(req.params.id) || 0;
    const list = await meters.list();
    const m = list.find(function (x) { return Number(x.meter_id) === id; });
    if (!m) return res.status(404).json({ ok: false, error: 'no such meter' });
    const to = meters.recipients_for(m, cfg.alert_email_to);
    const mail = {
      subject: '[WATER] Test alert — meter ' + id,
      text: 'Test alert from home_assist for meter ' + id + '. If you are reading this, alerts for '
        + 'this meter can reach you.',
      html: mailer.html_alert({
        title: 'Water monitor',
        headline: 'Test alert — meter ' + id,
        color: alerts.COLORS.test,
        rows: [['Meter', String(id)], ['Delivery', m.notify ? 'on' : 'recorded only (delivery is off)'],
          ['Recipients', to || '(none configured)']],
        footer: 'Sent from the Meters page. Nothing was recorded in the alert history.',
      }),
    };
    const r = await mailer.send({ to: to || undefined, subject: mail.subject, text: mail.text, html: mail.html });
    res.json({ ok: true, sent: r.ok, to: to, accepted: r.accepted || [], rejected: r.rejected || [], error: r.error || null });
  }));

  // ── reception: the persistent "is the radio hearing my meter" record ──
  app.get('/api/water/reception', require_panel('water'), guard(async function (req, res) {
    const cfg = await settings.all();
    const sel = resolve_meter(req.query.meter, cfg);
    const minutes = Math.max(5, Math.min(Number(req.query.minutes) || 60, 1440));
    const [series, state] = await Promise.all([
      readings.reception_series(sel.meter_id, minutes),
      readings.get_state(sel.meter_id),
    ]);
    const now = new Date();
    const last_read_at = state && state.last_read_at_utc ? new Date(state.last_read_at_utc + 'Z') : null;
    res.json({
      ok: true,
      tz: time.zone(),
      minutes: minutes,
      meter_id: sel.meter_id,
      own_meter_id: cfg.meter_id,
      selection: sel.selection,
      // Seconds since the last packet from OUR meter. This is the real-time number — the per-minute
      // series is the history behind it.
      seconds_since_last: last_read_at ? Math.max(0, Math.round((now - last_read_at) / 1000)) : null,
      series: series.map(function (r) {
        return {
          minute_utc: new Date(r.minute_utc + 'Z').toISOString(),
          minute_mtn: r.minute_mtn,
          packets_total: Number(r.packets_total),
          packets_ours: Number(r.packets_ours),
          // Packets from the meter this row is ABOUT. On a neighbour's row packets_ours is zero by
          // definition, so a chart plotting that column flatlines -- and a flat zero on this chart
          // means "the radio heard nothing", the exact wrong conclusion.
          packets_meter: Number(r.packets_meter),
          other_ids: r.other_ids || null,
          rssi_avg: r.rssi_avg === null ? null : Number(r.rssi_avg),
          rssi_best: r.rssi_best === null ? null : Number(r.rssi_best),
          snr_avg: r.snr_avg === null ? null : Number(r.snr_avg),
        };
      }),
    });
  }));

  // ── charts ──
  app.get('/api/water/hourly', require_panel('water'), guard(async function (req, res) {
    const cfg = await settings.all();
    const sel = resolve_meter(req.query.meter, cfg);
    const series = await readings.hourly_series(sel.meter_id, req.query.hours || 48);
    res.json({
      ok: true,
      series: series,
      meter_id: sel.meter_id, own_meter_id: cfg.meter_id, selection: sel.selection,
      overnight_window: [cfg.overnight_start_hour, cfg.overnight_end_hour],
      tz: time.zone(),
    });
  }));

  app.get('/api/water/daily', require_panel('water'), guard(async function (req, res) {
    const cfg = await settings.all();
    const sel = resolve_meter(req.query.meter, cfg);
    const series = await readings.daily_series(sel.meter_id, req.query.days || 30);
    res.json({
      ok: true, series: series, tz: time.zone(),
      meter_id: sel.meter_id, own_meter_id: cfg.meter_id, selection: sel.selection,
    });
  }));

  app.get('/api/water/readings', require_panel('water'), guard(async function (req, res) {
    const cfg = await settings.all();
    const sel = resolve_meter(req.query.meter, cfg);
    res.json({
      ok: true,
      meter_id: sel.meter_id, own_meter_id: cfg.meter_id, selection: sel.selection,
      readings: await readings.recent_readings(sel.meter_id, req.query.limit || 25),
    });
  }));

  // ── alert history ──
  app.get('/api/water/alerts', require_panel('water'), guard(async function (req, res) {
    const cfg = await settings.all();
    const sel = resolve_meter(req.query.meter, cfg);
    // 'all' means every meter's history in one list, which is genuinely useful here -- unlike a
    // usage chart, alerts from two meters can sit side by side without being summed into a lie.
    const filter = sel.selection === 'all' ? 0 : sel.meter_id;
    const rows = await alerts.recent(req.query.limit || 50, filter, cfg.meter_id);
    res.json({
      ok: true,
      meter_id: sel.meter_id,
      own_meter_id: cfg.meter_id,
      selection: sel.selection,
      alerts: rows.map(function (r) {
        let detail = null;
        // mysql2 returns JSON columns already parsed on some versions, as a string on others.
        if (r.detail) { try { detail = typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail; } catch (e) { detail = null; } }
        return {
          id: r.id, alert_key: r.alert_key, kind: r.kind, severity: r.severity,
          // 0 = written before alerts were per-meter, when only one meter could raise one.
          meter_id: Number(r.meter_id) || cfg.meter_id,
          is_ours: (Number(r.meter_id) || cfg.meter_id) === cfg.meter_id,
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
    // seen_at_mtn as well as _utc. This endpoint returned only UTC and the Diagnostics table
    // rendered it under a "Seen (UTC)" heading — honestly labelled, but it made this the one table
    // in the app on a different clock from every other. Comparing a raw line against a pm2 log or
    // against the heartbeat above it then meant doing timezone arithmetic in your head, which is
    // exactly the tax the dual-timestamp convention exists to remove.
    const rows = await db.query(
      'SELECT id, seen_at_utc, seen_at_mtn, reason, line FROM water_raw_samples ORDER BY id DESC LIMIT ?',
      [Math.max(1, Math.min(Number(req.query.limit) || 20, 200))]
    );
    res.json({ ok: true, tz: time.zone(), samples: rows });
  }));
}


// The SQL shown in the card's "Data source & SQL" panel.
//
// Built from the SAME parameters the queries above actually used, so what the panel displays can be
// pasted into Workbench and return the rows the chart drew. A hand-written copy would drift.
function heartbeat_sql(meter_id, hours) {
  return [
    { label: 'Reading + pulse', table: 'water_reception', text:
      'SELECT minute_mtn, odometer, GREATEST(packets, packets_ours) AS packets_meter\n' +
      'FROM   water_reception\n' +
      'WHERE  meter_id   = ' + meter_id + '\n' +
      '  AND  minute_utc >= (UTC_TIMESTAMP() - INTERVAL ' + hours + ' HOUR)\n' +
      'ORDER BY minute_utc;   -- odometer = the line, packets_meter = the pulse' },
    { label: 'Runs (the red bands)', table: 'water_readings', text:
      'SELECT read_at_utc, delta_gallons\n' +
      'FROM   water_readings\n' +
      'WHERE  meter_id    = ' + meter_id + '\n' +
      '  AND  read_at_utc >= (UTC_TIMESTAMP() - INTERVAL ' + hours + ' HOUR)\n' +
      'ORDER BY read_at_utc;   -- grouped into runs by run_gap_min' },
    { label: 'Live tip', table: 'water_collector_state', text:
      'SELECT last_gallons, last_read_at_utc\n' +
      'FROM   water_collector_state WHERE meter_id = ' + meter_id + ';' },
  ];
}

function long_sql(meter_id, days) {
  return [
    { label: 'Daily totals', table: 'water_hourly', text:
      'SELECT LEFT(hour_key, 10) AS day_key, SUM(gallons) AS gallons\n' +
      'FROM   water_hourly\n' +
      'WHERE  meter_id  = ' + meter_id + '\n' +
      '  AND  hour_key >= \'' + require('../../time').day_key_offset(new Date(), days - 1) + 'T00\'\n' +
      'GROUP BY day_key ORDER BY day_key;   -- local (MTN) hour keys' },
    { label: 'Live tip', table: 'water_collector_state', text:
      'SELECT last_gallons, last_read_at_utc\n' +
      'FROM   water_collector_state WHERE meter_id = ' + meter_id + ';' },
  ];
}

/**
 * The transmitter, described from the running configuration.
 *
 * Protocol 223 is "Badger ORION water meter, 100kbps" in rtl_433's table. The classic Orion endpoint
 * is a fixed-frequency ISM transmitter, which is why the frequency is a constant in the args rather
 * than something the receiver hunts for.
 */
function radio_info() {
  let args = '';
  try { args = rtl433.resolve_args() || ''; } catch (e) { args = ''; }
  const freq = /-f\s+([0-9.]+)\s*M/i.exec(args);
  const proto = /-R\s+(\d+)/.exec(args);
  const rate = /-s\s+([0-9.]+)\s*k/i.exec(args);
  return {
    model: 'Badger ORION water meter',
    decoder: proto ? 'rtl_433 protocol ' + proto[1] : 'rtl_433 (protocol not pinned)',
    protocol: proto ? Number(proto[1]) : null,
    frequency_mhz: freq ? Number(freq[1]) : null,
    sample_rate_khz: rate ? Number(rate[1]) : null,
    args: args || null,
  };
}

/**
 * Column definitions for the Real time table.
 *
 * Served from the API rather than typed into the React component so that the tooltip explaining a
 * column and the query producing it live in the same file. A header tooltip that has drifted from
 * the data underneath it is worse than no tooltip — it is confidently wrong.
 *
 * `good` is written for someone who has never read an SDR datasheet. "-9 dBm" means nothing on its
 * own; "strong — a few feet of coax or a wall away" is the sentence that lets you act.
 */
const PACKET_COLUMNS = [
  { key: 'heard_at_mtn', label: 'Heard at', align: 'center', type: 'time',
    help: 'When the receiver decoded this transmission, to the millisecond, in the meter timezone. NOT when the water moved -- the meter reports its running total, it does not report events.' },
  { key: 'meter_id', label: 'Meter', align: 'center', type: 'id',
    help: 'The endpoint serial broadcast in the packet. Yours is highlighted. Anything else is a neighbour: captured for antenna comparison, never counted toward your usage.' },
  { key: 'volume', label: 'Volume', align: 'center', type: 'num',
    help: 'The lifetime odometer exactly as transmitted, before gallons_per_unit is applied. The same number as the dial in the pit.' },
  { key: 'delta', label: 'Delta', align: 'center', type: 'delta',
    help: 'Change since this meter previous packet. A faint 0 is the NORMAL case and means the odometer did not move -- the endpoint re-broadcasts the same total every few seconds and only steps when a whole gallon has passed, which at a running tap is roughly once a minute and when nothing is running is never. A blue +1 marks the packet where a gallon landed. An em dash means no previous packet to compare against, so the first row after a collector restart always shows one.' },
  { key: 'flags_1', label: 'Flags-1', align: 'center', type: 'num',
    help: 'Status bits from the endpoint, undecoded by rtl_433. What matters is not the value but whether it CHANGES: a constant number is simply how your endpoint reports its normal state, while a byte that suddenly starts differing is the meter signalling something -- Badger uses these for tamper, backflow and leak indications.' },
  { key: 'flags_2', label: 'Flags-2', align: 'center', type: 'num',
    help: 'A second status byte, same story as Flags-1: judge it by whether it changes, not by whether it is zero. A steady non-zero value is the endpoint idle state and is not a fault. Note the date if it ever starts moving -- that is the meter telling you something the decoder does not yet translate.' },
  { key: 'integrity', label: 'Integrity', align: 'center', type: 'text',
    help: 'The checksum the decoder verified -- rtl_433 reports this as mic. CRC means the packet arrived intact. A packet that FAILS the check never becomes a row at all, it becomes a gap, which is the more useful thing to see. Blank means the decoder did not report a check for this packet.' },
  { key: 'rssi', label: 'RSSI', align: 'center', type: 'rssi', unit: 'dBm',
    help: 'Raw received power. Higher (closer to 0) is stronger; these are negative numbers, so -9 is much stronger than -20. Above -12 is a solid signal. Below -20 you are relying on luck. Needs -M level in WATER_RTL433_ARGS.' },
  { key: 'snr', label: 'SNR', align: 'center', type: 'snr', unit: 'dB',
    help: 'How far the signal sits above the background noise -- the number that actually predicts whether a packet decodes. Above 18 dB is comfortable, 10-18 dB works but drops packets, below 10 dB is where gaps start. Move the antenna to raise this one.' },
  { key: 'noise', label: 'Noise', align: 'center', type: 'num', unit: 'dBm',
    help: 'The noise floor when this packet arrived. Rising noise with unchanged RSSI means new interference nearby, not a weaker meter.' },
  { key: 'freq_mhz', label: 'Freq', align: 'center', type: 'freq', unit: 'MHz',
    help: 'Where the packet actually landed. Needs -M level in WATER_RTL433_ARGS, the same flag that supplies rssi/snr/noise -- one flag adds Modulation, Frequency, RSSI, SNR and Noise together. (There is no -M freq; it is not a valid value and passing it suppresses the whole set.) The Orion is fixed at 916.45 MHz; drift beyond about 0.01 MHz across many packets suggests the dongle crystal wants a PPM correction.' },
];

function packets_sql(meter_id, hours, scope) {
  const secs = Math.round(hours * 3600);
  return [
    { label: 'Every transmission in the window', table: 'water_packets', text:
      'SELECT heard_at_mtn, meter_id, is_ours, volume, `delta`, flags_1, flags_2,\n' +
      '       integrity, rssi, snr, noise, freq_mhz\n' +
      'FROM   water_packets\n' +
      'WHERE  heard_at_utc >= (UTC_TIMESTAMP() - INTERVAL ' + secs + ' SECOND)\n' +
      (scope === 'all' ? '' : '  AND  meter_id = ' + meter_id + '\n') +
      'ORDER BY heard_at_utc;   -- one row per decoded packet' },
    { label: 'Meters heard (the antenna scoreboard)', table: 'water_packets', text:
      'SELECT meter_id, COUNT(*) AS packets, AVG(rssi) AS rssi_avg, AVG(snr) AS snr_avg\n' +
      'FROM   water_packets\n' +
      'WHERE  heard_at_utc >= (UTC_TIMESTAMP() - INTERVAL ' + secs + ' SECOND)\n' +
      'GROUP BY meter_id ORDER BY packets DESC;' },
  ];
}

module.exports = { mount };
