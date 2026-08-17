'use strict';
// _template/module.js — copy this folder to modules/<your-id>/ to scaffold a new home_assist feature,
// then add it to modules/registry.js. That is the ONLY change the platform needs to gain a new app.
//
// Contract:
//   id            stable slug — becomes the API namespace (/api/<id>/*) and the panel namespace
//   label         nav label
//   group         nav-group label (groups collapse in the side rail)
//   panels        [{ key, label, group }] panel keys this module gates (added to the access catalog)
//   metricsTable  reserved for a future usage-analytics stack; null for now
//   mount(app)    register the module's /api/<id>/* Express routes (panel-gate them with require_panel)
//   warm()        optional: startup hook, run AFTER the schema is applied and BEFORE the first
//                 request. Prebuild caches here, and seed any row the UI needs before this
//                 module's own collector process has ever run -- a dev machine may never start
//                 that process at all, and an empty dropdown there looks like a broken app
//                 rather than an absent sensor. Awaited, best-effort: a throw is logged and the
//                 next module still warms.
//   externalApi   true if a DEDICATED process owns these routes (the panel still registers here)
//
// The matching FRONT-END entry lives in web/src/nav.js (path, panel key, lazy-loaded component) and
// the section component in web/src/modules/<id>/Section.jsx.
const { require_panel } = require('../../auth/require_auth');

module.exports = {
  id: 'example',
  label: 'Example',
  group: 'Example',
  panels: [{ key: 'example', label: 'Example panel', group: 'Example' }],
  metricsTable: null,
  mount: function (app) {
    app.get('/api/example/ping', require_panel('example'), function (req, res) {
      res.json({ ok: true, module: 'example' });
    });
  },
};
