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
};
