# home_assist — platform charter & plan

One Express + React **platform shell** hosting home-automation tools as **modules**. The first
module is the **water** leak monitor. Modelled directly on usat_apps — same shape, same contract, so
that moving between the two repos costs nothing.

- **Web server:** `server_home_assist_8050.js` (repo root) · default port **8050** (`HOMEASSIST_PORT`)
- **Collector:** `collector_water.js` (repo root) · owns the radio, no HTTP port
- **Code:** `src/home_assist/`
- **Build the web app:** `npm run home_assist_build`

## Documents

Same split as usat_apps: repo-root `plans_and_notes/` for cross-cutting plans, and
`src/home_assist/plans_and_notes/<module>/` for per-module notes.

| Doc | What it is |
|---|---|
| `plans_and_notes/PLATFORM_PLAN.md` *(repo root)* | Roadmap, standing constraints, candidate module #2 |
| `plans_and_notes/ADDING_A_MODULE.md` *(repo root)* | The recipe, with a worked example and a checklist |
| `plans_and_notes/CLOUDFLARE_AND_REMOTE_ACCESS.md` *(repo root)* | Tunnel + Access setup, and the hardening it requires first |
| **this file** | The charter — why it is built this way, the module contract |
| `STATUS.md` | Platform snapshot: built / verified / needs your machine |
| `water/STATUS.md` | The water module's snapshot |
| `water/BUILD_PLAN.md` | The plan it was built against, and what was skipped on purpose |
| `water/HARDWARE.md` | The meter, the radio, and how each fact was established |
| `water/UBUNTU_DEPLOY.md` | The 24/7 host runbook |
| `_template/` | Copy into `<module>/` when adding a feature |

`notes.txt` files are gitignored scratch pads, one per level.
Repo root also has `README.md` (what it does) and `CLAUDE.md` (how to change it).

## Why platform + modules, for a house

usat_apps extracts the ~70% of plumbing (session auth, access control, the shell) that five internal
apps all duplicated. Here there is only one app so far, so the argument is different: **the second
feature is the one that pays for this.** A thermostat panel, a power monitor, a door sensor — each
should cost one manifest file and one nav entry, not a fresh Express server and a fresh login. The
alternative — a `water-monitor` repo, then a `thermostat` repo, each with its own auth — is how you
end up with four dashboards and three passwords.

Modular monolith: one web process, one deploy, clean module boundaries. Not microservices.

## The one structural decision: two processes

```
  meter ──900MHz──▶ rtl_433 ──JSON──▶ collector_water.js ──▶ MySQL ◀── server_8050 ──▶ browser
                                              │
                                              └──▶ email (+ optional ntfy push)
```

`collector_water.js` owns the radio, the sanity guards, the leak rules, and the alerts. It writes
MySQL. `server_home_assist_8050.js` only reads.

This mirrors how usat_apps isolates `event_coi` on its own server (a wedged Playwright browser must
not take the web front door down), applied to the opposite priority: here the *background* process
is the important one. Rebuilding the SPA, or a bug in a chart component, must never stop leak
detection. The collector publishes a heartbeat row so the UI can tell "collector down" from
"collector up but hearing nothing" — two different problems with the same symptom.

## Folder structure

```
server_home_assist_8050.js        # web host (mounts platform API + serves the SPA)
collector_water.js                # rtl_433 -> MySQL + alerts. The process that must not stop.
utilities/directory_tools/        # per-platform paths — the wrestling_stats pattern
  determine_os_path.js            #   three flat constants + a ternary; no username map
  create_directory.js             #   mkdir -p a named folder under the base
src/home_assist/
  env.js                          # repo-root .env loader, resolved by walking up
  time.js                         # local-time hour keys + the *_utc/*_mtn stamp pair
  data_dir.js                     # runtime data home OUTSIDE the repo
  admin.js  menu.js               # user CLI; interactive launcher (usat_apps menu.js pattern)
  store/db.js  schema.js  init_db.js
  auth/                           # THE COMMON STUFF (platform core)
    auth_store.js                 #   local users (scrypt) + .env recovery + session secret
    session.js                    #   signed-cookie sessions (cookie: home_assist_session)
    require_auth.js               #   require_auth / require_admin / require_panel
  access/panel_access.js          # panel catalog (BUILT FROM the module registry) + allow-list
  notify/mailer.js  ntfy.js       # email (wrestling_stats nodemailer pattern); optional push
  api/routes.js                   # platform routes: status/health/login/logout/me/modules/admin
  modules/
    registry.js                   #   the module list (add a module here)
    _template/module.js           #   copy this to scaffold a new module
    water/                        #   module.js, api.js, rules/, collector/, store/, tests/
  web/                            # the React SPA (Vite)
  tests/                          # auth + access + time (no DB)
```

## The module contract

**Server** — `src/home_assist/modules/<id>/module.js`, added to `modules/registry.js`:

```js
{
  id:          'water',                        // stable slug -> /api/<id>/* + panel namespace
  label:       'Water',
  group:       'Water',                        // nav-group label
  panels:      [{ key, label, group }],        // panel keys added to the access catalog
  metricsTable: null,                          // reserved; no metrics stack in v1
  mount(app):  registers /api/<id>/* routes,   // panel-gate them with require_panel(...)
  warm():      optional startup cache warm
  externalApi: true                            // optional: a dedicated process owns these routes
}
```

**Front-end** — a group in `web/src/nav.js` pointing at lazy-loaded components in
`web/src/modules/<id>/`.

That's it. Panel access, the side rail, the home cards, the router, and API mounting all read from
the registries, so a new module "just appears".

**Difference from usat_apps worth noting:** usat_apps hardcodes its `CATALOG` in `panel_access.js`
even though the comment says it is dynamic. Here it genuinely is built from `registry.panels()`
(resolved lazily to break the require cycle), so adding a module never means editing the access
file. Verified by `tests/auth.test.js`, which asserts the water panels appear in the catalog without
being named there.

## Authentication & access

Split, as in usat_apps, into **authentication** (who you are) and **authorization** (what you can
see) so that adding SSO later is purely additive.

**Today:** local username/password (scrypt, per-user salt, timing-safe compare) + a `.env` recovery
admin that is always valid and can never be removed — you cannot lock yourself out of your own house
dashboard. Sessions are HMAC-signed cookies with a rolling 48h idle expiry: active use never times
out, an idle session does.

```
HOMEASSIST_ADMIN_USER / HOMEASSIST_ADMIN_PASS      recovery admin (role admin, never removable)
HOMEASSIST_TEST_USER  / HOMEASSIST_TEST_PASS       optional second admin
HOMEASSIST_SESSION_SECRET                          optional; else generated into auth.json
```

**Panels:**

| key | label | default for a new user |
|---|---|---|
| `water` | Water monitor | granted |
| `water-admin` | Water settings & diagnostics | needs an explicit grant |
| `admin` | Users & access | admin only, hard-gated |

Stored users and the access list live in `auth.json` / `panel_access.json` **outside the repo**.

## Data model

MySQL, database `home_assist`. `store/schema.js` creates everything idempotently at startup.

| table | replaces (from `monitor.mjs`) | why |
|---|---|---|
| `water_readings` | `usage.csv` | every accepted reading + the delta credited |
| `water_hourly` | `state.hours` | the hour buckets every leak rule reads |
| `water_alerts` | `state.notified` | alert history **and** the cooldown ledger |
| `water_collector_state` | `state.lastReading`, `state.radioQuiet` | baseline + heartbeat |
| `water_settings` | the `const` block | thresholds, editable from the UI |
| `water_raw_samples` | the `raw-sample.jsonl` file | "are the field names what we think?" |

Two improvements over the JSON-file version, both about restarts: cooldowns now survive a collector
restart (they are queried, not held in memory), and the baseline is rehydrated from the DB, so
gallons used while the collector was down are not silently dropped.

## Alerts

Email is the primary channel, using the **wrestling_stats nodemailer pattern** verbatim in shape:
Gmail SMTP over STARTTLS on 587, pooled, `EMAIL_SENDER` + `EMAIL_PASSWORD` (a Gmail **app** password
generated under 2-factor auth) + `EMAIL_RECIPIENT`. The HTML body follows `send_job_status_email.js`
— a colored status banner over a details table.

ntfy push is kept from the original `monitor.mjs` as an **optional second channel, off by default**.
It earns its ~40 lines because a leak at 3am is exactly when a push beats an email nobody reads
until morning. The topic name is the only secret, so it must be random.

Delivery outcome is recorded per alert. "We raised an alert" and "you received an alert" are
different facts, and the UI shows both.

## Ubuntu cutover

The repo is developed on Windows and runs permanently on the Linux Dell Latitude. One env var
(`WATER_RTL433_CMD`) is the entire code-level port; everything else is host setup — the DVB-T driver
blacklist, an rtl_433 new enough to include protocol 223, disabling sleep, and pm2 on boot.

**Full runbook: `water/UBUNTU_DEPLOY.md`.** Hardware and reception details, including how each fact
about the meter was established: `water/HARDWARE.md`.

## Deliberately not built

Each is a decision, not an oversight, and each has a seam rather than a hole:

- **Usage metrics / ask-your-data.** usat_apps' `metrics/` stack is ~1500 lines serving a team.
  `web/src/lib/track.js` is the seam (a no-op today); the module manifest keeps `metricsTable`.
- **An ops module.** No fleet console — collector health surfaces on the water panel.
- **Microsoft/Entra SSO.** Same deferral as usat_apps, same seam in `auth_store.js`.
- **Internet exposure / reverse proxy / TLS.** LAN only; email covers you when away. Exposing a
  house dashboard to the internet is a much bigger commitment than it looks.

## Status

Built and verified end to end against a live MySQL and a replayed meter:

- **103/103 unit tests pass** — password hashing, `.env` recovery login, add/remove/validate users,
  session sign/verify + tamper + expiry rejection, the module-driven panel catalog, the
  default/per-user/admin access model, all three leak rules, the ingest sanity guards, and the
  local-time hour-key layer, the diagnostic rate limiter, and the SMTP deadline wrapper.
- **43/43 server files parse cleanly** (`node --check`).
- Collector ingests through the real path (rtl_433 JSON → guards → `water_readings` +
  `water_hourly` + `water_collector_state`); the API and dashboard read it back correctly in light,
  dark, and mobile.
- Three real bugs found and fixed during verification:
  1. **The rate filter had no minimum window** — a legitimate reading arriving a second after the
     previous one computed to 60 gal/min and was rejected, permanently, since rejection does not
     advance the baseline. `min_rate_window_min` + regression tests pin it.
  2. **Rejected-packet logging was unbounded** and the retention sweep ran only at startup. A radio
     producing continuous garbage would have written ~100 MB/day of diagnostics. Now rate-limited to
     10/hour with an hourly sweep — see `water/STATUS.md` § Data growth & retention.
  3. **`mailer.verify()` had no timeout**, so the collector's startup preflight could hang before it
     started watching. Explicit SMTP timeouts + a deadline wrapper; a monitor blocked on its email
     check is worse than one with broken email.

**Not yet verified on real hardware**, because it needs the dongle and the Ubuntu box:

1. Live rtl_433 capture end to end (replay exercises the same ingest path, but not the radio).
2. Email delivery — `EMAIL_*` is unset here. `node collector_water.js --check` reports it.
3. Reception quality at the permanent antenna location.

## Open items carried over

1. Pick a random `NTFY_TOPIC` if you want push, and install the ntfy app.
2. Tune `overnight_threshold_gal` after ~a week of clean nights — the ice maker, the water softener
   regen, and any recirc pump all show up overnight and none of them is a leak.
3. Cross-check the 1 gal/count calibration against the dial odometer on the next pit visit.
4. Decide whether the collector also wants a `pm2 startup` systemd unit or just `pm2 save`.
