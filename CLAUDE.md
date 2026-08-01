# CLAUDE.md — working in home_assist

Conventions for this repo. Read `README.md` first for what it does; this file is how to change it.

## What this is

An Express + React **platform shell** hosting feature **modules**. Water (the leak monitor) is the
first module, not the whole app. Anything you add should be a module.

This repo deliberately mirrors **usat_apps** (`usat/sql_programs/src/usat_apps`) — same auth,
session, panel-access, registry, side-rail, menu, and admin-CLI patterns, with `USATAPPS_` renamed
to `HOMEASSIST_`. MySQL/`.env`/`.gitignore` conventions come from **wrestling_stats**, as does the
nodemailer setup in `src/home_assist/notify/mailer.js`.

**When in doubt, go look at how usat_apps does it and do that.** Familiarity is the point; a clever
divergence costs more than it saves.

## House rules

- **Server code is CommonJS** (`'use strict'` + `require`). `web/` is ESM. This is not an accident —
  it is what let the auth layer port from usat_apps near-verbatim.
- **snake_case for server functions and files**, camelCase inside React components. Same split as
  usat_apps.
- **Never load `.env` with a hand-counted relative path.** `require('./src/home_assist/env')` (adjust
  depth) walks up to the repo root. A miscounted `..` fails silently as "Access denied for user
  'root'@'localhost' (using password: NO)".
- **Never call `new Date()` getters for local time.** Use `src/home_assist/time.js`. Local means the
  configured `WATER_TZ`, not the process's timezone — this repo moves between a Windows laptop and
  an Ubuntu box, and hour buckets that drift silently break the overnight window.
- **Every row gets both `*_utc` and `*_mtn`,** stamped in Node. No `CONVERT_TZ` — it depends on the
  MySQL server's tz tables being loaded, which differs between the two machines.
- **Nothing sensitive in the repo.** Credentials and runtime state live outside it via
  `utilities/directory_tools/determine_os_path.js`. There is no `data/` folder here, on purpose.
- **Paths follow the wrestling_stats pattern, not usat_apps'.** Three flat per-platform constants and
  one ternary — no per-username map. usat needs the map because it runs on a multi-account deployed
  server; this is a personal project on personal machines. The map's failure mode is an unlisted
  username silently resolving to someone else's path (and in wrestling's copy, to `undefined`).
  If you add a platform, add a constant — do not reintroduce the lookup.
- **Cross-platform, always.** `path.join`, no shell-isms, no hardcoded slashes. It is developed on
  Windows and runs on Ubuntu.

## The collector is the product

`collector_water.js` is the process that must never stop. When touching it:

- **Nothing in the tick path may throw its way out.** A MySQL blip must not kill the process
  watching for a flooded basement. Catch and log.
- **Analytics, email, and diagnostics are all best-effort.** They never block or break ingest.
- **Leak rules stay pure.** `rules/leak_rules.js` and `collector/ingest.js` take data + a `now` +
  settings, and return a value. No DB, no clock, no network. That is what makes them testable
  without a meter or an overnight wait — keep it that way.
- **Silence is not safety.** Any change that could make the watchdog quieter is a bug. A receiver
  that has stopped decoding produces a flat zero, indistinguishable from a quiet night, unless the
  watchdog says otherwise.
- **A rejected reading must not advance the baseline.** See the `impossible` case in `ingest.js`, and
  the regression test that pins the minimum rate window — without that floor, a legitimate +1 gal
  arriving one second after the previous packet computes to 60 gal/min, gets rejected, and because
  rejection does not advance the baseline the collector goes *permanently* deaf.

## Adding a module

Full recipe with a worked example: **`plans_and_notes/ADDING_A_MODULE.md`** (repo root). Short form:

1. `cp -r src/home_assist/modules/_template src/home_assist/modules/<id>` and fill in the manifest.
2. Add it to `src/home_assist/modules/registry.js`.
3. Add a group to `web/src/nav.js`.
4. `cp -r src/home_assist/plans_and_notes/_template src/home_assist/plans_and_notes/<id>`.

Panel access, the rail, the home cards, the router, and API mounting all derive from those two
registries. If you find yourself editing `access/panel_access.js` to add a panel, stop — the catalog
is built from the registry.

Set `externalApi: true` if a dedicated process owns the module's routes (the panel still registers
for access control and nav).

## Where notes go

Mirrors usat_apps. Keep it that way — a decision recorded with its reason can be revisited; one
recorded without can only be second-guessed.

- **Cross-cutting plans** (the shell, the roadmap, how-tos) → `plans_and_notes/` at the repo root.
- **Per-module** (status, build plan, hardware, deploy) → `src/home_assist/plans_and_notes/<module>/`.
- **Scratch** → `notes.txt` at either level. Gitignored, so it is safe to paste error text and
  half-formed ideas there.

When you change behaviour, update the relevant `STATUS.md` in the same pass. A STATUS file that
claims something is verified when it is not is worse than no STATUS file.

## Tests

`npm run home_assist_test` — must stay fast (~1s) and must never need MySQL, the network, or a radio.
That is what makes it something you actually run before a deploy.

Point new tests at the pure layers. If something is hard to test, it usually wants extracting into a
pure function rather than a mock.

`npm run home_assist_check` runs `node --check` over every server file — the cheap gate against the
class of bug that only surfaces when pm2 restarts the collector at 2am.

## Charts

`web/src/modules/water/BarChart.jsx` is hand-rolled inline SVG — no chart library, deliberately.
Rules that are already encoded there and should survive edits:

- One series → one color. The overnight window is an **annotation band** (a recessive surface tint),
  not a second series; a second hue would imply a second measure.
- **"No data" and "zero" must render differently.** On a leak monitor they mean opposite things.
- Status colors always ship with an icon **and** a word. Color never carries meaning alone.
- The SVG is drawn in **measured pixels**, not a stretched viewBox — a fixed viewBox with
  `preserveAspectRatio="none"` squashes the axis labels into illegibility on a phone, which is
  exactly where you read this dashboard.

## Deliberately not built

Left out on purpose; each has a seam, not a stub-shaped hole. Don't "fix" them without a reason:

- **Usage metrics / ask-your-data** — usat_apps' `metrics/` stack serves a team. This serves one
  house. `web/src/lib/track.js` is the seam; the module manifest keeps its `metricsTable` field.
- **An ops module** — the collector's health surfaces on the water panel instead.
- **SSO** — same deferral as usat_apps, same seam in `auth_store.js`.
- **Internet exposure** — LAN only. Email covers you when you are away.

## Working style

Single-line, paste-safe commands (Git Bash mangles multi-line pastes). Explain the "why" briefly.
Don't over-build ahead of the ask.
