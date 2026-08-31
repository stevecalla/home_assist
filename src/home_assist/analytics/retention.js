'use strict';
/**
 * analytics/retention.js — how big the events table is, and how to trim it.
 *
 * Ported from usat_apps' utilities/analytics/retention.js. The year boundary is computed in NODE
 * for the same reason the timestamps are: MySQL's timezone tables are not guaranteed to be loaded
 * on either machine this repo runs on.
 *
 * `table` is always a code constant, never user input — it is interpolated, not bound, because you
 * cannot bind an identifier.
 */
const db = require('../store/db');

// created_at_mtn is the reporting clock; fall back to _utc for any row written before both existed.
const YEAR_COL = 'YEAR(COALESCE(created_at_mtn, created_at_utc))';

function current_year_in_tz(tz) {
  return Number(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'America/Denver', year: 'numeric',
  }).format(new Date()));
}

async function size(table) {
  const info = await db.query(
    'SELECT ROUND((data_length + index_length) / 1024 / 1024, 2) AS mb FROM information_schema.tables ' +
    'WHERE table_schema = DATABASE() AND table_name = ?', [table]);
  const range = await db.query(
    'SELECT COUNT(*) AS rows_total, MIN(created_at_mtn) AS min_mtn, MAX(created_at_mtn) AS max_mtn ' +
    'FROM `' + table + '`');
  const by_year = await db.query(
    'SELECT ' + YEAR_COL + ' AS yr, COUNT(*) AS n FROM `' + table + '` GROUP BY yr ORDER BY yr');
  return {
    mb: info[0] ? Number(info[0].mb) : 0,
    rows: range[0] ? Number(range[0].rows_total) : 0,
    min_mtn: range[0] ? range[0].min_mtn : null,
    max_mtn: range[0] ? range[0].max_mtn : null,
    by_year: (by_year || []).map(function (r) { return { year: Number(r.yr), rows: Number(r.n) }; }),
  };
}

// years = 2 keeps the current and the prior calendar year, and deletes anything older.
async function purge_keep_years(table, years, reporting_tz) {
  const keep = Math.max(1, Number(years) || 2);
  const cutoff = current_year_in_tz(reporting_tz) - (keep - 1);
  const where = YEAR_COL + ' < ' + cutoff;
  const c = await db.query('SELECT COUNT(*) AS n FROM `' + table + '` WHERE ' + where);
  const would = c[0] ? Number(c[0].n) : 0;
  const r = await db.query('DELETE FROM `' + table + '` WHERE ' + where);
  return { deleted: r && r.affectedRows != null ? r.affectedRows : would, cutoff_year: cutoff };
}

// Rows flagged is_test = 1 — the ones produced by loading a page with ?metrics_test=1. Deleting
// these leaves real activity untouched, which is the whole reason the flag exists.
async function purge_test(table) {
  const c = await db.query('SELECT COUNT(*) AS n FROM `' + table + '` WHERE is_test = 1');
  const would = c[0] ? Number(c[0].n) : 0;
  const r = await db.query('DELETE FROM `' + table + '` WHERE is_test = 1');
  return { deleted: r && r.affectedRows != null ? r.affectedRows : would };
}

async function purge_all(table) {
  const c = await db.query('SELECT COUNT(*) AS n FROM `' + table + '`');
  const would = c[0] ? Number(c[0].n) : 0;
  const r = await db.query('DELETE FROM `' + table + '`');
  return { deleted: r && r.affectedRows != null ? r.affectedRows : would };
}

module.exports = { size, purge_keep_years, purge_test, purge_all, current_year_in_tz, YEAR_COL };
