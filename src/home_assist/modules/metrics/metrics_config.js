'use strict';
/**
 * metrics_config.js — the only app-specific input the analytics core needs.
 *
 * Modelled on usat_apps/metrics/metrics_config.js. Read by the ingest, the report and the tests, so
 * the column whitelist has exactly one definition.
 *
 * THE COLUMN LIST IS THE PRIVACY STATEMENT. Nothing here identifies a person beyond the login name
 * they already typed: a panel key, a path, coarse counts, a viewport bucket, a browser timezone,
 * and a random id kept in that browser. No IP address, no user agent string, no query values, no
 * meter readings. A module that needs something of its own puts it in `meta`, which keeps domain
 * data out of the core rather than growing this list one feature at a time.
 */
const APP = 'home_assist';
const TABLE = 'home_assist_events';
const KEEP_YEARS = 2;                    // current + prior calendar year
const REPORTING_TZ = process.env.WATER_TZ || 'America/Denver';

// Insertable columns — everything except `id` and the two stamped created_at_*. Enforced on the
// server, mirrored by the browser client. Adding analytics means adding here AND to the DDL in
// store/schema.js; the schema's ADDED_COLUMNS migration handles existing tables.
const COLUMNS = [
  // who, and which sitting
  'app', 'event_name', 'page_path', 'session_id', 'visitor_id', 'is_returning', 'actor', 'role',
  // where in the app
  'panel', 'view', 'filter_name', 'export_format',
  // counts, timing, failures
  'row_count', 'duration_ms', 'error_type', 'error_msg',
  // environment
  'event_at_local', 'client_tz', 'local_hour', 'local_dow', 'app_version', 'engine',
  'viewport', 'theme', 'is_test', 'env', 'source',
  // per-module escape hatch, so domain fields never grow the core
  'meta',
];

/**
 * The event vocabulary. Documentation first, and a guard the tests read — an event name that is not
 * here still inserts, but it will not appear in any report section, which is the failure mode worth
 * catching early.
 */
const EVENTS = {
  view: ['panel_view', 'page_view', 'filter_run', 'search_run', 'report_export'],
  session: ['login', 'logout', 'access_change'],
  ui: ['theme_change'],
  issues: ['not_found', 'not_authorized', 'error'],
};

function all_events() {
  return Object.keys(EVENTS).reduce(function (a, k) { return a.concat(EVENTS[k]); }, []);
}

module.exports = { APP, TABLE, KEEP_YEARS, REPORTING_TZ, COLUMNS, EVENTS, all_events };
