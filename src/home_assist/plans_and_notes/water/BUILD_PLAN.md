# BUILD_PLAN — water module

The plan this module was built against, kept as the record of *why* it is shaped this way. Phases
1–5 are done; the rest is the honest backlog.

## Origin

Before this repo there was `monitor.mjs`: a single self-contained Node script, no dependencies, that
spawned rtl_433 and pushed ntfy alerts. It worked. What it could not do:

- Show you anything. No history, no charts, no "was last night normal?"
- Be tuned without editing the source. Every threshold was a `const`.
- Survive a restart cleanly — cooldowns lived in memory, so a restart could re-send an alert you had
  already acknowledged, or reset a 20-hour cooldown to zero.
- Keep the gallons used while it was down. A restart re-baselined from the next packet.
- Tell you it had stopped working, except by not sending anything — which is indistinguishable from
  nothing being wrong.

The port kept the logic and fixed those five things.

## Phases

### Phase 1 — extract the rules as pure functions ✅

`rules/leak_rules.js` and `collector/ingest.js` take data + a `now` + settings and return a value.
No DB, no clock, no network.

This was first on purpose. These are the functions that decide whether to wake you at 3am; if they
are not testable in isolation, the only way to test them is to wait until 3am. Every scenario in
`tests/leak_rules.test.js` is a literal object.

### Phase 2 — MySQL, replacing the JSON/CSV state ✅

| was | is | why |
|---|---|---|
| `usage.csv` | `water_readings` | queryable; charts do not parse a growing file |
| `state.hours` | `water_hourly` | the buckets every rule reads |
| `state.notified` | `water_alerts` | cooldowns survive a restart, *and* it is the history the UI shows |
| `state.lastReading` | `water_collector_state` | baseline rehydrates on restart |
| `state.radioQuiet` | same table + heartbeat | lets the UI tell "collector down" from "collector deaf" |
| the `const` block | `water_settings` | tunable without a redeploy |

Hour keys stayed `'YYYY-MM-DDTHH'` in local time — the same shape `state.hours` used — specifically
so the rules ported across unchanged rather than being rewritten against a new model.

### Phase 3 — the two-process split ✅

The collector owns the radio and the alerts; the web server only reads. Modelled on how usat_apps
isolates `event_coi` on its own server, with the priority inverted: there, the web front door is
protected from a wedged browser; here, the background process is the one that matters.

Concretely: `npm run home_assist_build` can fail, the SPA can throw, the web server can be restarted
mid-deploy, and none of it interrupts leak detection.

### Phase 4 — the platform module ✅

`module.js` + `api.js` against the module contract. Six endpoints, every one panel-gated. The
`water` panel is granted by default; `water-admin` (settings + diagnostics) needs an explicit grant.

### Phase 5 — the dashboard ✅

Five pages. Ordered by what matters: the verdict first — a leak monitor whose answer you have to
hunt for has failed.

Chart decisions worth keeping:

- One series → one color. The overnight window is an **annotation band**, not a second series; a
  second hue would imply a second measure.
- **"No data" renders differently from "zero".** On a leak monitor those mean opposite things, and
  conflating them is how a dead receiver looks like a quiet night.
- Status colors always ship with an icon *and* a word.
- Drawn in measured pixels, not a stretched viewBox — the shortcut squashes axis labels into
  illegibility at phone width, which is exactly where this gets read.

### Phase 6 — live hardware validation ⬜ **next**

Not code. See `STATUS.md` § Needs hardware and `UBUNTU_DEPLOY.md` step 7. The watchdog test is the
one that matters most.

### Phase 7 — Ubuntu cutover ⬜

`UBUNTU_DEPLOY.md`. One env var of code change; the rest is host setup (DVB blacklist, an rtl_433
new enough to have protocol 223, no-sleep, pm2 startup).

### Phase 8 — threshold tuning ⬜

Needs a week of real nights. See `STATUS.md` open item 1.

## Explicitly not doing

- **Appliance-level disaggregation** ("that was the dishwasher"). Volume tracking is what catches a
  leak; identifying fixtures from a 1-gallon-resolution odometer is a research project with a much
  worse payoff.
- **Sub-gallon resolution.** The meter emits whole counts. Nothing downstream can be more precise
  than the source.
- **Automatic shutoff.** That is a valve, a plumber, and a much higher bar for false positives —
  a wrong alert costs an email; a wrong shutoff costs a flooded call to a plumber.
- **SSE / websockets for live updates.** A 5s poll on a LAN is free and fails obviously. The meter
  only broadcasts every few seconds anyway. `api.js` documents the upgrade path if it ever matters.
