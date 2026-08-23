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
  // ONE PANEL PER PAGE.
  //
  // This used to be two: `water` and `water-admin`. Two labels stopped describing seven pages --
  // "Water settings" had quietly come to include the Meters page, which is where you decide which
  // meters are allowed to email whom. A permission whose label understates what it grants is the
  // kind of thing nobody notices until it matters.
  //
  // Order matters: the Admin page renders the catalog in this order under one "Water" group with a
  // select-all, so read-only pages come first and the three that change things come last.
  panels: [
    { key: 'water-monitor', label: 'Monitor — live status + meter card', group: 'Water' },
    { key: 'water-history', label: 'History — hourly + daily charts', group: 'Water' },
    { key: 'water-alerts', label: 'Alerts — the alert history', group: 'Water' },
    { key: 'water-reference', label: 'Reference — what each rule does', group: 'Water' },
    { key: 'water-settings', label: 'Settings — thresholds + email (changes behaviour)', group: 'Water' },
    { key: 'water-meters', label: 'Meters — names, scale, WHO GETS EMAILED', group: 'Water' },
    { key: 'water-diagnostics', label: 'Diagnostics — raw decoder feed + SMTP check', group: 'Water' },
  ],
  metricsTable: null,     // reserved; no usage-analytics stack in v1
  mount: function (app) { api.mount(app); },
  warm: warm,
};
