'use strict';
// water module — the Badger Orion leak monitor, the first feature of the home_assist platform.
//
// The module owns its data readers + API routes; the platform provides auth, session, access
// control, and the React shell. Adding this to modules/registry.js is the only wiring the platform
// needs — panel access, nav gating, and API mounting all read from the registry.
//
// NOTE the split: this manifest is mounted inside the WEB server and only READS MySQL. The radio,
// the leak rules, and the alerts run in collector_water.js, a separate process. Restarting the web
// server does not interrupt leak detection.
const api = require('./api');

/**
 * Startup seed, run by the web server after the schema is applied.
 *
 * Registers YOUR meter in water_meters so the selector, the Meters page and every "which meter am I
 * looking at" question have an answer before the radio has decoded anything. The collector does the
 * same thing on its own boot -- deliberately both, because they start independently and either one
 * may be the first (or only) process running:
 *
 *   - a dev laptop with no dongle never starts the collector at all, and an empty dropdown there
 *     looks exactly like a broken app rather than an absent radio;
 *   - on the server the web app usually restarts first after a pull.
 *
 * ensure_owned is an idempotent upsert, so running it from both processes on every boot is the
 * design rather than a redundancy to clean up.
 */
async function warm() {
  const settings = require('./store/settings');
  const meters = require('./store/meters');
  const cfg = await settings.all();
  if (cfg && cfg.meter_id) await meters.ensure_owned(cfg.meter_id);
}

module.exports = {
  id: 'water',
  label: 'Water',
  group: 'Water',
  panels: [
    { key: 'water', label: 'Water monitor', group: 'Water' },
    { key: 'water-admin', label: 'Water settings', group: 'Water' },
  ],
  metricsTable: null,     // reserved; no usage-analytics stack in v1
  mount: function (app) { api.mount(app); },
  warm: warm,
};
