'use strict';
/**
 * events.js — the write side of usage analytics.
 *
 * Two entry points:
 *   log(event)                    a server-side event (something only the server knows)
 *   ingest_http(req, user, role)  POST /api/event, from the browser
 *
 * The division of trust in ingest_http is the important part, and it is why the browser cannot
 * simply be believed: the SERVER stamps app, actor, role, env and is_test OVER whatever arrived.
 * The client supplies only the descriptive fields — which panel, which path, viewport, theme. So a
 * page cannot claim to be another user, and "who did this" is always the session's answer.
 *
 * Everything here is fire-and-forget and swallows its own errors. A page that fails to render
 * because a metrics INSERT failed would be a self-inflicted outage in a house monitor.
 */
const { insert_event } = require('../../analytics/event_ingest');
const cfg = require('./metrics_config');

const ALLOW = new Set(cfg.COLUMNS);

// dev vs prod, from how the process was started. Not a security boundary — it exists so the
// laptop's clicking-around does not have to be mentally subtracted from the real numbers.
function current_env() {
  return process.env.NODE_ENV === 'development' ? 'dev' : 'prod';
}

async function log(event) {
  try {
    const e = Object.assign({ app: cfg.APP, source: 'server' }, event || {});
    if (e.env === undefined) e.env = current_env();
    if (e.is_test === undefined) e.is_test = 0;
    if (e.meta && typeof e.meta === 'object') e.meta = JSON.stringify(e.meta);
    await insert_event(cfg.TABLE, ALLOW, cfg.REPORTING_TZ, e);
  } catch (err) { /* analytics must never break the app */ }
}

async function ingest_http(req, user, role) {
  const body = req && req.body && typeof req.body === 'object' ? req.body : {};
  const q = (req && req.query) || {};
  // ?metrics_test=1 marks a whole sitting as deliberate testing. Those rows are excluded from the
  // headline figures and can be purged in one click, so you can exercise the app without poisoning
  // the very numbers you are exercising it to check.
  const is_test = String(q.metrics_test || body.metrics_test || '') === '1' || Number(body.is_test) === 1 ? 1 : 0;

  const clean = Object.assign({}, body);
  delete clean.metrics_test;
  delete clean.is_test;

  try {
    await log(Object.assign(clean, {
      app: cfg.APP,
      actor: user || null,
      role: role || null,
      source: 'web',
      env: current_env(),
      is_test: is_test,
    }));
  } catch (e) { /* never throws */ }
}

module.exports = { log, ingest_http, current_env, TABLE: cfg.TABLE, COLUMNS: cfg.COLUMNS };
