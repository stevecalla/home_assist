'use strict';
/**
 * meters.js — the registry of every meter this receiver has ever heard.
 *
 * WHY A TABLE RATHER THAN A QUERY. `water_packets` already knows which meters exist, and for a
 * while that looked like enough. It is not: packets are pruned within a day by design, so a meter
 * that went quiet this morning disappears from any list derived from them. A selector whose options
 * come and go is worse than no selector — "it was there yesterday" reads as a bug in the app rather
 * than as reception.
 *
 * The registry also gives three things a query cannot: a stable LABEL, the OWNED flag that decides
 * which meter the leak rules run for, and the per-meter GALLONS SCALE. That last one is not
 * cosmetic — a Badger classic endpoint counts 1 gallon per tick and a newer one counts 0.1, so
 * applying the wrong factor is a silent 10x error that looks entirely plausible on a chart.
 *
 * Rows appear on their own. Nothing here asks a human to register anything.
 */
const db = require('../../../store/db');
const time = require('../../../time');

/**
 * Record that these meters were heard, in one statement.
 *
 * Called from the packet flush, so it runs every few seconds on the process that must never fall
 * behind the radio — hence one multi-row upsert rather than a query per meter.
 *
 * `first_heard_*` is deliberately absent from the UPDATE clause: a meter heard ten thousand times
 * was still first heard once, and that is the question the column exists to answer. Same reasoning
 * as `created_at_*` in water_settings.
 */
async function record_heard(seen, owned_meter_id) {
  const rows = Array.isArray(seen) ? seen : [];
  if (!rows.length) return 0;
  const n = time.stamps(new Date());
  const owned = Number(owned_meter_id) || 0;

  const values = [];
  const params = [];
  for (const r of rows) {
    const id = Number(r.meter_id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    values.push('(?,?,?,?,?,?,?,?,?,?)');
    params.push(
      id,
      r.model ? String(r.model).slice(0, 32) : null,
      id === owned ? 1 : 0,
      id === owned ? 1 : 0,          // collect_readings: ours by default, observed off
      n.utc, n.local, n.utc, n.local,
      Math.max(1, Number(r.packets) || 1),
      n.local
    );
  }
  if (!values.length) return 0;

  try {
    const r = await db.query(
      'INSERT INTO water_meters ' +
      '(meter_id, model, owned, collect_readings, first_heard_utc, first_heard_mtn, ' +
      ' last_heard_utc, last_heard_mtn, packets_seen, created_at_mtn) ' +
      'VALUES ' + values.join(',') + ' ' +
      'ON DUPLICATE KEY UPDATE ' +
      '  model = COALESCE(VALUES(model), model), ' +
      '  last_heard_utc = VALUES(last_heard_utc), ' +
      '  last_heard_mtn = VALUES(last_heard_mtn), ' +
      '  packets_seen = packets_seen + VALUES(packets_seen)',
      params
    );
    return r && r.affectedRows ? r.affectedRows : 0;
  } catch (e) {
    return 0;                        // the registry is bookkeeping; it never breaks ingest
  }
}

/**
 * Every known meter, ours first and then by how well we hear it.
 *
 * `has_packets` / `has_readings` are computed rather than stored, because a stored flag would be
 * wrong the moment retention deleted the last row it referred to. The selector uses them to grey
 * out a meter instead of offering a choice that produces an empty chart — an empty chart is
 * indistinguishable from a broken one.
 */
async function list() {
  const rows = await db.query(
    'SELECT m.meter_id, m.label, m.model, m.owned, m.collect_readings, m.gallons_per_unit, m.notify, ' +
    '       m.first_heard_utc, m.first_heard_mtn, m.last_heard_utc, m.last_heard_mtn, m.packets_seen, ' +
    '       EXISTS(SELECT 1 FROM water_packets p WHERE p.meter_id = m.meter_id) AS has_packets, ' +
    '       EXISTS(SELECT 1 FROM water_hourly  h WHERE h.meter_id = m.meter_id) AS has_readings ' +
    'FROM water_meters m ' +
    'ORDER BY m.owned DESC, m.packets_seen DESC, m.meter_id'
  );
  return rows.map(function (r) {
    return {
      meter_id: Number(r.meter_id),
      label: r.label || null,
      model: r.model || null,
      owned: !!r.owned,
      collect_readings: !!r.collect_readings,
      // Whether this meter's alerts are DELIVERED. Detection is unconditional; delivery is
      // opt-in and off for neighbours, so a stranger's shower can never wake you at 3am.
      notify: !!r.notify,
      gallons_per_unit: Number(r.gallons_per_unit),
      first_heard_mtn: r.first_heard_mtn || null,
      last_heard_mtn: r.last_heard_mtn || null,
      last_heard_utc: r.last_heard_utc || null,
      packets_seen: Number(r.packets_seen || 0),
      has_packets: !!Number(r.has_packets),
      has_readings: !!Number(r.has_readings),
    };
  });
}

/**
 * Make sure the configured meter is in the registry and marked owned, even before a single packet
 * arrives. Without this the selector is empty on a fresh install until the radio decodes something,
 * and "no meters" during the first minute looks identical to a broken receiver.
 */
async function ensure_owned(meter_id) {
  const id = Number(meter_id) || 0;
  if (!id) return;
  const n = time.stamps(new Date());
  try {
    await db.query(
      // No auto-label. "My meter" beside a "mine" badge said the same thing twice and pushed the
      // id -- the thing you actually search the table by -- out of view. A label is for a name a
      // human chose, not for a synonym of a flag.
      // notify = 1 here and nowhere else: YOUR meter is the one that may wake you, and that has to
      // be true from the first boot rather than something you remember to switch on. Neighbours
      // default to 0 from the column default and stay there unless deliberately changed.
      'INSERT INTO water_meters (meter_id, owned, collect_readings, notify, label, created_at_mtn) ' +
      'VALUES (?,1,1,1,?,?) ' +
      'ON DUPLICATE KEY UPDATE owned = 1, collect_readings = 1, notify = 1, label = NULL',
      [id, null, n.local]
    );
  } catch (e) { /* best-effort */ }
}

module.exports = { record_heard, list, ensure_owned };
