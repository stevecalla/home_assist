# STATUS — home_assist platform

Snapshot of what's built and what's next. Per-module status lives in `<module>/STATUS.md`.

Last updated: 2026-08-01 (initial build).

## Built and verified

**Platform core** — ported from usat_apps, `USATAPPS_` → `HOMEASSIST_`:

- `auth/session.js` — HMAC-signed cookie `home_assist_session`, rolling 48h idle expiry.
- `auth/auth_store.js` — scrypt users (per-user salt, timing-safe compare) + a `.env` recovery admin
  that is always valid and never removable.
- `auth/require_auth.js` — `require_auth` / `require_admin` / `require_panel`.
- `access/panel_access.js` — catalog **built dynamically from the module registry** (usat_apps
  hardcodes its CATALOG despite the comment claiming otherwise; here it genuinely is derived, with a
  lazy require to break the cycle), plus a default allow-list and per-user overrides.
- `api/routes.js` — status / health / login / logout / me / modules / admin.
- `modules/registry.js` + `_template/module.js` — the module contract.
- `store/db.js`, `store/schema.js`, `store/init_db.js` — MySQL pool + idempotent schema.
- `time.js` — local-time hour keys and the `*_utc` / `*_mtn` stamp pair. No `CONVERT_TZ`.
- `env.js` — repo-root `.env` located by walking up, so no file hand-counts `..` segments.
- `data_dir.js` + `utilities/directory_tools/{determine_os_path,create_directory}.js` — runtime data
  outside the repo. Follows the **wrestling_stats** pattern (three flat per-platform constants, one
  ternary) rather than usat_apps' per-username map, because usat's map exists for a multi-account
  deployed server and this is a personal project on personal machines. Windows resolves to MySQL's
  `secure_file_priv` folder so there is one data location per platform, not two — matching both
  existing repos. `tests/paths.test.js` pins all three platforms.
- `notify/mailer.js` — the wrestling_stats nodemailer pattern (Gmail SMTP 587, pooled, app password),
  converted ESM → CJS. `notify/ntfy.js` — optional push, off by default.
- `menu.js` — the usat_apps numbered launcher, `[t]` CLI toggle, `.menu_prefs.json`.
- `admin.js` — add / list / passwd / remove / access / where.

**Web shell** — `styles.css`, `SideRail`, `ThemeToggle`, `UserMenu`, `FooterClock`, `Login`, `Home`,
`Admin`, `NotFound`, `NotAuthorized` copied from usat_apps so the two apps look and behave the same.
Added: a responsive breakpoint at 820px (the rail becomes a horizontal strip) — usat_apps has none,
and this dashboard is read from a phone.

**Verification (2026-08-01):**

- 103/103 unit tests pass in ~1s — no DB, no network, no radio.
- 43/43 server files pass `node --check`.
- Full auth chain exercised over HTTP: 401 unauthenticated → login → `/api/me` returns the right
  panels → `/api/modules` → admin panel-access.
- Full ingest path exercised against live MySQL with a replayed meter; the API and dashboard read it
  back correctly in light, dark, and mobile.

## Deliberately not built

Each has a seam, not a stub-shaped hole — see `README_HOME_ASSIST.md` § Deliberately not built.

- Usage metrics / ask-your-data. `web/src/lib/track.js` is the seam (no-op); the module manifest
  keeps its `metricsTable` field.
- An ops module — collector health surfaces on the water panel.
- SSO — same deferral as usat_apps, same seam in `auth_store.js`.
- Internet exposure / TLS / reverse proxy — LAN only.

## Needs your machine (cannot be done from the agent env)

1. `npm install` at the repo root and in `src/home_assist/web`.
2. Fill in `.env`: `HOMEASSIST_ADMIN_PASS`, and `EMAIL_PASSWORD` (a Gmail **app** password generated
   under 2-factor auth — the account password will not work).
3. `npm run db_init` against the local MySQL.
4. `npm run home_assist_build`, then `npm run home_assist_server`.
5. Everything in `water/STATUS.md` § Needs hardware.

## Next

Platform work is done for now. The open items are all in the water module and all involve real
hardware — see `water/STATUS.md`. Module #2 candidates are in
`plans_and_notes/PLATFORM_PLAN.md` (repo root).
