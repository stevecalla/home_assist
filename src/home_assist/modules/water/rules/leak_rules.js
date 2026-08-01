'use strict';
/**
 * leak_rules.js — the three leak signals, ported one-for-one from monitor.mjs.
 *
 * Everything here is a PURE function: it takes an hour-bucket map, a `now`, and a settings object,
 * and returns either null or an alert descriptor. No DB, no clock, no network, no side effects.
 * That is the whole point — these are the rules that decide whether to wake you at 3am, so they
 * should be testable without a meter, a database, or waiting overnight.
 *
 * The hour-bucket map is `{ 'YYYY-MM-DDTHH': gallons }` in LOCAL time — the same shape
 * monitor.mjs kept in state.hours, which is why the logic ports across unchanged.
 *
 * Delivery, cooldowns, and persistence are the caller's job (store/alerts.js).
 *
 * An alert descriptor:
 *   { key, kind, severity, tags, message, detail, cooldown_min }
 *   key  — the cooldown key. Day-scoped keys (overnight:2026-08-01) naturally fire once per day.
 */
const time = require('../../../time');

// Sum a list of hour keys. `missing` counts keys with no bucket at all, which is different from a
// bucket of zero: no data means we did not observe the hour, not that no water flowed.
function sum_hours(hours, keys) {
  let total = 0, missing = 0;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(hours, k)) total += Number(hours[k]) || 0;
    else missing++;
  }
  return { total, missing };
}

const pad = (n) => String(n).padStart(2, '0');

// The hour keys covering last night's window for the local day `date` falls in.
function overnight_keys(date, cfg, tz) {
  const day = time.day_key(date, tz);
  const keys = [];
  for (let h = cfg.overnight_start_hour; h < cfg.overnight_end_hour; h++) keys.push(day + 'T' + pad(h));
  return keys;
}

/**
 * Signal 1 — overnight usage. The classic running-toilet catcher: nobody should be drawing water
 * between 2am and 5am, so anything over the threshold is suspicious.
 * Only evaluates once the window has fully passed for the current local day.
 */
function check_overnight(hours, now, cfg, tz) {
  if (time.local_hour(now, tz) < cfg.overnight_end_hour) return null;
  const day = time.day_key(now, tz);
  const keys = overnight_keys(now, cfg, tz);
  const { total, missing } = sum_hours(hours, keys);
  if (missing === keys.length) return null;             // no data at all for the window
  if (!(total > cfg.overnight_threshold_gal)) return null;
  return {
    key: 'overnight:' + day,
    kind: 'overnight',
    severity: 'high',
    tags: 'warning,droplet',
    cooldown_min: 20 * 60,
    message: 'Water ran overnight: ' + total.toFixed(0) + ' gal between ' +
      cfg.overnight_start_hour + ':00–' + cfg.overnight_end_hour + ':00. ' +
      '(Threshold ' + cfg.overnight_threshold_gal + ' gal.)',
    detail: { day, total, threshold: cfg.overnight_threshold_gal, hours_missing: missing, keys },
  };
}

/**
 * Signal 2 — continuous flow. Water in EVERY one of the last N hours. Normal household use is
 * bursty; a constant trickle is not.
 * Deliberately looks at hours 1..N (not the current, partial hour).
 */
function check_continuous(hours, now, cfg, tz) {
  const keys = [];
  for (let i = 1; i <= cfg.continuous_hours; i++) keys.push(time.hour_key_offset(now, i, tz));
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(hours, k)) return null;   // gap in data -> not a streak
    if (Number(hours[k]) < cfg.continuous_min_gal_per_hour) return null;
  }
  const { total } = sum_hours(hours, keys);
  return {
    key: 'continuous',
    kind: 'continuous',
    severity: 'high',
    tags: 'rotating_light,droplet',
    cooldown_min: 12 * 60,
    message: 'Continuous flow: water every hour for ' + cfg.continuous_hours + 'h (' +
      total.toFixed(0) + ' gal). Nothing normal does that.',
    detail: { total, hours: cfg.continuous_hours, min_per_hour: cfg.continuous_min_gal_per_hour, keys },
  };
}

/**
 * Signal 3 — the radio watchdog. If the receiver stops decoding, we would otherwise see a flat
 * zero and read it as "no leak". This is the most important of the three: silence is not safety.
 *
 * TWO cases, and the second one used to be a hole:
 *
 *   stale          we were receiving, and stopped. Measured from the last reading.
 *   never_decoded  the collector is up but has NEVER decoded a packet. Measured from start-up.
 *
 * The original version returned null when there had never been a reading — "nothing to be stale
 * relative to". That is wrong for a monitor: a collector that has never heard the meter will sit
 * there for days, the dashboard saying "waiting for first reading", and send nothing. It is the
 * same danger as going deaf mid-run, at the moment you are most likely to hit it (first setup, a
 * moved antenna, a dongle that will not tune).
 *
 * @param last_read_at Date | ISO string | null — the last accepted reading
 * @param started_at   Date | ISO string | null — when the collector process started
 */
function check_watchdog(last_read_at, now, cfg, started_at) {
  const never = !last_read_at;
  const ref_raw = last_read_at || started_at;
  if (!ref_raw) return null;                       // genuinely nothing to measure from

  const ref = ref_raw instanceof Date ? ref_raw : new Date(ref_raw);
  const quiet_min = (now.getTime() - ref.getTime()) / 60000;
  if (!(quiet_min > cfg.stale_minutes)) return null;

  const mins = Math.round(quiet_min);
  if (never) {
    return {
      key: 'never_decoded',                        // its own cooldown key — a different problem
      kind: 'stale',
      severity: 'high',
      tags: 'mute,warning',
      cooldown_min: 6 * 60,
      message: 'The collector has been running for ' + mins + ' min and has NEVER decoded a packet. ' +
        'Leak detection has not started. Check that rtl_433 is tuning (look for "PLL not locked"), ' +
        'that the dongle is seated, and that the antenna can see the meter pit.',
      detail: { never_decoded: true, running_minutes: mins, stale_minutes: cfg.stale_minutes, started_at: ref.toISOString() },
    };
  }

  return {
    key: 'stale',
    kind: 'stale',
    severity: 'high',
    tags: 'mute,warning',
    cooldown_min: 6 * 60,
    message: 'No meter readings for ' + mins + ' min. ' +
      'Leak detection is NOT running — check the receiver.',
    detail: { quiet_minutes: mins, stale_minutes: cfg.stale_minutes, last_read_at: ref.toISOString() },
  };
}

/**
 * The daily "still alive" total. Not a leak signal — it is the proof-of-life that tells you the
 * whole chain still works on a day when nothing is wrong.
 */
function daily_summary(hours, now, cfg, tz) {
  if (cfg.daily_summary_hour === null || cfg.daily_summary_hour < 0) return null;
  if (time.local_hour(now, tz) !== cfg.daily_summary_hour) return null;
  const keys = [];
  for (let i = 1; i <= 24; i++) keys.push(time.hour_key_offset(now, i, tz));
  const { total } = sum_hours(hours, keys);
  return {
    key: 'summary:' + time.day_key(now, tz),
    kind: 'summary',
    severity: 'low',
    tags: 'bar_chart',
    cooldown_min: 20 * 60,
    message: 'Last 24h: ' + total.toFixed(0) + ' gallons.',
    detail: { total },
  };
}

/**
 * evaluate — run every rule and return the descriptors that fired, worst first.
 * The collector hands these to store/alerts.js, which applies cooldowns and pushes to ntfy.
 */
function evaluate(input) {
  const { hours, now, cfg, tz, last_read_at, started_at } = input;
  const out = [];
  const watchdog = check_watchdog(last_read_at, now, cfg, started_at);
  if (watchdog) out.push(watchdog);
  const overnight = check_overnight(hours, now, cfg, tz);
  if (overnight) out.push(overnight);
  const continuous = check_continuous(hours, now, cfg, tz);
  if (continuous) out.push(continuous);
  const summary = daily_summary(hours, now, cfg, tz);
  if (summary) out.push(summary);
  return out;
}

/**
 * status — the same rules, phrased for the dashboard banner rather than for a push notification.
 * Ignores cooldowns entirely: the banner should reflect what is true right now, even if we already
 * sent the alert hours ago.
 */
function status(input) {
  const { hours, now, cfg, tz, last_read_at, started_at, run } = input;
  const watchdog = check_watchdog(last_read_at, now, cfg, started_at);
  if (watchdog) {
    // "never decoded" and "went silent" look identical on a chart but mean different things: one is
    // a setup problem you can fix now, the other is a working system that broke.
    return watchdog.detail.never_decoded
      ? { state: 'offline', headline: 'Never decoded a packet', detail: watchdog.message, since: watchdog.detail.started_at }
      : { state: 'offline', headline: 'Receiver silent', detail: watchdog.message, since: watchdog.detail.last_read_at };
  }
  const continuous = check_continuous(hours, now, cfg, tz);
  if (continuous) {
    return { state: 'leak', headline: 'Continuous flow', detail: continuous.message };
  }

  // The banner must never say "All clear" while the run meter says water has been running for an
  // hour. check_continuous works in whole hours and needs six of them, so on its own it leaves a
  // multi-hour window where the page contradicts itself — and a leak monitor whose own two answers
  // disagree teaches you to trust neither. The live run is the faster signal; let it speak first.
  if (run && run.flowing && run.level === 'continuous') {
    return {
      state: 'leak',
      headline: 'Water running continuously',
      detail: 'Water has been running for ' + (run.truncated ? 'at least ' : '') + run.minutes +
        ' minutes without stopping (' + run.gallons.toFixed(0) + ' gal at ' + run.rate.toFixed(1) +
        ' gal/min). Fixtures stop on their own; something that does not is stuck or leaking.',
    };
  }
  const overnight = check_overnight(hours, now, cfg, tz);
  if (overnight) {
    return { state: 'leak', headline: 'Overnight flow', detail: overnight.message };
  }
  if (!last_read_at) {
    // Still inside the grace window — genuinely "starting up", not yet a fault.
    return {
      state: 'unknown',
      headline: 'Waiting for first reading',
      detail: 'The collector has not decoded a packet yet. If this persists past ' +
        cfg.stale_minutes + ' min you will be emailed.',
    };
  }
  return { state: 'ok', headline: 'All clear', detail: 'No leak signals in the current window.' };
}

/**
 * current_run — how long has water been flowing WITHOUT STOPPING, right now?
 *
 * This is the measurement the whole app exists for, and it is the one thing neither of the other
 * two rules gives you:
 *
 *   check_overnight   answers it at 5am, once, for last night.
 *   check_continuous  answers it in whole hours, and needs SIX of them before it says anything.
 *   current_run       answers it now, in minutes.
 *
 * A running toilet at 2:10am is already a leak; you should not have to wait until 8am to be told.
 * Every household fixture stops on its own — a shower ends, a dishwasher cycles, a sprinkler zone
 * finishes. Something that never stops is broken. So the signal is not volume, it is DURATION with
 * no idle break, and that is measurable within minutes.
 *
 * A "run" is consecutive readings each within `gap_min` of the previous one. Gallon-resolution
 * matters here: a slow leak at 0.4 gal/min only produces a reading every ~2.5 minutes, so the gap
 * that ends a run has to be generous or a genuine slow leak reads as a series of tidy short runs —
 * which is precisely the failure that would hide the thing we are hunting.
 *
 * Pure: takes readings + a now + settings, returns a value. No DB, no clock.
 *
 * @param readings  [{ read_at_utc, gallons, delta_gallons }] newest first (as recent_readings returns)
 * @returns { flowing, minutes, gallons, rate, started_at, idle_minutes, level }
 *          level  'idle' | 'running' | 'long' | 'continuous'
 */
function current_run(readings, now, cfg) {
  const gap_ms = Math.max(1, Number(cfg.run_gap_min) || 5) * 60000;
  const warn = Math.max(1, Number(cfg.run_warn_min) || 30);
  const alarm = Math.max(warn + 1, Number(cfg.run_alarm_min) || 60);
  const empty = { flowing: false, minutes: 0, gallons: 0, rate: 0, started_at: null, idle_minutes: null, level: 'idle' };

  if (!readings || !readings.length) return empty;

  // Oldest-first, and only rows that actually carried water — a zero-delta row is not flow.
  const flow = readings
    .map(function (r) {
      const raw = r.read_at_utc instanceof Date ? r.read_at_utc : new Date(String(r.read_at_utc).replace(' ', 'T') + 'Z');
      return { t: raw.getTime(), gal: Number(r.delta_gallons) || 0 };
    })
    .filter(function (r) { return Number.isFinite(r.t) && r.gal > 0; })
    .sort(function (a, b) { return a.t - b.t; });

  if (!flow.length) return empty;

  const last = flow[flow.length - 1];
  const idle_ms = now.getTime() - last.t;
  if (idle_ms > gap_ms) {
    // Nothing recent enough to be "running now". Report how long it has been quiet instead —
    // silence is the good news here, and it should be legible as such.
    return Object.assign({}, empty, { idle_minutes: Math.floor(idle_ms / 60000) });
  }

  // Walk back while each step is within the gap.
  let start = flow.length - 1;
  let gallons = flow[start].gal;
  while (start > 0 && flow[start].t - flow[start - 1].t <= gap_ms) {
    start--;
    gallons += flow[start].gal;
  }

  const started_at = new Date(flow[start].t);
  const minutes = Math.max(0, (now.getTime() - flow[start].t) / 60000);
  const rate = minutes > 0 ? gallons / minutes : 0;

  // `truncated` matters: if the run reaches the oldest row we were given, it may well have been
  // going longer and we simply cannot see. Say "at least", never invent a start time.
  const truncated = start === 0;

  return {
    flowing: true,
    minutes: Math.round(minutes),
    gallons: gallons,
    rate: rate,
    started_at: started_at.toISOString(),
    idle_minutes: 0,
    truncated: truncated,
    level: minutes >= alarm ? 'continuous' : minutes >= warn ? 'long' : 'running',
    warn_min: warn,
    alarm_min: alarm,
  };
}

/**
 * ALERT_CATALOG — what can fire, when, and which setting moves it.
 *
 * Lives HERE, next to the rules it describes, and is rendered by the Reference page rather than
 * retyped there. A reference page maintained by hand is a reference page that is wrong within two
 * releases, and being wrong about when your leak alarm fires is worse than having no page at all.
 *
 * `cooldown_min` and `settings` are read straight from the checks above — if you change a cooldown,
 * change it in one place and both the behaviour and the documentation move together.
 */
const ALERT_CATALOG = [
  {
    kind: 'overnight',
    label: 'Overnight flow',
    severity: 'high',
    when: 'Once the overnight window has passed, if more than the threshold ran during it.',
    evaluated: 'Every 60s, but the window is only judged after it ends.',
    cooldown_min: 20 * 60,
    why: 'A house asleep uses almost nothing. Water between 2am and 5am is the single clearest ' +
      'leak signal there is, which is why this is the alert to tune first.',
    settings: ['overnight_start_hour', 'overnight_end_hour', 'overnight_threshold_gal'],
  },
  {
    kind: 'continuous',
    label: 'Continuous flow',
    severity: 'high',
    when: 'Water in EVERY hour for the configured number of consecutive hours.',
    evaluated: 'Every 60s, over whole local hours.',
    cooldown_min: 12 * 60,
    why: 'Nothing in a house runs every hour for six hours. One dry hour resets the streak, and a ' +
      'MISSING hour does not count as dry — no data is not the same as no flow.',
    settings: ['continuous_hours', 'continuous_min_gal_per_hour'],
  },
  {
    kind: 'stale',
    label: 'Receiver silent',
    severity: 'high',
    when: 'No meter reading for stale_minutes.',
    evaluated: 'Every 60s.',
    cooldown_min: 6 * 60,
    why: 'THE most important alert. A dead receiver produces a flat zero, which is indistinguishable ' +
      'from a quiet night — without this, the system fails silently and you find out from the water bill.',
    settings: ['stale_minutes'],
  },
  {
    kind: 'stale',
    key: 'never_decoded',
    label: 'Never decoded a packet',
    severity: 'high',
    when: 'The collector has run past stale_minutes and has never heard the meter.',
    evaluated: 'Every 60s.',
    cooldown_min: 6 * 60,
    why: 'A separate alert from "went silent" because it is a different problem: this one is a setup ' +
      'fault you can fix now (antenna, dongle, frequency), not a working system that broke.',
    settings: ['stale_minutes'],
  },
  {
    kind: 'summary',
    label: 'Daily summary',
    severity: 'low',
    when: 'At the configured hour, every day.',
    evaluated: 'Every 60s; fires on the matching local hour.',
    cooldown_min: 20 * 60,
    why: 'Proof of life. An email that arrives every morning is how you know the alerting path ' +
      'itself still works — silence from a monitor is ambiguous, and this removes the ambiguity.',
    settings: ['daily_summary_hour'],
  },
  {
    kind: 'run',
    label: 'Continuous run (dashboard only)',
    severity: 'info',
    when: 'Shown live on the Monitor once a run passes run_warn_min / run_alarm_min.',
    evaluated: 'Every status poll (5s in the UI).',
    cooldown_min: null,
    email: false,
    why: 'Answers in MINUTES what the hourly continuous rule needs six hours to say. Does NOT email ' +
      'yet — it is a dashboard signal only.',
    settings: ['run_gap_min', 'run_warn_min', 'run_alarm_min'],
  },
];

module.exports = {
  sum_hours, overnight_keys,
  check_overnight, check_continuous, check_watchdog, daily_summary, current_run,
  evaluate, status, ALERT_CATALOG,
};
