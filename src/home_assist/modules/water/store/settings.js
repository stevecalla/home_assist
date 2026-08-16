'use strict';
/**
 * settings.js — the water module's tunables.
 *
 * These were `const`s at the top of monitor.mjs. They live in the water_settings table now so the
 * Settings page can change them without a redeploy — which matters most for
 * OVERNIGHT_THRESHOLD_GAL, the one number you can only tune after watching a week of clean nights
 * (an ice maker, a water softener regen, and a recirc pump all draw water overnight and none of
 * them is a leak).
 *
 * Resolution order: water_settings row -> .env -> the built-in default below.
 * Values are cached for CACHE_MS so the collector's per-minute tick and the UI's 5s poll don't
 * hammer MySQL; any write busts the cache immediately.
 */
const db = require('../../../store/db');
const time = require('../../../time');

// name -> { type, def, env, label, help, group, min, max }
const DEFS = {
  meter_name: {
    type: 'string', def: 'Main house meter', group: 'Meter',
    label: 'Meter name',
    help: 'What to call this meter in the UI. The radio id is a number nobody remembers; a name is ' +
      'what makes a second meter (irrigation, a rental) legible when one gets added.',
  },

  meter_id: {
    type: 'int', def: 16642655, env: 'WATER_METER_ID', group: 'Meter',
    label: 'Meter radio id',
    help: 'The rtl_433 "id" field for your Badger Orion. NOT the serial printed on the endpoint.',
  },
  gallons_per_unit: {
    type: 'float', def: 1, env: 'WATER_GALLONS_PER_UNIT', group: 'Meter', min: 0.001,
    label: 'Gallons per count',
    help: 'Confirmed 1:1 by hose test 2026-07-31 (7 counts for ~7 gal). Re-check against the dial.',
  },

  overnight_start_hour: {
    type: 'int', def: 2, group: 'Overnight', min: 0, max: 23,
    label: 'Overnight window starts (hour)',
    help: 'Local hour, inclusive.',
  },
  overnight_end_hour: {
    type: 'int', def: 5, group: 'Overnight', min: 1, max: 24,
    label: 'Overnight window ends (hour)',
    help: 'Local hour, exclusive. The check runs once the window has passed.',
  },
  overnight_threshold_gal: {
    type: 'float', def: 3, group: 'Overnight', min: 0,
    label: 'Overnight alert threshold (gal)',
    help: 'Alert if more than this ran during the window. Tune after ~a week of clean nights.',
  },

  continuous_hours: {
    type: 'int', def: 6, group: 'Continuous flow', min: 2, max: 24,
    label: 'Continuous flow window (hours)',
    help: 'Water in EVERY one of this many consecutive hours means something is running.',
  },
  continuous_min_gal_per_hour: {
    type: 'float', def: 1, group: 'Continuous flow', min: 0,
    label: 'Minimum gal/hour to count as flow',
    help: 'An hour below this counts as "no flow" and resets the streak.',
  },

  run_gap_min: {
    type: 'int', def: 5, group: 'Continuous flow', min: 1, max: 60,
    label: 'Idle gap that ends a run (minutes)',
    help: 'No water for this long means the current run is over. Keep it generous: the meter ' +
      'counts whole gallons, so a slow leak at 0.4 gal/min only reports every ~2.5 minutes, and ' +
      'too small a gap would split one real leak into a series of innocent-looking short runs.',
  },
  run_warn_min: {
    type: 'int', def: 30, group: 'Continuous flow', min: 5, max: 240,
    label: 'Run length that looks unusual (minutes)',
    help: 'Longer than a shower or a dishwasher cycle. Shown on the Monitor as "running a long ' +
      'time" — a heads-up, not an alert.',
  },
  run_alarm_min: {
    type: 'int', def: 60, group: 'Continuous flow', min: 10, max: 1440,
    label: 'Run length that means something is stuck (minutes)',
    help: 'An hour of unbroken flow is not a fixture. Shown as CONTINUOUS on the Monitor. The ' +
      'emailed alert still comes from the ' + 'hourly rule, which needs a longer streak to be sure.',
  },

  stale_minutes: {
    type: 'int', def: 90, group: 'Receiver', min: 5,
    label: 'Receiver silence alert (minutes)',
    help: 'No readings for this long means the receiver died. Silence is NOT the same as no leak.',
  },

  daily_summary_hour: {
    type: 'int', def: 8, group: 'Daily summary', min: -1, max: 23,
    label: 'Daily summary hour',
    help: 'Local hour for the "still alive, here is yesterday" push. Set to -1 to disable.',
  },

  max_gal_per_min: {
    type: 'float', def: 30, group: 'Sanity filters', min: 1,
    label: 'Max plausible gal/minute',
    help: 'Readings implying more than this are treated as corrupt and ignored.',
  },
  min_rate_window_min: {
    type: 'float', def: 1, group: 'Sanity filters', min: 0.05,
    label: 'Minimum window for the rate check (min)',
    help: 'The meter broadcasts every few seconds. Without a floor, a legitimate +1 gal one second ' +
      'after the last packet computes to 60 gal/min and gets rejected — permanently, since a ' +
      'rejected reading does not advance the baseline. 1 minute is a safe floor.',
  },
  rollover_guard_gal: {
    type: 'float', def: 100000, group: 'Sanity filters', min: 1,
    label: 'Counter rollover guard (gal)',
    help: 'A backward jump larger than this is a counter rollover, so we rebaseline instead of ignoring.',
  },

  raw_sample_keep: {
    type: 'int', def: 500, group: 'Retention', min: 0,
    label: 'Raw decoder lines to keep',
    help: 'water_raw_samples is a diagnostic buffer, not an archive. Trimmed to this on an hourly ' +
      'sweep. The rejected-packet logger is separately rate-limited, so a radio producing garbage ' +
      'continuously cannot fill the disk with the diagnostics for its own failure.',
  },
  readings_retention_days: {
    type: 'int', def: 0, group: 'Retention', min: 0,
    label: 'Keep per-reading detail for (days)',
    help: '0 = forever. One row per gallon used, so a normal household is ~70k rows and ~10 MB per ' +
      'YEAR — there is rarely a reason to trim. The hourly rollup that every chart and leak rule ' +
      'reads is never pruned, so trimming this costs you Diagnostics detail and nothing else.',
  },
  run_alarm_gal: {
    type: 'int', def: 100, group: 'Continuous flow', min: 0, max: 5000,
    label: 'Run volume that means something burst (gallons)',
    help: 'Emails as soon as ONE unbroken run passes this, however short. Duration alone misses a burst supply line -- that delivers 40-60 gal in ten minutes and the 60-minute rule would sit silent while a basement fills. A full tub is ~50 gal and a shower ~20, so 100 clears every normal draw. 0 turns the volume trigger off and leaves only the minutes one.',
  },
  run_alert_email: {
    type: 'bool', def: 1, group: 'Continuous flow',
    label: 'Email on a continuous run',
    help: 'Off = the run meter still shows on the Monitor but never emails, which is how this behaved before. The hourly continuous rule is unaffected -- but that one needs six hours to speak, so turning this off restores a six-hour blind spot on a daytime leak.',
  },
  run_alert_all_clear: {
    type: 'bool', def: 1, group: 'Continuous flow',
    label: 'Email when the run stops',
    help: 'A follow-up saying how long it ran and how many gallons. An alarm followed by silence is ambiguous -- you cannot tell "it stopped" from "the monitor died". Informational, so it does not wake you. Only ever sent for a run that actually alarmed.',
  },
  packets_enabled: {
    type: 'bool', def: 1, group: 'Data',
    label: 'Record every transmission',
    help: 'Writes one row per decoded packet to water_packets -- the Real time tab. Off = the tab hides and nothing is written.',
  },
  packets_capture_all_meters: {
    type: 'bool', def: 1, group: 'Data',
    label: 'Include neighbouring meters',
    help: 'Neighbours are captured for antenna comparison only. They never advance your odometer, enter a rule, or raise an alert. Off = only your meter is stored.',
  },
  packets_retention_days: {
    type: 'int', def: 1, group: 'Data', min: 1, max: 7,
    label: 'Keep transmissions for (days)',
    help: 'About 2 MB per day for your meter alone, or 6 MB with two neighbours in range. Pruned hourly, so the size is set by this number and not by usage.',
  },
  hourly_retention_days: {
    type: 'int', def: 0, group: 'Retention', min: 0, min_nonzero: 7,
    label: 'Keep the hourly rollup for (days)',
    help: '0 = forever, and forever is cheap: 8,760 rows and about 1 MB per meter per YEAR. This ' +
      'is the table every chart and every leak rule reads, so it is the one place where trimming ' +
      'costs capability rather than disk. A value below 7 is refused -- the continuous-flow rule ' +
      'needs six hours, the overnight rule needs last night, and the daily summary needs ' +
      'yesterday, so a short retention here would silently stop the monitor detecting the leaks ' +
      'it exists to detect. Long view ranges beyond this simply run out of data.',
  },
  observed_retention_days: {
    type: 'int', def: 45, group: 'Retention', min: 1, max: 3650,
    label: 'Keep OTHER meters\' history for (days)',
    help: 'A CEILING on every table, applied only to meters that are not yours. It can shorten ' +
      'but never extend -- transmissions still expire at their own 1-day setting. Your meter is ' +
      'unaffected. This exists because the hourly rollup is otherwise permanent, and a permanent ' +
      'record of when the neighbours shower, sleep and travel is a different thing from the ' +
      'antenna diagnostics the capture was added for. Bounded by a setting rather than by ' +
      'intention.',
  },
  reception_retention_days: {
    type: 'int', def: 14, group: 'Retention', min: 0,
    label: 'Keep the reception log for (days)',
    help: '0 = forever. One row per minute (1,440/day, ~10 MB a year). This is the persistent ' +
      'record of what the radio heard, so keep enough to cover "was it working last Tuesday?".',
  },
  alerts_retention_days: {
    type: 'int', def: 0, group: 'Retention', min: 0,
    label: 'Keep alert history for (days)',
    help: '0 = forever. A few hundred rows a year. Note this table is also the cooldown ledger, so ' +
      'never set it below the longest cooldown (24h).',
  },

  alert_email_enabled: {
    type: 'int', def: 1, group: 'Alerts — email', min: 0, max: 1,
    label: 'Send email alerts',
    help: '1 = on. Uses EMAIL_SENDER / EMAIL_PASSWORD (Gmail app password) from .env.',
  },
  alert_email_to: {
    type: 'string', def: '', env: 'EMAIL_RECIPIENT', group: 'Alerts — email',
    label: 'Send alerts to',
    help: 'Leave blank to use EMAIL_RECIPIENT (falling back to EMAIL_SENDER) from .env. Comma-separate for several.',
  },

  alert_ntfy_enabled: {
    type: 'int', def: 0, group: 'Alerts — push (optional)', min: 0, max: 1,
    label: 'Also send ntfy push',
    help: 'Optional. Email is the primary channel; push is useful because a 3am leak alert should wake you.',
  },
  ntfy_server: {
    type: 'string', def: 'https://ntfy.sh', env: 'NTFY_SERVER', group: 'Alerts — push (optional)',
    label: 'ntfy server',
    help: '',
  },
  ntfy_topic: {
    type: 'string', def: '', env: 'NTFY_TOPIC', group: 'Alerts — push (optional)', secretish: true,
    label: 'ntfy topic',
    help: 'Subscribe to this exact topic in the ntfy app. Pick something random — anyone who guesses it can read your alerts.',
  },
};

function coerce(type, raw, def) {
  if (raw === undefined || raw === null || raw === '') return def;
  if (type === 'int') { const n = parseInt(raw, 10); return Number.isFinite(n) ? n : def; }
  if (type === 'float') { const n = parseFloat(raw); return Number.isFinite(n) ? n : def; }
  // BOOL had no branch here, and the consequence was silent and total: a bool fell through to
  // String(raw), and "0" is a TRUTHY string in JavaScript. So a switch saved as off read as on,
  // every time, and there was no way to turn one off from the Settings page at all.
  //
  // Accepts what a human or a .env might plausibly write, not only 1 and 0, because the failure
  // mode of the strict version is the same silent one — "false" or "no" would coerce to true.
  if (type === 'bool') {
    if (typeof raw === 'boolean') return raw ? 1 : 0;
    const t = String(raw).trim().toLowerCase();
    if (t === '1' || t === 'true' || t === 'yes' || t === 'on') return 1;
    if (t === '0' || t === 'false' || t === 'no' || t === 'off') return 0;
    const n = Number(t);
    return Number.isFinite(n) ? (n ? 1 : 0) : (def ? 1 : 0);
  }
  return String(raw);
}

// The .env + built-in layer, with no DB involved. The collector uses this before the schema exists
// and the tests use it to stay DB-free.
function defaults() {
  const out = {};
  Object.keys(DEFS).forEach(function (name) {
    const d = DEFS[name];
    const envRaw = d.env ? process.env[d.env] : undefined;
    out[name] = coerce(d.type, envRaw, d.def);
  });
  return out;
}

const CACHE_MS = 15000;
let _cache = null;
let _cache_at = 0;

async function all(opts) {
  const force = opts && opts.force;
  if (!force && _cache && (Date.now() - _cache_at) < CACHE_MS) return _cache;
  const base = defaults();
  try {
    const rows = await db.query('SELECT name, value FROM water_settings');
    rows.forEach(function (r) {
      const d = DEFS[r.name];
      if (!d) return;                       // ignore rows for settings we no longer have
      base[r.name] = coerce(d.type, r.value, base[r.name]);
    });
  } catch (e) { /* table not created yet, or DB down — the .env/built-in layer still works */ }
  _cache = base; _cache_at = Date.now();
  return base;
}

/**
 * Range enforcement for a saved value.
 *
 * `min_nonzero` exists for settings where 0 means "unlimited" and any positive value has a floor.
 * A plain `min` cannot express that: min:7 would forbid 0, and min:0 would allow 1 -- and 1 day of
 * hourly history starves the continuous-flow rule, which needs six hours of buckets to see
 * anything. The floor is enforced again at the point of pruning, so a row edited straight into the
 * database by hand cannot quietly disarm a leak rule either.
 */
function clamp(d, v) {
  if (typeof v !== 'number') return v;
  if (d.min !== undefined && v < d.min) v = d.min;
  if (d.max !== undefined && v > d.max) v = d.max;
  if (d.min_nonzero !== undefined && v > 0 && v < d.min_nonzero) v = d.min_nonzero;
  return v;
}

async function set_many(patch, who) {
  const now = new Date();
  const stamp = time.sql_utc(now);
  const stamp_local = time.sql_local(now);
  const entries = Object.keys(patch || {}).filter(function (k) { return DEFS[k]; });
  for (const name of entries) {
    const d = DEFS[name];
    let v = clamp(d, coerce(d.type, patch[name], DEFS[name].def));
    await db.query(
      // created_at_* stays out of the ON DUPLICATE clause: a setting edited ten times was still
      // created once, and "when did this row first appear?" is the question it exists to answer.
      'INSERT INTO water_settings (name, value, updated_at_utc, updated_at_mtn, updated_by, created_at_mtn, created_at_utc) ' +
      'VALUES (?,?,?,?,?,?,?) ' +
      'ON DUPLICATE KEY UPDATE value=VALUES(value), updated_at_utc=VALUES(updated_at_utc), ' +
      'updated_at_mtn=VALUES(updated_at_mtn), updated_by=VALUES(updated_by)',
      [name, String(v), stamp, stamp_local, who || null, stamp_local, stamp]
    );
  }
  _cache = null;
  return all({ force: true });
}

// Seed any missing rows from the .env/built-in layer. Called once at collector startup so the
// Settings page shows real rows rather than an empty table.
async function seed_missing() {
  const base = defaults();
  const now = new Date();
  const stamp = time.sql_utc(now);
  const stamp_local = time.sql_local(now);
  for (const name of Object.keys(DEFS)) {
    await db.query(
      'INSERT IGNORE INTO water_settings (name, value, updated_at_utc, updated_at_mtn, updated_by, created_at_mtn, created_at_utc) ' +
      'VALUES (?,?,?,?,?,?,?)',
      [name, String(base[name]), stamp, stamp_local, 'seed', stamp_local, stamp]
    );
  }
  _cache = null;
}

// Shape for the Settings UI: current value + the metadata needed to render/validate the field.
function describe(values) {
  return Object.keys(DEFS).map(function (name) {
    const d = DEFS[name];
    return {
      name: name, value: values ? values[name] : undefined, type: d.type,
      label: d.label, help: d.help || '', group: d.group,
      min: d.min, max: d.max, min_nonzero: d.min_nonzero, default: d.def,
    };
  });
}

function invalidate() { _cache = null; }

module.exports = { DEFS, defaults, all, set_many, seed_missing, describe, invalidate, coerce, clamp };
