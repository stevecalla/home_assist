'use strict';
/**
 * modules/registry.js — the server-side module registry for the home_assist platform.
 *
 * A "module" is a self-contained feature domain (water, and whatever comes next — thermostat,
 * power, doors…). Each one exports a small manifest (see modules/_template/module.js):
 *
 *   {
 *     id:           'water',                      // stable slug (URL + panel namespace)
 *     label:        'Water',                      // nav label
 *     group:        'Water',                      // nav-group label
 *     panels:       [{ key, label, group }],      // panel keys it contributes to access control
 *     metricsTable: null,                         // reserved; no metrics stack in v1
 *     mount(app):   registers its /api/<id>/* routes
 *     warm():       optional startup cache warm
 *   }
 *
 * To add a module: create modules/<id>/module.js against the contract and add it to MODULES below.
 * Nothing else in the platform changes — panel access, nav gating, and API mounting all read from here.
 */
const water = require('./water/module');

const MODULES = [
  water,
  // thermostat,   // next feature goes here
];

function list() { return MODULES.slice(); }

// Flatten every module's contributed panels -> [{ key, label, group, module }].
// Consumed by access/panel_access.catalog().
function panels() {
  const out = [];
  MODULES.forEach(function (m) {
    (m.panels || []).forEach(function (p) {
      out.push({ key: p.key, label: p.label, group: p.group || m.group || m.label, module: m.id });
    });
  });
  return out;
}

// Mount every module's API routes onto the Express app. Modules whose API lives in a dedicated
// process set externalApi:true — they still contribute panels for access control/nav, but their
// routes are not mounted here.
function mount_all(app) {
  MODULES.forEach(function (m) { if (!m.externalApi && typeof m.mount === 'function') m.mount(app); });
}

// Prebuild each module's caches at server startup (best-effort, non-blocking). Called from
// start_server AFTER listen — NEVER from create_app, so tests that build the app don't hit MySQL.
function warm_all() {
  MODULES.forEach(function (m) {
    if (typeof m.warm === 'function') {
      try { Promise.resolve(m.warm()).catch(function () {}); } catch (e) { /* ignore */ }
    }
  });
}

module.exports = { list, panels, mount_all, warm_all };
