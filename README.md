# home_assist

A home-assistant platform shell (Express + React), hosting feature **modules**. The first module is
a **water-meter leak monitor**: it reads the utility water meter's own 900 MHz radio broadcast with
a $40 RTL-SDR dongle and emails you when water is running that shouldn't be.

The problem it exists to solve: a running toilet flapper quietly wastes ~200 gal/day and you find
out on the bill. No plumbing work, no cutting pipe, no cloud service.

```
npm install
cp .env.example .env          # fill in MySQL + email + the recovery admin
npm run db_init               # create the database and its tables
npm run menu                  # interactive launcher for everything below
```

---

## The two processes

This is the one structural thing to understand:

| Process | What it does | If it dies |
|---|---|---|
| `collector_water.js` | Owns the rtl_433 radio, applies the sanity guards and leak rules, writes MySQL, sends alerts | **You stop being protected.** This is the one that matters. |
| `server_home_assist_8050.js` | Serves the React dashboard and reads MySQL | You lose the dashboard. Alerts keep working. |

They are separate on purpose. Rebuilding the UI, or a bug in a chart, must never take down leak
detection. Both run under pm2 on the Ubuntu box.

```
  meter ──900MHz──▶ rtl_433 ──JSON──▶ collector_water.js ──▶ MySQL ◀── server_8050 ──▶ browser
                                              │
                                              └──▶ email (+ optional ntfy push)
```

---

## Pathing

Same `/group/page` convention as usat_apps. `web/src/nav.js` is the single source — the side rail,
the router, the home cards, and the redirects are all derived from it, so they cannot drift apart.

| path | panel | what |
|---|---|---|
| `/` | — | Home: a card per panel you can reach, plus a live water banner |
| `/water` | — | → redirects to `/water/monitor` |
| `/water/monitor` | `water` | verdict, receiver strip, tiles, 48h chart, recent alerts |
| `/water/history` | `water` | hourly (24/48/72/168h) + daily (14/30/90d), table toggle |
| `/water/alerts` | `water` | full alert history with delivery status |
| `/water/settings` | `water-admin` | thresholds, email, retention, test alert |
| `/water/diagnostics` | `water-admin` | raw decoder lines, SMTP verify, recent readings |
| `/admin` | — | → redirects to `/admin/users` |
| `/admin/users` | `admin` | users + panel access |

A new non-admin user gets `water` only. Opening a page they lack the grant for renders the in-shell
**403** (`NotAuthorized`), not a 404 — the page exists, they just can't see it.

**API**, mounted by each module's `api.js`:

```
GET  /api/status                    public   liveness
GET  /api/health                    public   liveness + MySQL reachability
POST /api/login  /api/logout        public
GET  /api/me  /api/modules          session
GET/POST /api/admin/*               admin    users + panel access
GET  /api/water/status              water    the dashboard's 5s poll
GET  /api/water/hourly|daily|readings|alerts   water
GET/POST /api/water/settings        water-admin
POST /api/water/test-alert          water-admin
GET  /api/water/email-check|raw     water-admin
```

**Ports:** web `8050` (`HOMEASSIST_PORT`), Vite dev `5176`. The collector has no port — it publishes
a heartbeat row instead, so it works even if it ever runs on a different machine than the web server.

## Setup

### Prerequisites

| | Needed for | Check |
|---|---|---|
| **Node 18+** | everything | `node --version` |
| **MySQL 8** | all storage | `mysql --version` |
| **rtl_433** | live meter reading only — not needed for replay/dev | `rtl_433 -V` |
| **RTL-SDR dongle** | live meter reading only | `rtl_test -t` |
| **A Gmail app password** | alert emails | see step 4 |
| **pm2** | 24/7 running only | `npx pm2 -v` |

You can get the whole app running and see real charts with **only Node and MySQL** — replay mode
means no dongle and no rtl_433. Email and the radio can wait.

### Steps

**1. Install**

```bash
cd home_assist
npm install
```

**2. Create `.env`**

```bash
cp .env.example .env
```

Then fill it in — full reference below. The minimum to boot: `HOMEASSIST_ADMIN_USER`,
`HOMEASSIST_ADMIN_PASS`, and the `MYSQL_*` block.

**3. Create the database**

```bash
npm run db_init
```

Creates the `home_assist` database if missing, then all six tables. Idempotent — safe to re-run.
Verify: it prints the table list.

**4. Get a Gmail app password** (for alerts)

Your normal account password will **not** work. Google Account → Security → 2-Step Verification
(must be on) → App passwords → generate one for "Mail". Paste the 16 characters into
`EMAIL_PASSWORD` with no spaces.

Skip this and everything still works — leaks get recorded, nobody gets told. The collector says so
at startup.

**5. Preflight**

```bash
node collector_water.js --check
```

Checks MySQL, email, the resolved settings, that `rtl_433` actually resolves, and that your build
includes **protocol 223** — then exits without starting the radio. Run this first on any new
machine; it turns "it doesn't work" into a specific line.

**6. Build and run**

```bash
npm run home_assist_build       # compile the SPA
npm run home_assist_server      # http://localhost:8050
```

Sign in with `HOMEASSIST_ADMIN_USER` / `HOMEASSIST_ADMIN_PASS`.

**7. Give it data**

No dongle needed:

```bash
node collector_water.js --replay --leak    # synthetic running toilet
```

Watch the Monitor page fill in and the leak banner trip. With the dongle attached, use
`npm run water_collector` instead.

**8. Send yourself a test alert**

Water → Settings → *Send a test alert*. **Do this before you rely on it.** An alerting system you
have never seen alert is an assumption, not a safety net.

**8b. Where to keep rtl_433 (Windows)**

`C:\Users\calla\development\tools\noolec_v4_radio\rtl_433-win-x64-nightly\`.

Not OneDrive: Files On-Demand can turn the .exe into a cloud placeholder, and the collector then
fails or stalls when it spawns it — intermittently, at 3am, with no useful log line.

Point `WATER_RTL433_CMD_WINDOWS` at **`rtl_433_64bit_static.exe`** by full path rather than relying
on a bare `rtl_433` from PATH. That folder holds two binaries: the static one (no dependencies, and the
one the 2026-07-31 hose test validated) and `rtl_433.exe`, the dynamic build that loads
`librtlsdr.dll` from beside it. With a patched DLL in play they are not interchangeable, and a bare
name on PATH silently picks the dynamic one.

**9. For 24/7 running** — see `src/home_assist/plans_and_notes/water/UBUNTU_DEPLOY.md`. On Linux
there are three extra host steps that have nothing to do with this repo: blacklisting the DVB-T
kernel driver, confirming your `rtl_433` build actually includes protocol 223, and disabling sleep.

### Environment variables

All in `.env` at the repo root (gitignored — `.env.example` is the committed template).

**Required**

| Variable | Purpose |
|---|---|
| `HOMEASSIST_ADMIN_USER` | Recovery admin login. Always valid, never removable — you cannot lock yourself out. |
| `HOMEASSIST_ADMIN_PASS` | Its password. Both must be set for the account to count. |
| `MYSQL_HOST` · `MYSQL_PORT` · `MYSQL_USER` · `MYSQL_PASSWORD` | Connection. Defaults `127.0.0.1` / `3306` / `root` / empty. |
| `MYSQL_DATABASE` | Default `home_assist`. |

**Required for alerts** (skip and alerts are recorded but not delivered)

| Variable | Purpose |
|---|---|
| `EMAIL_SENDER` | The Gmail account that sends. |
| `EMAIL_PASSWORD` | A Gmail **app** password (step 4), not your account password. |
| `EMAIL_RECIPIENT` | Where alerts go. Defaults to `EMAIL_SENDER`. |

**Required for live reading** (not for replay)

| Variable | Purpose |
|---|---|
| `WATER_RTL433_CMD_WINDOWS` · `WATER_RTL433_CMD_LINUX` · `WATER_RTL433_CMD_MAC` | Per-platform decoder command, same suffix convention as wrestling_stats' `GOOGLE_APPLICATION_CREDENTIALS_*`. **One `.env` works on every machine.** Windows: full path to `rtl_433_64bit_static.exe` — prefer the static exe, since the nightly folder also holds the dynamic `rtl_433.exe` which loads a possibly-patched `librtlsdr.dll` from beside it. Ubuntu: `rtl_433`. **Do not keep the binary in OneDrive** — Files On-Demand can dehydrate the .exe and the collector then fails intermittently with no useful log. |
| `WATER_RTL433_CMD` | Overrides all three. An **empty** value counts as unset, so a leftover `WATER_RTL433_CMD=` cannot silently defeat the platform lines. |
| `WATER_METER_ID` | `16642655`. The radio id — *not* the serial stamped on the endpoint. |

**Optional — sensible defaults**

| Variable | Default | Purpose |
|---|---|---|
| `HOMEASSIST_PORT` | `8050` | Web server port. |
| `HOMEASSIST_SESSION_SECRET` | generated | Cookie-signing key. If unset, one is generated into `auth.json`. Set it explicitly if you want to be able to rotate it. |
| `HOMEASSIST_TEST_USER` · `HOMEASSIST_TEST_PASS` | — | An optional second admin. Both must be set to count. |
| `HOMEASSIST_DATA_DIR` | per-platform | Overrides where `auth.json` / `panel_access.json` / `captures/` live. |
| `HOMEASSIST_WEB_DIST` | `src/home_assist/web/dist` | Overrides where the built SPA is served from. |
| `HOMEASSIST_USERS_FILE` · `HOMEASSIST_PANEL_ACCESS_FILE` | under the data dir | Point at individual files. Mainly for tests. |
| `MYSQL_CONNECTION_LIMIT` | `8` | Pool size. |
| `EMAIL_HOST` · `EMAIL_PORT` · `EMAIL_SECURE` | `smtp.gmail.com` · `587` · `false` | Only if you're not using Gmail. `EMAIL_SECURE=true` for port 465. |
| `WATER_RTL433_ARGS` | `-f 916.45M -s 1600k -R 223 -F json` | Decoder args. Protocol 223, fixed frequency — see `water/HARDWARE.md` before changing. |
| `WATER_GALLONS_PER_UNIT` | `1` | Confirmed by hose test. |
| `WATER_TZ` | `America/Denver` | **Local time for every hour bucket and the overnight window.** Deliberately not the process timezone, so moving hosts can't silently shift the window. |
| `WATER_COLLECTOR_MODE` | `live` | `replay` to run without a dongle. `--replay` on the CLI does the same. |
| `WATER_REPLAY_FILE` | — | A captured `.jsonl` to replay instead of the synthetic meter. |
| `NTFY_SERVER` · `NTFY_TOPIC` | `https://ntfy.sh` · empty | Optional phone push, off unless you also enable it on the Settings page. |

Anything in `.env` is only a **default** — once the app has run, the values in the `water_settings`
table win, and those are edited from the Settings page without a redeploy.

### What is not in `.env`

- **Thresholds** — overnight window and limit, continuous-flow window, watchdog minutes, retention.
  They live in `water_settings` and are edited on the Settings page, because the one number you
  cannot guess in advance is `overnight_threshold_gal`. An ice maker, a water-softener regen cycle,
  and a recirculation pump all draw water at 3am and none of them is a leak. Watch a week of clean
  nights on the History page, then set it just above the noise floor.
- **Users beyond the recovery admin** — added in-app under Admin, or `node src/home_assist/admin.js add`.
- **Runtime state** — `auth.json`, `panel_access.json`, radio captures. Outside the repo, resolved
  per-platform by `utilities/directory_tools/determine_os_path.js`, the same three-constant pattern
  wrestling_stats uses. `node src/home_assist/admin.js where` prints the paths on this machine.

  | Platform | Path |
  |---|---|
  | Linux | `/home/steve-calla/development/home_assist/data` |
  | macOS | `/Users/steve-calla/development/home_assist/data` |
  | Windows | `C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/data/home_assist` |

  Windows points at MySQL's `secure_file_priv` folder because that is the one location MySQL itself
  may read and write, and it is not relocatable without editing `my.ini`. Rather than keep two data
  locations per platform, the constrained requirement picks the spot and everything follows it —
  matching usat_apps and wrestling_stats. **Caveat:** that path is version-numbered, so an 8.0 → 8.4
  upgrade can relocate it and take `auth.json` with it. Low stakes — it regenerates, and the `.env`
  recovery admin means you cannot be locked out.

## Everyday commands

```bash
npm run menu                    # all of the below, as a numbered menu

# development
npm run home_assist_dev_all     # API + Vite, hot reload
npm run water_replay            # synthetic meter — build the UI with no dongle attached
node collector_water.js --replay --leak    # synthetic running toilet, to see an alert fire

# checks
npm run home_assist_test        # auth + leak rules + ingest guards + time  (~1s, no DB)
npm run home_assist_check       # node --check every server file
node collector_water.js --check # preflight: MySQL, email, settings — then exit

# inspect
node src/home_assist/modules/water/report.js status    # is anything wrong right now?
node src/home_assist/modules/water/report.js dbsize    # rows + MB + growth projection
node src/home_assist/admin.js where                    # resolved out-of-repo paths

# production  (global pm2, not npx — the daemon is a machine-wide singleton)
npm run home_assist_build       # compile the SPA
npm run pm2_start_all           # our two processes + pm2 save
npm run pm2_startup             # make them survive a reboot (run the command it prints)
npm run pm2_status              # everything pm2 is managing
npm run pm2_logs_water_collector
```

pm2 scripts follow the usat_apps `pm2_<verb>_<process>` shape: `pm2_start_` / `pm2_restart_` /
`pm2_stop_` / `pm2_delete_` / `pm2_show_` / `pm2_logs_` × `home_assist` and `water_collector`, plus
wrestling_stats' machine-wide `pm2_list` / `pm2_monitor` / `pm2_logs_all` / `pm2_save`. The `_all`
variants name our two processes explicitly, so they can never take down your other pm2 apps.

## The hardware (confirmed on real equipment)

- **Dongle:** Nooelec NESDR SMArt v5 (RTL2832U + R820T2), ~$40.
- **Meter:** Badger Orion classic pit transmitter, FCC ID GIF2006B. Boulder uses drive-by AMR, so
  it bubbles up continuously every few seconds.
- **Radio id `16642655`** — this is *not* the serial printed on the endpoint (~857xxxxx). It was
  found by hose test, not by reading the stamp.
- **Decoder:** `rtl_433` protocol **223** ("Badger ORION water meter, 100kbps") on a fixed
  **916.45 MHz**. The classic Orion does not frequency-hop; protocols 282/290 are for the newer
  hopping endpoints (a neighbour has one, id 40462356). `rtlamr` cannot decode this meter at all.
- **Calibration: 1 count = 1 gallon.** Hose test 2026-07-31: volume rose 794113 → 794120 (7 counts)
  during ~6 min of kitchen faucet (~7 gal). Solid, but still worth cross-checking against the dial
  odometer on the next pit visit.

```bash
# the working command, standalone
rtl_433 -f 916.45M -s 1600k -R 223 -F json
```

## The three leak signals

All three live in `src/home_assist/modules/water/rules/leak_rules.js` as pure functions, so they are
tested without a meter, a database, or waiting until 2am.

1. **Overnight usage** — more than the threshold between 2am and 5am. The classic running-flapper
   catcher.
2. **Continuous flow** — water in *every* hour for 6 consecutive hours. Household use is bursty; a
   constant trickle is not.
3. **Radio watchdog** — no readings for 90 minutes. The most important of the three: a receiver that
   has silently stopped decoding produces a flat zero, which looks exactly like a quiet night.
   **Silence is not safety.**

Plus a daily 8am summary — the proof-of-life that tells you the whole chain still works on a day
when nothing is wrong.

## Layout

```
server_home_assist_8050.js       # web host (API + serves the SPA)
collector_water.js               # the radio process
utilities/directory_tools/
  determine_os_path.js           # where things live, per platform (wrestling_stats pattern)
  create_directory.js            # mkdir -p a named folder under it
src/home_assist/
  env.js  time.js  data_dir.js   # env loading, timestamps, out-of-repo paths
  admin.js  menu.js              # user CLI, interactive launcher
  auth/       session, scrypt user store, require_auth/admin/panel
  access/     panel catalog (built from the module registry) + allow-list
  api/        platform routes: status/login/me/modules/admin
  store/      MySQL pool, schema, db_init
  notify/     mailer (nodemailer/Gmail), ntfy (optional push)
  modules/
    registry.js        # THE module list — one line per feature
    _template/         # copy this to add a feature
    water/             # module.js, api.js, rules/, collector/, store/, tests/
  web/                 # Vite + React SPA
  tests/               # auth/access + time
```

## Adding the next feature

The platform knows nothing about water. To add, say, a thermostat module:

1. `cp -r src/home_assist/modules/_template src/home_assist/modules/thermostat`, fill in the
   manifest (`id`, `label`, `panels`, `mount`).
2. Add one line to `src/home_assist/modules/registry.js`.
3. Add a group to `web/src/nav.js` with your section components.

Panel access, the side rail, the home cards, the router, and API mounting are all derived from those
two registries. Nothing else changes.

## Docs

Same layout as usat_apps: repo-root `plans_and_notes/` for cross-cutting plans, and
`src/home_assist/plans_and_notes/<module>/` per module.

```
plans_and_notes/                              # repo root — cross-cutting
  PLATFORM_PLAN.md          roadmap, standing constraints, candidate module #2
  ADDING_A_MODULE.md        the recipe, worked example + checklist
  CLOUDFLARE_AND_REMOTE_ACCESS.md   exposing it beyond the LAN — and whether you should
src/home_assist/plans_and_notes/
  README_HOME_ASSIST.md     the charter — why it is built this way, the module contract
  STATUS.md                 platform snapshot: built / verified / needs your machine
  notes.txt                 scratch (gitignored)
  water/
    STATUS.md               the module's snapshot
    BUILD_PLAN.md           the plan it was built against, and what was skipped on purpose
    HARDWARE.md             the meter, the radio, and how each fact was established
    UBUNTU_DEPLOY.md        the 24/7 host runbook
    notes.txt               scratch (gitignored) — includes the threshold tuning log
  _template/                copy into <module>/ when adding a feature
```

Also at the repo root: `CLAUDE.md` — conventions for working in this repo.
