'use strict';
/**
 * readings.js — writing and reading meter data.
 *
 * Write path (collector): insert_reading + bump_hour + save_state, all stamped in Node.
 * Read path (API): the hour-bucket map the leak rules want, plus the series the charts want.
 */
const db = require('../../../store/db');
const time = require('../../../time');

// ───────────────────────────── write path ─────────────────────────────

// `created_at_*` is when the ROW was written; the event columns are when the THING happened. Today
// they are the same instant, and they stop being the same instant the first time anything is
// replayed, backfilled, or imported — which is exactly when you need to tell them apart.
function now_stamps() { return time.stamps(new Date()); }

async function insert_reading(meter_id, at, gallons, delta) {
  const s = time.stamps(at);
  const n = now_stamps();
  await db.query(
    'INSERT INTO water_readings (meter_id, read_at_utc, read_at_mtn, gallons, delta_gallons, created_at_mtn, created_at_utc) ' +
    'VALUES (?,?,?,?,?,?,?)',
    [meter_id, s.utc, s.local, gallons, delta, n.local, n.utc]
  );
}

// Credit `delta` gallons to the local hour that `at` falls in. UPSERT so restarts and out-of-order
// packets both land correctly.
//
// created_at_* is deliberately absent from the ON DUPLICATE clause: it records when the hour bucket
// was FIRST opened, and an hour that has been bumped 900 times was still created once.
async function bump_hour(meter_id, at, delta) {
  const key = time.hour_key(at);
  const n = now_stamps();
  await db.query(
    'INSERT INTO water_hourly (meter_id, hour_key, hour_start_mtn, gallons, reading_count, updated_at_utc, updated_at_mtn, created_at_mtn, created_at_utc) ' +
    'VALUES (?,?,?,?,1,?,?,?,?) ' +
    'ON DUPLICATE KEY UPDATE gallons = gallons + VALUES(gallons), ' +
    'reading_count = reading_count + 1, updated_at_utc = VALUES(updated_at_utc), ' +
    'updated_at_mtn = VALUES(updated_at_mtn)',
    [meter_id, key, time.hour_start_sql(key), delta, time.sql_utc(at), time.sql_local(at), n.local, n.utc]
  );
  return key;
}

// The collector's liveness + last-reading record. Written on every accepted reading AND on every
// tick even when nothing was received — that is what makes "receiver silent" detectable.
async function save_state(meter_id, patch) {
  const n = now_stamps();
  const now = n.utc;
  await db.query(
    'INSERT INTO water_collector_state (meter_id, last_gallons, last_read_at_utc, last_heartbeat_utc, radio_quiet, collector_mode, started_at_utc, created_at_mtn, created_at_utc) ' +
    'VALUES (?,?,?,?,?,?,?,?,?) ' +
    'ON DUPLICATE KEY UPDATE ' +
    '  last_gallons       = COALESCE(VALUES(last_gallons), last_gallons), ' +
    '  last_read_at_utc   = COALESCE(VALUES(last_read_at_utc), last_read_at_utc), ' +
    '  last_heartbeat_utc = COALESCE(VALUES(last_heartbeat_utc), last_heartbeat_utc), ' +
    '  radio_quiet        = VALUES(radio_quiet), ' +
    '  collector_mode     = COALESCE(VALUES(collector_mode), collector_mode), ' +
    '  started_at_utc     = COALESCE(VALUES(started_at_utc), started_at_utc)',
    [
      meter_id,
      patch.last_gallons === undefined ? null : patch.last_gallons,
      patch.last_read_at === undefined || patch.last_read_at === null ? null : time.sql_utc(patch.last_read_at),
      patch.heartbeat === false ? null : now,
      patch.radio_quiet ? 1 : 0,
      patch.collector_mode || null,
      patch.started_at ? time.sql_utc(patch.started_at) : null,
      n.local,
      n.utc,
    ]
  );
}

async function get_state(meter_id) {
  const rows = await db.query(
    'SELECT meter_id, last_gallons, last_read_at_utc, last_heartbeat_utc, radio_quiet, collector_mode, started_at_utc ' +
    'FROM water_collector_state WHERE meter_id = ?',
    [meter_id]
  );
  return rows[0] || null;
}

/**
 * One row per minute saying what the radio actually heard.
 *
 * This is the table that answers "is it hearing my meter RIGHT NOW?" — the question
 * water_raw_samples cannot answer, because that one stops after a fixed number of packets per run
 * by design and then looks identical to a dead radio.
 *
 * UPSERT on (meter_id, minute) so a tick that straddles a minute boundary tops up the row it
 * belongs to rather than losing the count.
 */
async function record_reception(meter_id, at, stats) {
  const minute = new Date(Math.floor(at.getTime() / 60000) * 60000);
  const s = time.stamps(minute);
  const n = now_stamps();
  try {
    await db.query(
      'INSERT INTO water_reception (meter_id, minute_utc, minute_mtn, packets_total, packets_ours, ' +
      'odometer, other_ids, rssi_avg, rssi_best, snr_avg, created_at_mtn, created_at_utc) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ' +
      'ON DUPLICATE KEY UPDATE packets_total = packets_total + VALUES(packets_total), ' +
      'packets_ours = packets_ours + VALUES(packets_ours), other_ids = VALUES(other_ids), ' +
      // odometer is the LATEST value in the minute, not a sum — it is a running total already.
      'odometer = COALESCE(VALUES(odometer), odometer), ' +
      'rssi_avg = VALUES(rssi_avg), rssi_best = VALUES(rssi_best), snr_avg = VALUES(snr_avg)',
      [
        meter_id, s.utc, s.local,
        stats.packets_total || 0, stats.packets_ours || 0,
        stats.odometer === null || stats.odometer === undefined ? null : stats.odometer,
        stats.other_ids ? String(stats.other_ids).slice(0, 250) : null,
        stats.rssi_avg === null || stats.rssi_avg === undefined ? null : stats.rssi_avg,
        stats.rssi_best === null || stats.rssi_best === undefined ? null : stats.rssi_best,
        stats.snr_avg === null || stats.snr_avg === undefined ? null : stats.snr_avg,
        n.local, n.utc,
      ]
    );
  } catch (e) { /* diagnostics must never break ingest */ }
}

/** The last N minutes of reception, oldest first — what the Diagnostics chart draws. */
async function reception_series(meter_id, minutes) {
  // 4320 = 72 hours, the same ceiling /api/water/meter enforces on the heartbeat window. A lower cap
  // here would silently truncate a 72h request to 24h and the chart would draw a confident, wrong
  // axis — the range chip would say 72h and the picture would be a day.
  const n = Math.max(1, Math.min(Number(minutes) || 60, 4320));
  const rows = await db.query(
    'SELECT minute_utc, minute_mtn, packets_total, packets_ours, odometer, other_ids, rssi_avg, rssi_best, snr_avg ' +
    'FROM water_reception WHERE meter_id = ? AND minute_utc >= (UTC_TIMESTAMP() - INTERVAL ? MINUTE) ' +
    'ORDER BY minute_utc',
    [meter_id, n]
  );
  return rows;
}

/** Daily totals over an explicit day range, grouped in SQL so the browser gets one row per DAY. */
async function daily_series_range(meter_id, days) {
  const n = Math.max(1, Math.min(Number(days) || 30, 400));
  const first = time.day_key_offset(new Date(), n - 1);
  const rows = await db.query(
    'SELECT LEFT(hour_key, 10) AS day_key, SUM(gallons) AS gallons, SUM(reading_count) AS readings ' +
    'FROM water_hourly WHERE meter_id = ? AND hour_key >= ? GROUP BY day_key ORDER BY day_key',
    [meter_id, first + 'T00']
  );
  const by = {};
  rows.forEach(function (r) { by[r.day_key] = { gallons: Number(r.gallons), readings: Number(r.readings) }; });
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const k = time.day_key_offset(new Date(), i);
    const hit = by[k];
    out.push({ day_key: k, gallons: hit ? hit.gallons : 0, readings: hit ? hit.readings : 0, observed: !!hit });
  }
  return out;
}

/**
 * Bulk-insert a tick's worth of decoded transmissions.
 *
 * ONE statement per tick, not one per packet. At ~15 packets a minute a per-packet round trip is
 * 15 needless network hops a minute forever, on the process that must never fall behind the radio.
 *
 * INSERT IGNORE, because the primary key is (meter_id, heard_at_utc): if two packets from the same
 * meter land inside the same millisecond, the second is a duplicate of a physical impossibility and
 * dropping it is more honest than inventing a distinct key for it.
 */
async function record_packets(rows) {
  if (!rows || !rows.length) return 0;
  const n = now_stamps();
  const values = rows.map(function (r) {
    return [
      r.meter_id, r.heard_at_utc, r.heard_at_mtn, r.is_ours ? 1 : 0,
      r.volume === undefined ? null : r.volume,
      r.delta === undefined ? null : r.delta,
      r.flags_1 === undefined ? null : r.flags_1,
      r.flags_2 === undefined ? null : r.flags_2,
      r.integrity === undefined ? null : r.integrity,
      r.rssi === undefined ? null : r.rssi,
      r.snr === undefined ? null : r.snr,
      r.noise === undefined ? null : r.noise,
      r.freq_mhz === undefined ? null : r.freq_mhz,
      n.local, n.utc,
    ];
  });
  const res = await db.query(
    'INSERT IGNORE INTO water_packets ' +
    '(meter_id, heard_at_utc, heard_at_mtn, is_ours, volume, delta, flags_1, flags_2, integrity, ' +
    ' rssi, snr, noise, freq_mhz, created_at_mtn, created_at_utc) VALUES ?',
    [values]
  );
  return res && res.affectedRows ? res.affectedRows : 0;
}

/**
 * The Real time window. `scope` is 'mine' or 'all' — a DISPLAY filter; capture is decided by the
 * packets_capture_all_meters setting, not here.
 *
 * Returned newest-first from SQL (so LIMIT keeps the RECENT rows, not the oldest ones) and then
 * reversed, because every chart in this app reads left-to-right in time.
 */
async function packet_series(meter_id, hours, scope, limit) {
  const h = Math.max(0.05, Math.min(Number(hours) || 1, 168));
  const cap = Math.max(1, Math.min(Number(limit) || 5000, 20000));
  const where = scope === 'all' ? '' : ' AND meter_id = ' + Number(meter_id);
  const rows = await db.query(
    'SELECT meter_id, heard_at_utc, heard_at_mtn, is_ours, volume, delta, flags_1, flags_2, ' +
    '       integrity, rssi, snr, noise, freq_mhz ' +
    'FROM water_packets ' +
    'WHERE heard_at_utc >= (UTC_TIMESTAMP() - INTERVAL ? SECOND)' + where + ' ' +
    'ORDER BY heard_at_utc DESC LIMIT ' + cap,
    [Math.round(h * 3600)]
  );
  return rows.reverse();
}

/**
 * How many rows are ACTUALLY in the window, before the fetch limit.
 *
 * Needed for two separate reasons, and the second one is the important one:
 *   - so the table can say "showing 6,000 of 20,571" instead of "6,000 rows"
 *   - so the DECODE RATE is computed against reality. Counting the returned array instead means a
 *     truncated 24-hour window reports 6,000 heard against 20,571 expected -- 29%, which reads as a
 *     failing antenna when the only thing that failed is a LIMIT clause.
 */
async function packet_count(meter_id, hours, scope) {
  const h = Math.max(0.05, Math.min(Number(hours) || 1, 168));
  const where = scope === 'all' ? '' : ' AND meter_id = ' + Number(meter_id);
  const rows = await db.query(
    'SELECT COUNT(*) AS total, SUM(is_ours) AS ours FROM water_packets ' +
    'WHERE heard_at_utc >= (UTC_TIMESTAMP() - INTERVAL ? SECOND)' + where,
    [Math.round(h * 3600)]
  );
  const r = rows[0] || {};
  return { total: Number(r.total || 0), ours: Number(r.ours || 0) };
}

/** Who else is out there, and how well we hear them. The antenna scoreboard. */
async function meters_heard(hours) {
  const h = Math.max(0.05, Math.min(Number(hours) || 1, 168));
  return db.query(
    'SELECT meter_id, COUNT(*) AS packets, MAX(is_ours) AS is_ours, ' +
    '       AVG(rssi) AS rssi_avg, AVG(snr) AS snr_avg, ' +
    '       MIN(heard_at_mtn) AS first_seen, MAX(heard_at_mtn) AS last_seen ' +
    'FROM water_packets WHERE heard_at_utc >= (UTC_TIMESTAMP() - INTERVAL ? SECOND) ' +
    'GROUP BY meter_id ORDER BY packets DESC',
    [Math.round(h * 3600)]
  );
}

async function prune_packets(days) {
  const d = Number(days) || 0;
  if (d <= 0) return 0;
  try {
    const cutoff = time.sql_utc(new Date(Date.now() - d * 86400 * 1000));
    const r = await db.query('DELETE FROM water_packets WHERE heard_at_utc < ? LIMIT 50000', [cutoff]);
    return r && r.affectedRows ? r.affectedRows : 0;
  } catch (e) { return 0; }
}

async function prune_reception(days) {
  const d = Number(days) || 0;
  if (d <= 0) return 0;
  try {
    const cutoff = time.sql_utc(new Date(Date.now() - d * 86400 * 1000));
    const r = await db.query('DELETE FROM water_reception WHERE minute_utc < ? LIMIT 50000', [cutoff]);
    return r && r.affectedRows ? r.affectedRows : 0;
  } catch (e) { return 0; }
}

async function log_raw(reason, line) {
  try {
    const n = now_stamps();
    await db.query(
      'INSERT INTO water_raw_samples (seen_at_utc, seen_at_mtn, reason, line, created_at_mtn, created_at_utc) VALUES (?,?,?,?,?,?)',
      [n.utc, n.local, reason, String(line).slice(0, 4000), n.local, n.utc]);
  } catch (e) { /* diagnostics must never break ingest */ }
}

// Keep water_raw_samples from growing without bound — it exists for the first-run "what are the
// field names" question and for diagnosing a bad night, not as a permanent archive.
async function prune_raw(keep) {
  try {
    const n = Math.max(0, Number(keep) || 0);
    const rows = await db.query(
      'SELECT id FROM water_raw_samples ORDER BY id DESC LIMIT 1 OFFSET ?',
      [n]
    );
    if (!rows.length) return 0;                       // fewer than `keep` rows — nothing to do
    const cutoff = rows[0].id;
    const r = await db.query('DELETE FROM water_raw_samples WHERE id <= ?', [cutoff]);
    return r && r.affectedRows ? r.affectedRows : 0;
  } catch (e) { return 0; }                            // best-effort; never breaks the collector
}

/**
 * Retention for the per-reading detail. Off by default (0 = keep everything), because the volume is
 * genuinely small: one row per gallon used, so a normal household is ~70k rows and ~10 MB a YEAR.
 * The hourly rollup — which is what every chart and every leak rule reads — is 8,760 rows a year and
 * is never pruned, so trimming readings costs you the Diagnostics detail and nothing else.
 */
async function prune_readings(days) {
  const d = Number(days) || 0;
  if (d <= 0) return 0;
  try {
    const cutoff = time.sql_utc(new Date(Date.now() - d * 86400 * 1000));
    const r = await db.query('DELETE FROM water_readings WHERE read_at_utc < ? LIMIT 50000', [cutoff]);
    return r && r.affectedRows ? r.affectedRows : 0;
  } catch (e) { return 0; }
}

/** Same idea for alert history — 0 keeps everything (a few hundred rows a year). */
async function prune_alerts(days) {
  const d = Number(days) || 0;
  if (d <= 0) return 0;
  try {
    const cutoff = time.sql_utc(new Date(Date.now() - d * 86400 * 1000));
    const r = await db.query('DELETE FROM water_alerts WHERE fired_at_utc < ?', [cutoff]);
    return r && r.affectedRows ? r.affectedRows : 0;
  } catch (e) { return 0; }
}

/** Row counts + on-disk size per water table, for `report.js dbsize` and the Diagnostics page. */
async function table_sizes() {
  const rows = await db.query(
    "SELECT table_name AS name, table_rows AS approx_rows, " +
    "ROUND((data_length + index_length) / 1024 / 1024, 2) AS mb " +
    "FROM information_schema.tables " +
    "WHERE table_schema = DATABASE() AND table_name LIKE 'water\\_%' ORDER BY (data_length + index_length) DESC"
  );
  return rows;
}

// ───────────────────────────── read path ──────────────────────────────

/**
 * The hour-bucket map the leak rules take: { 'YYYY-MM-DDTHH': gallons }.
 * Pulls a generous window (default 72h) so overnight + continuous + the daily summary all have
 * what they need from one query.
 */
async function hour_map(meter_id, back_hours) {
  const hours = Math.max(1, Number(back_hours) || 72);
  // hour_key is a zero-padded, lexicographically-sortable local timestamp, so a string >= compare
  // is the whole range filter.
  const first = time.hour_key_offset(new Date(), hours - 1);
  const rows = await db.query(
    'SELECT hour_key, gallons FROM water_hourly WHERE meter_id = ? AND hour_key >= ? ORDER BY hour_key',
    [meter_id, first]
  );
  const out = {};
  rows.forEach(function (r) { out[r.hour_key] = Number(r.gallons); });
  return out;
}

/**
 * Hourly series for the chart — one entry per hour for the last N hours, INCLUDING zero-filled
 * hours. A gap and a zero look different on the chart for a reason: gaps mean we were not
 * listening, zeros mean no water moved.
 */
async function hourly_series(meter_id, back_hours) {
  const count = Math.max(1, Math.min(Number(back_hours) || 48, 24 * 60));
  const keys = time.recent_hour_keys(new Date(), count);
  const rows = await db.query(
    'SELECT hour_key, gallons, reading_count FROM water_hourly WHERE meter_id = ? AND hour_key >= ? ORDER BY hour_key',
    [meter_id, keys[0]]
  );
  const byKey = {};
  rows.forEach(function (r) { byKey[r.hour_key] = { gallons: Number(r.gallons), readings: Number(r.reading_count) }; });
  return keys.map(function (k) {
    const hit = byKey[k];
    return {
      hour_key: k,
      hour: Number(k.slice(11, 13)),
      gallons: hit ? hit.gallons : 0,
      readings: hit ? hit.readings : 0,
      observed: !!hit,
    };
  });
}

/**
 * Daily totals for the last N local days, newest last, zero-filled.
 */
async function daily_series(meter_id, back_days) {
  const days = Math.max(1, Math.min(Number(back_days) || 30, 400));
  const first = time.day_key_offset(new Date(), days - 1);
  const rows = await db.query(
    'SELECT LEFT(hour_key, 10) AS day_key, SUM(gallons) AS gallons, SUM(reading_count) AS readings ' +
    'FROM water_hourly WHERE meter_id = ? AND hour_key >= ? GROUP BY LEFT(hour_key, 10) ORDER BY day_key',
    [meter_id, first + 'T00']
  );
  const byDay = {};
  rows.forEach(function (r) { byDay[r.day_key] = { gallons: Number(r.gallons), readings: Number(r.readings) }; });
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = time.day_key_offset(new Date(), i);
    const hit = byDay[k];
    out.push({ day_key: k, gallons: hit ? hit.gallons : 0, readings: hit ? hit.readings : 0, observed: !!hit });
  }
  return out;
}

// Sum of a set of hour keys straight from SQL (used for the tiles).
async function sum_for_hours(meter_id, keys) {
  if (!keys.length) return 0;
  const placeholders = keys.map(function () { return '?'; }).join(',');
  const rows = await db.query(
    'SELECT COALESCE(SUM(gallons),0) AS total FROM water_hourly WHERE meter_id = ? AND hour_key IN (' + placeholders + ')',
    [meter_id].concat(keys)
  );
  return Number(rows[0] ? rows[0].total : 0);
}

async function recent_readings(meter_id, limit) {
  return db.query(
    'SELECT read_at_utc, read_at_mtn, gallons, delta_gallons FROM water_readings ' +
    'WHERE meter_id = ? ORDER BY id DESC LIMIT ?',
    [meter_id, Math.max(1, Math.min(Number(limit) || 25, 500))]
  );
}

module.exports = {
  insert_reading, bump_hour, save_state, get_state, log_raw,
  prune_raw, prune_readings, prune_alerts, table_sizes,
  record_reception, reception_series, prune_reception, daily_series_range,
  record_packets, packet_series, packet_count, meters_heard, prune_packets,
  hour_map, hourly_series, daily_series, sum_for_hours, recent_readings,
};
