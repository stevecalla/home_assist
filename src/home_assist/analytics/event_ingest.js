'use strict';
/**
 * analytics/event_ingest.js — write one event row.
 *
 * Ported from usat_apps' utilities/analytics/event_ingest.js, with one deliberate change: it uses
 * this repo's `store/db` (which returns rows directly) rather than taking a raw mysql2 pool. usat's
 * version is shared by four apps and has to stay pool-agnostic; here there is exactly one pool and
 * one db module, and threading a pool through every caller would be ceremony.
 *
 * TWO RULES, both non-negotiable:
 *
 *   1. It never throws. Analytics that can break a page is worse than no analytics — and this app's
 *      whole purpose is to keep watching a water meter. Every failure is swallowed.
 *   2. The caller cannot choose the columns. `allow` is a whitelist, applied here on the server, so
 *      a browser cannot post a field nobody designed for. That is also the privacy boundary: the
 *      column list IS the statement of what is collected.
 *
 * Timestamps are stamped in NODE, both _utc and _mtn, exactly as every other table in this repo
 * does it. No CONVERT_TZ — it needs MySQL's tz tables loaded, which differs between the laptop and
 * the Ubuntu box, and returns NULL when they are not.
 */
const db = require('../store/db');

const DEFAULT_TZ = 'America/Denver';

// 'YYYY-MM-DD HH:mm:ss' for an instant in an IANA zone. en-CA gives ISO-ish ordering natively.
function fmt_in_tz(date, tz) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce(function (o, x) { o[x.type] = x.value; return o; }, {});
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
}

/**
 * Insert one row. `allow` is a Set of permitted column names. Returns true if a row was written.
 *
 * Uses query() rather than execute() on purpose: the column set varies per event, so prepared
 * statements would accumulate one cached plan per shape and buy nothing.
 */
/**
 * The whole filtering decision, as a pure function: given what arrived and what is permitted,
 * return the exact SQL and bound values — or null when nothing survived.
 *
 * Separated from the INSERT so the privacy boundary can be TESTED without a database. That is not
 * a convenience: the whitelist is the only thing standing between arbitrary browser JSON and a
 * stored table, and a rule that can only be verified against a live MySQL is a rule that stops
 * being verified.
 */
function build_insert(table, allow, reporting_tz, body, now) {
  body = body || {};
  const cols = [];
  const vals = [];
  Object.keys(body).forEach(function (k) {
    if (!allow.has(k) || body[k] === undefined) return;
    cols.push(k);
    // '' becomes NULL. An empty string and "we did not measure this" are the same thing for every
    // column here, and two spellings of absent means every query needs to test for both.
    vals.push(body[k] === '' ? null : body[k]);
  });
  if (!cols.length) return null;

  const at = now instanceof Date ? now : new Date();
  cols.push('created_at_utc'); vals.push(fmt_in_tz(at, 'UTC'));
  cols.push('created_at_mtn'); vals.push(fmt_in_tz(at, reporting_tz || DEFAULT_TZ));

  return {
    sql: 'INSERT INTO `' + table + '` (' + cols.map(function (c) { return '`' + c + '`'; }).join(', ') +
      ') VALUES (' + cols.map(function () { return '?'; }).join(', ') + ')',
    vals: vals,
  };
}

async function insert_event(table, allow, reporting_tz, body) {
  const q = build_insert(table, allow, reporting_tz, body);
  if (!q) return false;
  await db.query(q.sql, q.vals);
  return true;
}

module.exports = { insert_event, build_insert, fmt_in_tz, DEFAULT_TZ };
