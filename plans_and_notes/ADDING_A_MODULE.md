# Adding a module

The whole point of the shell. A new feature should be a manifest file and a nav entry — if you find
yourself editing the router, the rail, or `panel_access.js`, stop and re-read this.

Worked example: adding a `power` module.

## 1. Server manifest

```bash
cp -r src/home_assist/modules/_template src/home_assist/modules/power
```

Edit `src/home_assist/modules/power/module.js`:

```js
module.exports = {
  id: 'power',
  label: 'Power',
  group: 'Power',                                    // nav-group label (rail section)
  panels: [
    { key: 'power', label: 'Power monitor', group: 'Power' },
    { key: 'power-admin', label: 'Power settings', group: 'Power' },
  ],
  metricsTable: null,
  mount: function (app) { require('./api').mount(app); },
};
```

## 2. Register it

`src/home_assist/modules/registry.js` — one require, one array entry:

```js
const power = require('./power/module');
const MODULES = [ water, power ];
```

That is the *only* change to platform code. `access/panel_access.js` builds its catalog from
`registry.panels()`, so the new panels appear in the Admin page, in `effective_panels()`, and in
`require_panel()` automatically. `tests/auth.test.js` asserts this behaviour, so it will not silently
regress.

If the panel should need an explicit grant rather than being on by default, add its key to
`DEFAULT_ALL_EXCLUDE` in `panel_access.js`. That is the one legitimate reason to open that file.

## 3. API routes

`src/home_assist/modules/power/api.js` — panel-gate everything:

```js
const { require_panel } = require('../../auth/require_auth');

function mount(app) {
  app.get('/api/power/status', require_panel('power'), guard(async (req, res) => { ... }));
  app.post('/api/power/settings', require_panel('power-admin'), guard(async (req, res) => { ... }));
}
```

Copy the `guard()` helper from `modules/water/api.js` — it turns a rejected promise into a clean 500
instead of an unhandled rejection that takes the server down.

## 4. Front end

Add a group to `web/src/nav.js`:

```js
const PowerMonitor = lazy(() => import('./modules/power/Monitor.jsx'));

{ type: 'group', label: 'Power', items: [
    { label: 'Monitor', path: '/power/monitor', panel: 'power', icon: '⚡', Component: PowerMonitor },
]},
```

Lazy imports keep each module in its own bundle chunk. Section components live in
`web/src/modules/power/`, styles scoped with a `.p-` prefix in `power.css` — never edit
`styles.css` for module-specific rules.

Add API methods to `web/src/lib/api.js` alongside the `water*` ones.

## 5. Data

If the module owns tables, add them to `src/home_assist/store/schema.js` as
`CREATE TABLE IF NOT EXISTS`, prefixed with the module id (`power_readings`, `power_hourly`). Both
the server and any collector call `ensure_schema()` at startup, so whichever runs first creates them.

Stamp both `*_utc` and `*_mtn` with `src/home_assist/time.js`. Never `CONVERT_TZ`.

## 6. If it needs its own background process

Copy the water split: a `collector_<module>.js` at the repo root that owns the hardware/polling and
writes MySQL, while the web server only reads. Add `pm2_start_*` scripts to `package.json`.

Set `externalApi: true` on the manifest if a dedicated process also owns the module's HTTP routes —
the panel still registers here for access control and nav, but `registry.mount_all()` skips it.

## 7. Tests

Put the decision logic in pure functions (`rules/`, or a `store/` module that takes data rather than
querying) and test those. `modules/water/rules/leak_rules.test.js` is the model: every scenario is a
literal object, no DB, no clock, no network.

`npm run home_assist_test` picks up any `*.test.js` under `src/home_assist` automatically — no
registration needed.

## 8. Menu + notes

- Add a section to `src/home_assist/menu.js` (`SECTIONS`) so the module's commands are discoverable.
- `cp -r src/home_assist/plans_and_notes/_template src/home_assist/plans_and_notes/power` and fill in
  `STATUS.md` / `BUILD_PLAN.md`.

## Checklist

- [ ] `modules/<id>/module.js` from the template
- [ ] One line in `modules/registry.js`
- [ ] `modules/<id>/api.js`, every route behind `require_panel`
- [ ] Tables in `store/schema.js`, prefixed, with both timestamps
- [ ] Group in `web/src/nav.js`; components in `web/src/modules/<id>/`; scoped CSS
- [ ] `api.js` methods in `web/src/lib/api.js`
- [ ] Pure-function tests
- [ ] Menu section
- [ ] `plans_and_notes/<id>/STATUS.md`
- [ ] `npm run home_assist_test && npm run home_assist_check` green
