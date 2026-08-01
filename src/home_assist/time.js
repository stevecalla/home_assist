'use strict';
/**
 * time.js — every timestamp in home_assist, in one place.
 *
 * Two rules, both borrowed from the usat_apps analytics convention:
 *
 *  1. Every row carries BOTH `*_utc` and `*_mtn` (local) timestamps, stamped here in Node.
 *     We never ask MySQL to convert (no CONVERT_TZ), because that depends on the server's tz
 *     tables being loaded and on the connection timezone — two things that silently differ
 *     between your Windows laptop and the Ubuntu box.
 *
 *  2. Local time means the configured zone (WATER_TZ, default America/Denver), NOT the process's
 *     tz. The original monitor.mjs used process-local getters; that breaks the moment the
 *     collector runs somewhere with a different TZ than the reader thinks it has.
 *
 * Hour buckets are keyed 'YYYY-MM-DDTHH' in LOCAL time — the same key shape monitor.mjs used, so
 * the leak rules port over unchanged.
 */

const DEFAULT_TZ = 'America/Denver';

function zone() { return process.env.WATER_TZ || DEFAULT_TZ; }

const _fmt_cache = new Map();
function formatter(tz) {
  let f = _fmt_cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    _fmt_cache.set(tz, f);
  }
  return f;
}

// Break a Date into calendar parts *in the given zone*.
function parts(date, tz) {
  const d = date instanceof Date ? date : new Date(date);
  const got = {};
  formatter(tz || zone()).formatToParts(d).forEach(function (p) {
    if (p.type !== 'literal') got[p.type] = p.value;
  });
  // Intl renders midnight as hour '24' in some ICU versions; normalize.
  const hour = got.hour === '24' ? '00' : got.hour;
  return {
    year: got.year, month: got.month, day: got.day,
    hour: hour, minute: got.minute, second: got.second,
  };
}

const pad = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DDTHH' in local time — the hour-bucket key.
function hour_key(date, tz) {
  const p = parts(date, tz);
  return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour;
}

// 'YYYY-MM-DD' in local time.
function day_key(date, tz) { return hour_key(date, tz).slice(0, 10); }

// The local hour, as a number (0-23).
function local_hour(date, tz) { return Number(parts(date, tz).hour); }

// The hour key N hours before `date`.
function hour_key_offset(date, back, tz) {
  const d = date instanceof Date ? date : new Date(date);
  return hour_key(new Date(d.getTime() - back * 3600 * 1000), tz);
}

// The day key N days before `date`.
function day_key_offset(date, back, tz) {
  const d = date instanceof Date ? date : new Date(date);
  return day_key(new Date(d.getTime() - back * 86400 * 1000), tz);
}

// 'YYYY-MM-DD HH:MM:SS' for a MySQL DATETIME column, in UTC.
function sql_utc(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' +
    pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
}

// 'YYYY-MM-DD HH:MM:SS' for a MySQL DATETIME column, in the configured local zone.
function sql_local(date, tz) {
  const p = parts(date, tz);
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
}

// Both stamps for one moment — the shape every insert wants.
//
// `utc_ms` / `local_ms` carry milliseconds, for DATETIME(3) columns. water_packets needs them:
// transmissions arrive about every four seconds, and whole-second stamps collide often enough that
// "which packet came first" — the one question that table exists to answer — becomes unanswerable.
// MySQL truncates the fractional part when the column is a plain DATETIME, so the same string is
// safe to pass to either.
function stamps(date, tz) {
  const d = date instanceof Date ? date : new Date(date);
  const ms = '.' + String(d.getUTCMilliseconds()).padStart(3, '0');
  return {
    utc: sql_utc(d),
    local: sql_local(d, tz),
    utc_ms: sql_utc(d) + ms,
    local_ms: sql_local(d, tz) + ms,
  };
}

// 'YYYY-MM-DDTHH' -> 'YYYY-MM-DD HH:00:00' (the local hour start, for the rollup row).
function hour_start_sql(hourKey) {
  return String(hourKey).slice(0, 10) + ' ' + String(hourKey).slice(11, 13) + ':00:00';
}

// The list of hour keys covering [start, end) hours back from `date`, newest last.
// e.g. recent_hour_keys(now, 48) -> the 48 keys ending with the current hour.
function recent_hour_keys(date, count, tz) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push(hour_key_offset(date, i, tz));
  return out;
}

module.exports = {
  DEFAULT_TZ, zone, parts, hour_key, day_key, local_hour,
  hour_key_offset, day_key_offset, sql_utc, sql_local, stamps,
  hour_start_sql, recent_hour_keys,
};
