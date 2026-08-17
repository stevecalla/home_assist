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
const meters = require('../store/meters');
const alerts = require('../store/alerts');
const rules = require('../rules/leak_rules');
const ingest = require('./ingest');
const rtl433 = require('./rtl433');
const mailer = require('../../../notify/mailer');
const { create_limiter } = require('../../../rate_limit');

const TICK_MS = 60 * 1000;

// The packet buffer flushes on its OWN timer, not on the 60-second tick.
//
// This was the bug: buffering per packet and flushing per tick meant water_packets gained rows once
// a MINUTE, in batches of fifteen. The Real time tab polled every four seconds and correctly showed
// nothing new for fifty-six of them, then fifteen rows at once. A "real time" view fed by a
// once-a-minute write is not real time, however fast the browser asks.
//
// Five seconds was one INSERT of one or two rows — cheap, but it made water_packets lag
// water_collector_state by up to five seconds, and the two are shown side by side. The banner reads
// state ("last packet 20:30:18") while the table reads packets (newest row 20:30:14), and a five
// second disagreement between two numbers an inch apart reads as a bug even though both are true.
//
// 2.5s is still a batched INSERT (a meter transmits every ~4s, so a flush carries 1-2 rows for a
// two-meter site) and halves the visible skew. The UI does the rest -- Monitor derives ONE
// last-packet time and shows it everywhere, rather than letting two clocks race.
const PACKET_FLUSH_MS = 2500;
// A decoder field that is present but not a number (or absent entirely) must become NULL, not 0 —
// "the radio did not report this" and "the radio reported zero" are different facts, and -M level
// being off is exactly the case that produces the first one.
function num_or_null(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Decoder field names, in preference order — the same tolerance `ingest.extract_reading` applies to
 * the volume field, and for the same reason: rtl_433's JSON keys are not a stable contract.
 *
 * INTEGRITY — rtl_433 emits the checksum result as `mic` (Message Integrity Check) across every
 *   decoder. This code read `Integrity`, which is the name our own SYNTHETIC replay meter emits and
 *   nothing else does. Replay mode populated the column, the real radio left it NULL, and the
 *   difference only showed up on live hardware. `Integrity` stays in the list so replay keeps
 *   working; `mic` is first because it is what the actual decoder says.
 *
 * FREQUENCY — for an FSK protocol like the Orion, rtl_433 reports the two tone frequencies as
 *   `freq1` and `freq2`, not a single `freq`. All of these arrive from `-M level`, which adds
 *   Modulation, Frequency, RSSI, SNR and Noise together. There is no separate `-M freq` — it is not
 *   a valid value, and passing it costs you the whole set.
 */
const INTEGRITY_FIELDS = ['mic', 'Integrity', 'integrity', 'crc', 'CRC'];
const FREQ_FIELDS = ['freq', 'freq1', 'frequency'];

function first_str(msg, names) {
  for (const n of names) {
    if (msg[n] !== undefined && msg[n] !== null && String(msg[n]) !== '') {
      return String(msg[n]).slice(0, 16);
    }
  }
  return null;
}

function first_num(msg, names) {
  for (const n of names) {
    const v = num_or_null(msg[n]);
    if (v !== null) return v;
  }
  return null;
}

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
  // Which meter ids we actually heard, and how often. Without this, "0 ours" tells you something is
  // wrong but not what: a neighbour's endpoint arriving loud and clear looks identical in the log to
  // silence plus noise. Naming the ids turns "why is nothing recorded?" into "you are hearing
  // 14905174, not 16642655" — a reception/config answer instead of a mystery.
  let ids_seen = new Map();
  // Per-minute reception accumulators. Written to water_reception on every tick, so there is a
  // PERSISTENT record of what the radio heard — the thing water_raw_samples deliberately is not.
  let rx_total = 0, rx_ours = 0;
  let rssi_sum = 0, rssi_n = 0, rssi_best = null, snr_sum = 0, snr_n = 0;

  // Every decoded transmission this tick, flushed as ONE insert. Not one round-trip per packet:
  // at ~15 packets a minute that would be 15 needless network hops a minute, forever, on the
  // process that must never fall behind the radio.
  //
  // `last_volume` is per METER, so `delta` is meaningful for a neighbour's endpoint too — which is
  // what makes their trace usable as a reference signal rather than a flat line of raw counts.
  let packet_buf = [];
  const last_volume = new Map();

  // ── OTHER METERS ────────────────────────────────────────────────────────────────────────────
  //
  // The owned meter's path below is untouched, deliberately. It feeds the leak rules, the alerts
  // and the watchdog, and none of that should change shape because a neighbour appeared. Other
  // meters get a PARALLEL path: same ingest guards, same tables, their own baselines -- and no
  // rules, no alerts, no watchdog, ever.
  //
  // Baselines are per meter because `evaluate_reading` compares against the last accepted value.
  // Sharing one baseline across meters would make every alternating packet look like a wild jump
  // and the rate filter would reject the lot.
  const other_last = new Map();
  // Per-minute reception accumulators, per meter. water_reception's packets_ours column assumed
  // exactly one meter existed; `packets` is the honest per-row count.
  const other_rx = new Map();
  // meter_id -> gallons per tick. A Badger classic counts 1 gallon, a newer endpoint 0.1, so
  // applying the wrong factor is a silent 10x error that looks entirely plausible on a chart.
  let scales = new Map();
  // Observed meters that the rules should run for, refreshed each tick from the registry, plus
  // their per-meter run-alarm memory. Keyed by meter id so one neighbour's shower cannot cancel
  // another's all-clear.
  let observed_meters = [];
  const observed_alarm_run = new Map();

  function rx_for(id) {
    let e = other_rx.get(id);
    if (!e) { e = { packets: 0, rssi_sum: 0, rssi_n: 0, rssi_best: null, snr_sum: 0, snr_n: 0, odometer: null }; other_rx.set(id, e); }
    return e;
  }

  /**
   * The ingest path for a meter that is not ours.
   *
   * Everything here is bookkeeping: it never throws its way out, never touches `last`, and never
   * reaches a rule. If it fails, the owned meter carries on exactly as before.
   */
  async function ingest_other(pid, raw_volume, msg2, at) {
    try {
      const scale = scales.get(pid) || 1;
      const gallons = raw_volume * scale;
      const prev = other_last.get(pid) || null;
      const verdict = ingest.evaluate_reading(prev, gallons, at, cfg);

      const rx = rx_for(pid);
      rx.packets += 1;
      if (typeof msg2.rssi === 'number' && Number.isFinite(msg2.rssi)) {
        rx.rssi_sum += msg2.rssi; rx.rssi_n += 1;
        if (rx.rssi_best === null || msg2.rssi > rx.rssi_best) rx.rssi_best = msg2.rssi;
      }
      if (typeof msg2.snr === 'number' && Number.isFinite(msg2.snr)) { rx.snr_sum += msg2.snr; rx.snr_n += 1; }

      if (verdict.action === 'impossible') return;    // baseline deliberately not advanced
      const effects = ingest.reading_effects(verdict);
      if (effects.insert) await readings.insert_reading(pid, at, gallons, verdict.delta);
      if (effects.bump_hour) await readings.bump_hour(pid, at, verdict.delta);
      if (effects.advance) {
        other_last.set(pid, { gallons: gallons, at: at });
        rx.odometer = gallons;
        await readings.save_state(pid, { last_gallons: gallons, last_read_at: at, radio_quiet: false });
      }
    } catch (e) {
      // Never fatal. A neighbour's row failing to write must not disturb the process watching for
      // a flooded basement.
    }
  }

  // The run that last raised an alarm, held only in memory. A collector restart loses it, and that
  // is the right trade: the cost is one missed all-clear, and the alternative — a table — would
  // make a purely informational follow-up into schema.
  let last_alarm_run = null;
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
    rx_total++;

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

    if (reading.id !== null && reading.id !== undefined) {
      ids_seen.set(reading.id, (ids_seen.get(reading.id) || 0) + 1);
    }

    // ── the granular record ────────────────────────────────────────────────────────────────
    // Buffered BEFORE the meter filter below, so a neighbour's endpoint is captured. Capture and
    // COUNTING are different things and this is the line between them: everything past this point
    // is our meter only. A neighbour can never advance the odometer, enter a leak rule, or raise an
    // alert — it exists here so that "did moving the antenna help?" has a control to compare
    // against, which one meter alone cannot provide.
    const ours_now = ingest.is_our_meter(reading, cfg.meter_id);
    if (cfg.packets_enabled && (ours_now || cfg.packets_capture_all_meters)) {
      const pid = reading.id === null || reading.id === undefined ? cfg.meter_id : reading.id;
      const vol = reading.raw;
      const prev = last_volume.get(pid);
      last_volume.set(pid, vol);
      const st = time.stamps(new Date());
      packet_buf.push({
        meter_id: pid,
        // Carried for the registry only -- record_packets maps columns explicitly and ignores it.
        model: typeof msg.model === 'string' ? msg.model : null,
        heard_at_utc: st.utc_ms || st.utc,
        heard_at_mtn: st.local_ms || st.local,
        is_ours: ours_now,
        volume: vol,
        delta: prev === undefined ? null : Number((vol - prev).toFixed(2)),
        flags_1: num_or_null(msg['Flags-1'] !== undefined ? msg['Flags-1'] : msg.flags_1),
        flags_2: num_or_null(msg['Flags-2'] !== undefined ? msg['Flags-2'] : msg.flags_2),
        integrity: first_str(msg, INTEGRITY_FIELDS),
        rssi: num_or_null(msg.rssi),
        snr: num_or_null(msg.snr),
        noise: num_or_null(msg.noise),
        freq_mhz: first_num(msg, FREQ_FIELDS),
      });
    }

    if (!ours_now) {
      // Captured above as a packet; now also stored as readings and hourly totals so every view can
      // show it. Still never counted toward YOUR usage, never a rule, never an alert.
      const opid = reading.id === null || reading.id === undefined ? cfg.meter_id : reading.id;
      await ingest_other(opid, reading.raw, msg, new Date());
      return;
    }
    pkt_ours++;
    rx_ours++;

    // Signal strength, when the decoder is reporting it (-M level in WATER_RTL433_ARGS). Optional
    // by design: the reception COUNT is the thing that matters, and it works without extra flags.
    if (typeof msg.rssi === 'number' && Number.isFinite(msg.rssi)) {
      rssi_sum += msg.rssi; rssi_n++;
      if (rssi_best === null || msg.rssi > rssi_best) rssi_best = msg.rssi;
    }
    if (typeof msg.snr === 'number' && Number.isFinite(msg.snr)) { snr_sum += msg.snr; snr_n++; }

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

  /**
   * Run the leak rules for every meter that is not ours.
   *
   * Detection and delivery are separate concerns here. Everything below is recorded; `notify` on
   * water_meters decides whether anything is actually SENT, and it defaults to 0 for a neighbour.
   *
   * Deliberately omitted: the watchdog (`last_read_at` is passed as `now`, which can never be
   * stale). Silence from a neighbour is a fact about my antenna, not about their plumbing, and an
   * alert that fires whenever reception dips is an alert you learn to ignore.
   */
  async function tick_observed(now) {
    const reg = observed_meters;
    if (!reg.length) return;
    for (const m of reg) {
      const pid = Number(m.meter_id);
      try {
        const hours = await readings.hour_map(pid, 72);
        const recent = await readings.recent_readings(pid, 500);
        const current = rules.current_run(recent, now, cfg);
        const fired = rules.evaluate({
          hours: hours, now: now, cfg: cfg, tz: time.zone(),
          // `now`, not their last reading: this is what disables the watchdog for observed meters.
          last_read_at: now,
          started_at: started_at,
          run: current,
          last_alarm_run: observed_alarm_run.get(pid) || null,
        });
        for (const alert of fired) {
          if (alert.kind === 'stale') continue;          // belt and braces -- see above
          const r = await alerts.dispatch(alert, cfg, {
            meter_id: pid,
            notify: !!m.notify,
            last_gallons: (other_last.get(pid) || {}).gallons ?? null,
          });
          if (r.sent) log('ALERT [' + alert.kind + '] meter ' + pid + ' ' + alert.message + '  (' + r.note + ')');
          if (alert.kind === 'run') {
            observed_alarm_run.set(pid, {
              key: alert.key, minutes: current.minutes,
              gallons: current.gallons, started_at: current.started_at,
            });
          }
        }
        if (observed_alarm_run.get(pid) && !current.flowing) observed_alarm_run.delete(pid);
      } catch (e) { /* one meter's rules must never stop the next, or the owned tick */ }
    }
  }

  // ─────────────────────────── the periodic check ─────────────────────────
  async function tick() {
    try {
      cfg = await settings.all();                      // pick up Settings-page edits without a restart
      // Per-meter gallons scale, refreshed each tick so editing one in the registry takes effect
      // without a restart. Falls back to the global setting for the owned meter.
      try {
        const reg = await meters.list();
        const next = new Map();
        reg.forEach(function (m) {
          next.set(Number(m.meter_id), m.owned ? cfg.gallons_per_unit : (m.gallons_per_unit || 1));
        });
        scales = next;
        // Only meters we are actually storing readings for can have rules run over them -- a meter
        // with packets but no hourly rows would evaluate to a flat zero every hour, which the
        // overnight rule correctly reads as "no water" and the continuous rule as "nothing running".
        observed_meters = reg.filter(function (m) { return !m.owned && m.has_readings; });
      } catch (e) { /* keep the previous map */ }
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

      // The run, computed here rather than only in the API, because the run alarm is the FAST
      // signal and the collector is the process that must be able to raise it. 500 rows covers a
      // leak at 1 gal/min for eight hours; current_run reports `truncated` if it hits the end
      // rather than pretending it knows when the run began.
      const recent = await readings.recent_readings(meter_id, 500);
      const current = rules.current_run(recent, now, cfg);

      const fired = rules.evaluate({
        hours: hours, now: now, cfg: cfg, tz: time.zone(),
        last_read_at: last ? last.at : null,
        started_at: started_at,
        run: current,
        last_alarm_run: last_alarm_run,
      });
      for (const alert of fired) {
        const r = await alerts.dispatch(alert, cfg, ctx);
        if (r.sent) log('ALERT [' + alert.kind + '] ' + alert.message + '  (' + r.note + ')');
        // Remember the run we alarmed on, so the all-clear knows WHICH run ended and does not
        // announce the end of every ordinary shower. Recorded on the attempt, not on delivery: a
        // failed send is still an alarm that happened, and re-alarming would be worse than a
        // missing all-clear.
        if (alert.kind === 'run') {
          last_alarm_run = {
            key: alert.key,
            minutes: current.minutes,
            gallons: current.gallons,
            started_at: current.started_at,
          };
        }
      }
      // The run ended and the all-clear has gone out (or was disabled) — forget it, so the next
      // run starts from a clean slate.
      if (last_alarm_run && !current.flowing) last_alarm_run = null;

      // ── observed meters: detect, record, never deliver ──────────────────────────────────────
      //
      // Same pure rules, same thresholds, run over each observed meter's own hour buckets. The
      // results are STORED so the Alerts page and the banner work for any selection, and are never
      // emailed or pushed -- `notify` is 0 for these meters unless you turn it on per meter.
      //
      // The watchdog is deliberately excluded. "Receiver silent" on a neighbour means MY antenna
      // lost THEM, not that their pipe burst. Firing it would produce a constant stream of alerts
      // about my own reception and train you to ignore the one alert that matters.
      try { await tick_observed(now); } catch (e) { /* never fatal */ }

      // Persist what the radio heard this minute BEFORE anything else in the tick can fail. This
      // is the record you go looking for when the dashboard is empty and you need to know whether
      // the radio was the problem — so it must survive a bad hour, not depend on one.
      // One row per OTHER meter for this minute, so the heartbeat chart works for any of them.
      for (const [oid, rx] of other_rx.entries()) {
        try {
          await readings.record_reception(oid, now, {
            packets_total: rx.packets,
            packets_ours: 0,
            packets: rx.packets,
            odometer: rx.odometer,
            other_ids: null,
            rssi_avg: rx.rssi_n ? rx.rssi_sum / rx.rssi_n : null,
            rssi_best: rx.rssi_best,
            snr_avg: rx.snr_n ? rx.snr_sum / rx.snr_n : null,
          });
        } catch (e) { /* bookkeeping */ }
      }
      other_rx.clear();

      await readings.record_reception(meter_id, now, {
        packets_total: rx_total,
        packets_ours: rx_ours,
        packets: rx_ours,
        // The meter reading as of this minute — this is what the heartbeat chart draws. Written
        // every minute whether or not it changed, so the line exists continuously rather than only
        // where water happened to move.
        odometer: last ? last.gallons : null,
        other_ids: Array.from(ids_seen.entries())
          .filter(function (e) { return Number(e[0]) !== Number(cfg.meter_id); })
          .sort(function (a, b) { return b[1] - a[1]; })
          .slice(0, 6)
          .map(function (e) { return e[0] + 'x' + e[1]; })
          .join(' ') || null,
        rssi_avg: rssi_n ? Number((rssi_sum / rssi_n).toFixed(2)) : null,
        rssi_best: rssi_best === null ? null : Number(rssi_best.toFixed(2)),
        snr_avg: snr_n ? Number((snr_sum / snr_n).toFixed(2)) : null,
      });
      rx_total = 0; rx_ours = 0; rssi_sum = 0; rssi_n = 0; rssi_best = null; snr_sum = 0; snr_n = 0;

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

          // Hearing packets but none of them ours is the confusing failure: everything looks
          // healthy and nothing is ever recorded. Name the ids and say so outright.
          if (pkt_ours === 0 && ids_seen.size) {
            const list = Array.from(ids_seen.entries())
              .sort(function (a, b) { return b[1] - a[1]; })
              .map(function (e) { return e[0] + ' x' + e[1]; })
              .join(', ');
            log('  NONE were meter ' + cfg.meter_id + '. Heard instead: ' + list);
            log('  The radio is fine; it cannot hear YOUR meter from here. Move the antenna toward');
            log('  the pit (extend the USB cable, not coax), or confirm the meter id on Settings.');
          }
        }
        pkt_total = 0; pkt_ours = 0; gal_since = 0; ids_seen = new Map();
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
    const old_rx = await readings.prune_reception(cfg.reception_retention_days);
    const old_pk = await readings.prune_packets(cfg.packets_retention_days);
    const old_hr = await readings.prune_hourly(cfg.hourly_retention_days);
    // Runs LAST and deliberately: it is a ceiling on other people's meters, applied after every
    // per-table rule has had its say, so it can only ever remove more -- never keep something the
    // table's own retention would have dropped.
    const old_ob = await readings.prune_observed(cfg.observed_retention_days, cfg.meter_id);
    if (raw || old_readings || old_alerts || old_rx || old_pk || old_hr || old_ob) {
      log('retention sweep: removed ' + raw + ' raw, ' + old_readings + ' readings, ' +
        old_alerts + ' alerts, ' + old_rx + ' reception rows, ' + old_pk + ' packets, ' +
        old_hr + ' hourly, ' + old_ob + ' observed-meter rows');
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

  // Best-effort, like every other diagnostic: a failure here must never touch ingest, the reception
  // row, or the leak rules. `flushing` guards against a slow INSERT overlapping the next timer and
  // writing the same batch twice.
  let flushing = false;
  async function flush_packets() {
    if (flushing || !packet_buf.length) return;
    flushing = true;
    const batch = packet_buf;
    packet_buf = [];
    try {
      await readings.record_packets(batch);
      // Register whatever we just heard. Piggy-backing on the flush rather than running its own
      // timer means the registry is updated exactly as often as there is something to register,
      // and one extra statement per flush -- not one per packet.
      const tally = new Map();
      for (const p of batch) {
        const e = tally.get(p.meter_id) || { meter_id: p.meter_id, model: p.model || null, packets: 0 };
        e.packets += 1;
        tally.set(p.meter_id, e);
      }
      await meters.record_heard(Array.from(tally.values()), meter_id);
    } catch (e) {
      console.error('packet flush failed: ' + e.message);
    } finally {
      flushing = false;
    }
  }

  // The configured meter belongs in the registry before a single packet arrives, or the selector is
  // empty for the first minute of a fresh install -- and "no meters" looks exactly like a dead
  // receiver at the moment someone is most likely to be watching.
  await meters.ensure_owned(meter_id);

  // Observed meters were captured as transmissions long before they were rolled up into hourly
  // totals, so a neighbour selected in the picker would show an empty history next to a live packet
  // feed. This rebuilds those hours from the packets still on disk. INSERT IGNORE, so it can never
  // touch an hour the live path owns and can be run on every start without double-counting.
  try {
    const reg = await meters.list();
    const scale_map = new Map();
    reg.forEach(function (m) {
      scale_map.set(Number(m.meter_id), m.owned ? cfg.gallons_per_unit : (m.gallons_per_unit || 1));
    });
    const filled = await readings.backfill_observed_hourly(meter_id, scale_map);
    if (filled) console.log('[water] backfilled ' + filled + ' observed hour(s) from stored transmissions');
  } catch (e) { /* best-effort; a backfill must never stop the collector from starting */ }

  const timer = setInterval(function () { tick(); }, TICK_MS);
  const packet_timer = setInterval(function () { flush_packets(); }, PACKET_FLUSH_MS);
  await sweep(cfg);                // once at startup, then hourly from tick()

  return {
    mode: mode,
    meter_id: meter_id,
    tick: tick,                    // exposed so tests/CLI can force a check
    sweep: sweep,                  // exposed so the CLI can force a prune
    handle_line: handle_line,
    async stop() {
      clearInterval(timer); clearInterval(packet_timer);
      try { source.stop(); } catch (e) { /* ignore */ }
      mailer.close();
      await db.end();
    },
  };
}

module.exports = { create_collector, TICK_MS, PACKET_FLUSH_MS };
