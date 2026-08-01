'use strict';
/**
 * run.js — the collector's main loop.
 *
 * Wires the pieces together: radio source -> ingest guards -> MySQL -> leak rules -> alerts.
 * This is the process that must never stop; the web server is optional by comparison.
 *
 *   rtl433.start()  ──lines──▶  handle_line()
 *                                 ├─ ingest.extract_reading / is_our_meter / evaluate_reading
 *                                 └─ readings.insert_reading + bump_hour + save_state
 *
 *   setInterval(60s) ──▶ tick()
 *                          ├─ readings.hour_map + get_state
 *                          ├─ leak_rules.evaluate
 *                          └─ alerts.dispatch (cooldowns + email/push)
 *
 * Nothing in the tick path is allowed to throw its way out: a MySQL blip must not kill the process
 * that is watching for a flooded basement.
 */
const db = require('../../../store/db');
const schema = require('../../../store/schema');
const time = require('../../../time');
const settings = require('../store/settings');
const readings = require('../store/readings');
const alerts = require('../store/alerts');
const rules = require('../rules/leak_rules');
const ingest = require('./ingest');
const rtl433 = require('./rtl433');
const mailer = require('../../../notify/mailer');
const { create_limiter } = require('../../../rate_limit');

const TICK_MS = 60 * 1000;
const RAW_SAMPLE_LIMIT = 20;      // log this many raw lines on startup to confirm field names

// Rejected packets are logged for diagnosis, but the logging must not scale with how badly things
// are going. A radio producing continuous garbage would otherwise write ~28,000 rows of 4KB text a
// day — the diagnostics for the failure filling the disk before the failure does. Ten an hour is
// plenty to diagnose; the rest are counted and reported once.
const REJECT_LOG_PER_HOUR = 10;

// How often the retention sweep runs (in ticks). Hourly.
const SWEEP_EVERY_TICKS = 60;

// How often to log a proof-of-life line (in ticks). Every 5 minutes.
//
// Without this the collector is SILENT whenever no water is moving — which is most of the time —
// and "working perfectly, nobody is using water" looks identical to "died an hour ago" in the log.
// The dashboard can tell them apart via the heartbeat row; the log could not.
const HEARTBEAT_EVERY_TICKS = 5;

function log(msg) { console.log('[' + new Date().toISOString() + '] ' + msg); }

async function create_collector(options) {
  const opts = options || {};
  const mode = opts.mode || process.env.WATER_COLLECTOR_MODE || 'live';

  await schema.ensure_schema(db);
  await settings.seed_missing();
  let cfg = await settings.all({ force: true });

  const meter_id = cfg.meter_id;
  const started_at = new Date();

  // In-memory baseline, hydrated from the DB so a restart does not re-baseline (and therefore does
  // not silently drop the gallons used while we were down).
  let last = null;
  const prior = await readings.get_state(meter_id);
  if (prior && prior.last_gallons !== null && prior.last_read_at_utc) {
    last = { gallons: Number(prior.last_gallons), at: new Date(prior.last_read_at_utc + 'Z') };
    log('resumed: last reading ' + last.gallons.toFixed(0) + ' gal at ' + last.at.toISOString());
  } else {
    log('no prior state — the first packet becomes the baseline');
  }

  let raw_logged = 0;
  let radio_quiet = false;
  let ticks = 0;
  const reject_log = create_limiter(REJECT_LOG_PER_HOUR, 60 * 60 * 1000);
  const no_volume_log = create_limiter(REJECT_LOG_PER_HOUR, 60 * 60 * 1000);

  // Counters for the proof-of-life line, reset each time it is printed.
  let pkt_total = 0;      // every JSON line rtl_433 produced
  let pkt_ours = 0;       // ...that came from our meter id
  let gal_since = 0;      // gallons credited since the last report

  await readings.save_state(meter_id, {
    last_gallons: last ? last.gallons : null,
    last_read_at: last ? last.at : null,
    radio_quiet: false,
    collector_mode: mode,
    started_at: started_at,
  });

  // ─────────────────────────── the line handler ───────────────────────────
  async function handle_line(line) {
    if (!line || line[0] !== '{') return;

    // The first few lines go to water_raw_samples so that "what are this decoder's field names?"
    // is answerable from the UI rather than from a terminal you have since closed.
    if (raw_logged < RAW_SAMPLE_LIMIT) {
      raw_logged++;
      if (raw_logged === 1) log('first raw line: ' + line);
      await readings.log_raw('sample', line);
    }

    let msg;
    try { msg = JSON.parse(line); } catch (e) { return; }
    pkt_total++;

    const reading = ingest.extract_reading(msg);
    if (!reading) {
      // Rate-limited, and deliberately NOT gated on raw_logged.
      //
      // The bug this replaces: `if (raw_logged <= RAW_SAMPLE_LIMIT)`. raw_logged stops incrementing
      // once it reaches the limit, so the test stayed true forever and wrote one row per packet
      // indefinitely — 449 rows in 35 minutes were observed on 2026-08-01, on course for ~19,000 a
      // day. A decoder emitting a shape we cannot read is worth recording; it is not worth
      // recording nineteen thousand times.
      const gate = no_volume_log.check(new Date());
      if (gate.allowed) await readings.log_raw('no_volume', line);
      return;
    }

    // A packet from OUR meter that we cannot read is the worst kind of failure: decoding works,
    // the collector looks healthy, and nothing is ever recorded. Say so loudly and keep the line.
    if (reading.raw === null) {
      if (ingest.is_our_meter(reading, cfg.meter_id)) {
        const gate = reject_log.check(new Date());
        if (gate.allowed) {
          log('CANNOT READ VOLUME from our meter: ' + reading.error);
          log('  raw line: ' + line);
          await readings.log_raw('no_volume', line);
        }
      }
      return;
    }

    if (!ingest.is_our_meter(reading, cfg.meter_id)) return;   // a neighbour's endpoint
    pkt_ours++;

    const at = new Date();
    const gallons = reading.raw * cfg.gallons_per_unit;
    const verdict = ingest.evaluate_reading(last, gallons, at, cfg);

    if (verdict.action === 'impossible') {
      // Rate-limited: a persistently bad stream must not write a row per packet forever.
      const gate = reject_log.check(at);
      if (gate.allowed) {
        log('ignoring: ' + verdict.reason +
          (gate.dropped_since ? '  (+' + gate.dropped_since + ' more suppressed in the last hour)' : ''));
        await readings.log_raw('rejected', line);
      }
      return;                                   // baseline deliberately not advanced
    }
    if (verdict.action === 'backward' || verdict.action === 'rollover') {
      log(verdict.reason);
    }
    if (verdict.action === 'baseline') {
      log('baseline ' + gallons.toFixed(0) + ' gal');
    }

    const effects = ingest.reading_effects(verdict);

    if (effects.insert) {
      await readings.insert_reading(meter_id, at, gallons, verdict.delta);
      gal_since += verdict.delta;
      log(gallons.toFixed(0) + ' gal  (+' + verdict.delta.toFixed(0) + ')');
    }

    // Stamp the hour on every TRUSTED packet, including zero-flow ones — see reading_effects().
    // A row's existence is what marks the hour `observed`; its value is how much moved. Gating this
    // on delta > 0 (as it used to be) makes a quiet night and a dead receiver render identically.
    if (effects.bump_hour) await readings.bump_hour(meter_id, at, verdict.delta);

    if (effects.advance) {
      last = { gallons: gallons, at: at };
      await readings.save_state(meter_id, { last_gallons: gallons, last_read_at: at, radio_quiet: false });
      if (radio_quiet) { radio_quiet = false; log('reception recovered'); }
    }
  }

  // ─────────────────────────── the periodic check ─────────────────────────
  async function tick() {
    try {
      cfg = await settings.all();                      // pick up Settings-page edits without a restart
      const now = new Date();
      const hours = await readings.hour_map(meter_id, 72);

      // Heartbeat every tick, even with no packets — this is what makes "receiver silent" visible
      // in the UI rather than looking like a quiet night.
      const stale = rules.check_watchdog(last ? last.at : null, now, cfg, started_at);
      radio_quiet = !!stale;
      await readings.save_state(meter_id, { radio_quiet: radio_quiet });

      const today_keys = [];
      for (let h = 0; h <= time.local_hour(now); h++) {
        today_keys.push(time.day_key(now) + 'T' + String(h).padStart(2, '0'));
      }
      const ctx = {
        last_gallons: last ? last.gallons : null,
        today_gallons: rules.sum_hours(hours, today_keys).total,
      };

      const fired = rules.evaluate({
        hours: hours, now: now, cfg: cfg, tz: time.zone(),
        last_read_at: last ? last.at : null,
        started_at: started_at,
      });
      for (const alert of fired) {
        const r = await alerts.dispatch(alert, cfg, ctx);
        if (r.sent) log('ALERT [' + alert.kind + '] ' + alert.message + '  (' + r.note + ')');
      }

      ticks++;

      // Proof of life. The meter broadcasts every few seconds but the odometer only moves when water
      // flows, so without this the log goes quiet for hours during normal operation.
      if (ticks % HEARTBEAT_EVERY_TICKS === 0) {
        const mins = HEARTBEAT_EVERY_TICKS;
        if (pkt_total === 0) {
          log('radio SILENT — 0 packets decoded in ' + mins + 'm' +
            (last ? ' (last reading ' + Math.round((now - last.at) / 60000) + 'm ago)' : ' — never had one'));
        } else {
          log('radio ok — ' + pkt_total + ' packets in ' + mins + 'm (' + pkt_ours + ' ours)' +
            (last ? ' · odometer ' + last.gallons.toFixed(0) + ' gal' : '') +
            ' · +' + gal_since.toFixed(0) + ' gal since last report');
        }
        pkt_total = 0; pkt_ours = 0; gal_since = 0;
      }

      // Hourly retention sweep. Runs inside the tick rather than only at startup — a collector that
      // stays up for six months would otherwise never prune, which is exactly the case that matters.
      if (ticks % SWEEP_EVERY_TICKS === 0) await sweep(cfg);
    } catch (e) {
      console.error('tick failed: ' + e.message);      // never fatal
    }
  }

  async function sweep(cfg) {
    const raw = await readings.prune_raw(cfg.raw_sample_keep);
    const old_readings = await readings.prune_readings(cfg.readings_retention_days);
    const old_alerts = await readings.prune_alerts(cfg.alerts_retention_days);
    if (raw || old_readings || old_alerts) {
      log('retention sweep: removed ' + raw + ' raw, ' + old_readings + ' readings, ' + old_alerts + ' alerts');
    }
  }

  // ─────────────────────────── start the radio ────────────────────────────
  const source = rtl433.start({
    mode: mode,
    cmd: rtl433.resolve_cmd(),
    args: rtl433.resolve_args(),
    file: opts.replay_file || process.env.WATER_REPLAY_FILE,
    meter_id: meter_id,
    leak: !!opts.simulate_leak,
    interval_ms: opts.interval_ms,
    start_volume: last ? last.gallons : undefined,
    log: log,
    onLine: function (line) {
      handle_line(line).catch(function (e) { console.error('reading failed: ' + e.message); });
    },
  });

  const timer = setInterval(function () { tick(); }, TICK_MS);
  await sweep(cfg);                // once at startup, then hourly from tick()

  return {
    mode: mode,
    meter_id: meter_id,
    tick: tick,                    // exposed so tests/CLI can force a check
    sweep: sweep,                  // exposed so the CLI can force a prune
    handle_line: handle_line,
    async stop() {
      clearInterval(timer);
      try { source.stop(); } catch (e) { /* ignore */ }
      mailer.close();
      await db.end();
    },
  };
}

module.exports = { create_collector, TICK_MS };
