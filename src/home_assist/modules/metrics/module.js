'use strict';
/**
 * metrics module — usage analytics for the platform itself.
 *
 * The second module, and the first one that is ABOUT the app rather than about the house. It sits
 * in the Admin group because that is what it is: an operator's view of who used what, which links
 * are broken, and what threw.
 *
 * WHY THIS EXISTS AT ALL on a one-house dashboard. usat_apps' version answers "which panels does
 * the team use", which here would be a list of you. The value is the other half: `not_found`,
 * `not_authorized` and `error` are questions you cannot answer once the moment has passed, and this
 * app is checked most urgently at exactly the times nobody is taking notes.
 *
 * Access: `metrics` is a normal grantable panel, so it appears in the access panel like any other
 * and an admin can hand it to someone. It is in panel_access.DEFAULT_ALL_EXCLUDE, so the 'all'
 * default does NOT include it — which makes it admin-only until someone deliberately grants it.
 * Purging is admin-only whatever the grant says (see api.js).
 */
const api = require('./api');

module.exports = {
  id: 'metrics',
  label: 'Metrics',
  group: 'Admin',
  panels: [
    { key: 'metrics', label: 'Metrics — usage, errors, broken links', group: 'Admin' },
  ],
  // Its own table, and the first module to fill this field in. It has always been the seam for
  // exactly this; see modules/_template/module.js.
  metricsTable: require('./metrics_config').TABLE,
  mount: function (app) { api.mount(app); },
};
