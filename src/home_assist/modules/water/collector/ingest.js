'use strict';
/**
 * ingest.js — turning an rtl_433 JSON line into a trustworthy reading.
 *
 * Pure functions, no DB, no clock. These are the parts of monitor.mjs most worth protecting with
 * tests: a 900 MHz packet that passes CRC can still be garbage, and a bad reading that advances
 * the baseline poisons every downstream number until the next restart.
 *
 * Three guards, all ported verbatim in behaviour from monitor.mjs:
 *
 *   backward   The odometer went down. Small backward steps are decode noise -> ignore the delta
 *              but re-baseline (so we do not credit a huge phantom delta on the next packet).
 *   rollover   It went down by more than rollover_guard_gal -> the counter wrapped. Re-baseline.
 *   impossible More than max_gal_per_min of flow -> physically impossible for a house supply.
 *              Reject WITHOUT advancing the baseline, so the next sane packet still measures from
 *              a real value rather than from the corrupt one.
 */

/**
 * Pull id + odometer out of an rtl_433 message, tolerant of field-name variants across decoder builds.
 *
 * This is not hypothetical tolerance. rtl_433 renamed the Badger ORION fields between builds:
 *
 *   older:  { "model":"Badger-ORION", "ID":16642655, "Flags-1":0, "Volume":794120,    "Integrity":"CRC" }
 *   newer:  { "model":"Badger-ORION", "id":16642655, "flags_1":0, "volume_gal":794120, "mic":"CRC" }
 *
 * The 2026-07-31 hose test used the older shape; the nightly build in use now emits the newer one.
 * Missing `volume_gal` meant every packet decoded correctly and was then silently discarded — the
 * meter was working, the collector was running, and nothing was ever recorded.
 *
 * UNITS: only gallon-denominated (or bare, unit-unspecified) fields are accepted. A `volume_m3` or
 * `volume_l` field is REJECTED with a reason rather than read as gallons — silently mis-scaling by
 * 264× would poison every threshold in the app, and it would look like a leak rather than a bug.
 */
const VOLUME_FIELDS = [
  'volume_gal',      // rtl_433 >= ~22.x, Badger ORION  <-- the current shape
  'Volume',          // older rtl_433 (what the hose test saw)
  'volume',
  'consumption_gal',
  'consumption',
  'Consumption',
  'reading',
  'Reading',
];

// Fields that carry a volume in units that are NOT gallons. Named so we can refuse them loudly.
const WRONG_UNIT_RE = /^(volume|consumption|reading)_(m3|m\^3|l|liters?|litres?|cf|ft3)$/i;

function as_number(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function extract_reading(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const id = msg.id !== undefined ? msg.id : (msg.ID !== undefined ? msg.ID : null);

  let raw = null;
  let field = null;
  for (const f of VOLUME_FIELDS) {
    const n = as_number(msg[f]);
    if (n !== null) { raw = n; field = f; break; }
  }

  // Nothing matched the known names — look for an unrecognised volume-ish field so a future rename
  // surfaces as a NAMED problem instead of silence. Refuse non-gallon units outright.
  if (raw === null) {
    const suspect = Object.keys(msg).find(function (k) {
      return /^(volume|consumption|reading)/i.test(k) && as_number(msg[k]) !== null;
    });
    if (suspect) {
      if (WRONG_UNIT_RE.test(suspect)) {
        return { id: id === null ? null : Number(id), raw: null, field: suspect, model: msg.model || null,
                 error: 'field "' + suspect + '" is not in gallons — set gallons_per_unit and add it to VOLUME_FIELDS' };
      }
      return { id: id === null ? null : Number(id), raw: null, field: suspect, model: msg.model || null,
               error: 'unrecognised volume field "' + suspect + '" — add it to VOLUME_FIELDS in ingest.js' };
    }
    return null;
  }

  return {
    id: id === null ? null : Number(id),
    raw: raw,
    field: field,
    model: msg.model || null,
    // `mic` (message integrity check) is the newer name for `Integrity`.
    integrity: msg.mic || msg.Integrity || msg.integrity || null,
  };
}

/**
 * Decide what to do with a reading, given the previous accepted one.
 *
 * @param prev    { gallons, at } (Date or ISO) or null/undefined for the very first reading
 * @param gallons the new odometer value, already scaled by gallons_per_unit
 * @param at      Date of this reading
 * @param cfg     settings object (max_gal_per_min, rollover_guard_gal)
 * @returns { action, delta, advance, reason }
 *            action  'baseline' | 'accept' | 'backward' | 'rollover' | 'impossible'
 *            delta   gallons to credit to the current hour (0 unless action === 'accept')
 *            advance whether to move the baseline to this reading
 */
function evaluate_reading(prev, gallons, at, cfg) {
  if (!Number.isFinite(gallons)) {
    return { action: 'impossible', delta: 0, advance: false, reason: 'non-numeric volume' };
  }
  if (!prev || prev.gallons === null || prev.gallons === undefined) {
    return { action: 'baseline', delta: 0, advance: true, reason: 'first reading' };
  }

  const prevAt = prev.at instanceof Date ? prev.at : new Date(prev.at);
  const delta = gallons - Number(prev.gallons);
  const minutes = (at.getTime() - prevAt.getTime()) / 60000;

  if (delta < 0) {
    const rollover = Math.abs(delta) > cfg.rollover_guard_gal;
    return {
      action: rollover ? 'rollover' : 'backward',
      delta: 0,
      advance: true,   // both cases re-baseline, matching monitor.mjs
      reason: rollover
        ? 'counter rollover (' + prev.gallons + ' -> ' + gallons + '); rebaselining'
        : 'backward reading (' + prev.gallons + ' -> ' + gallons + '); ignored',
    };
  }

  // Rate check, with a MINIMUM window. The meter bubbles up every few seconds, so a naive
  // delta/minutes explodes on short gaps: a legitimate +1 gal arriving 1s after the previous
  // packet computes to 60 gal/min and gets thrown away — and because a rejected reading does not
  // advance the baseline, every subsequent packet looks worse than the last and the collector goes
  // permanently deaf. Clamping the denominator asks the question we actually mean: "could this much
  // water have moved in a realistic minimum interval?"
  const window_min = Math.max(minutes, cfg.min_rate_window_min || 1);
  const rate = delta / window_min;
  if (rate > cfg.max_gal_per_min) {
    return {
      action: 'impossible',
      delta: 0,
      advance: false,  // do NOT advance — wait for a sane reading
      reason: 'implausible jump +' + delta.toFixed(0) + ' gal in ' + minutes.toFixed(2) + 'm' +
        ' (' + rate.toFixed(rate < 10 ? 2 : 0) + ' gal/min vs a ' + cfg.max_gal_per_min +
        ' limit, over a ' + window_min.toFixed(2) + 'm window)',
    };
  }

  return { action: 'accept', delta: delta, advance: true, reason: delta > 0 ? 'flow' : 'no change' };
}

/**
 * What the store should do about a verdict. Pure, so the invariant below is pinned by a test
 * rather than by a comment nobody reads.
 *
 *   insert     write a per-reading row — only worth it when gallons actually moved
 *   bump_hour  stamp the hour bucket — on EVERY trusted packet, INCLUDING zero-flow ones
 *
 * The bump_hour rule is the subtle one and it is a correctness requirement, not an optimisation.
 * An hour's row existing is the ONLY thing that marks it `observed`. If the hour is stamped only
 * when water moved, then an hour in which the collector heard the meter 900 times and nobody ran a
 * tap writes no row at all — and a perfect quiet night becomes indistinguishable from an unplugged
 * dongle, on the chart and to check_continuous / check_overnight alike.
 *
 * On a leak monitor "no data" and "zero" mean opposite things. Row present + 0 gallons = we were
 * listening and nothing moved. No row = we were not listening. Do not collapse them.
 */
function reading_effects(verdict) {
  const trusted = !!(verdict && verdict.advance);
  return {
    insert: trusted && Number(verdict.delta) > 0,
    bump_hour: trusted,
    advance: trusted,
  };
}

/**
 * Does this message belong to our meter? An id of null means the decoder did not report one, which
 * we accept (single-protocol capture); any other id must match.
 */
function is_our_meter(reading, meter_id) {
  if (!reading) return false;
  if (reading.id === null || reading.id === undefined) return true;
  return Number(reading.id) === Number(meter_id);
}

module.exports = { extract_reading, evaluate_reading, reading_effects, is_our_meter };
