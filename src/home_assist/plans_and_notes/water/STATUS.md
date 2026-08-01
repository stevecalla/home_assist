# STATUS — water module

Snapshot of what's built and what's next. Platform-level status is in `../STATUS.md`.

Last updated: 2026-08-01 (live hardware; three bugs found from the real tables — see Verified on real hardware).

## What it is

The Badger Orion leak monitor, ported from the standalone `monitor.mjs` into the platform as the
first module. Two processes:

- `collector_water.js` — rtl_433 → sanity guards → MySQL → leak rules → email. **Must never stop.**
- the `water` module inside `server_home_assist_8050.js` — reads MySQL, serves `/api/water/*`.

## Routes

| path | panel | what |
|---|---|---|
| `/water/monitor` | `water` | verdict banner, receiver strip, tiles, 48h chart, recent alerts |
| `/water/history` | `water` | hourly (24/48/72/168h) + daily (14/30/90d), table toggle |
| `/water/alerts` | `water` | full alert history with delivery status |
| `/water/settings` | `water-admin` | every threshold, email config, test alert |
| `/water/diagnostics` | `water-admin` | raw decoder lines, SMTP verify, recent readings |

## Done

**Rules** (`rules/leak_rules.js`) — pure functions, ported one-for-one from `monitor.mjs`:

- `check_overnight` — usage between 2am and 5am over threshold.
- `check_continuous` — water in *every* hour for 6 consecutive hours.
- `check_watchdog` — no readings for 90 min. The important one.
- `daily_summary` — the 8am proof-of-life.
- `status` — the same rules phrased for the dashboard banner, ignoring cooldowns.

**Ingest guards** (`collector/ingest.js`) — also pure: field extraction tolerant of decoder
variants, meter-id filtering, backward readings, counter rollover, and the impossible-jump filter
that must *not* advance the baseline.

**Collector** (`collector/rtl433.js`, `collector/run.js`) — live spawn with exponential-backoff
restart, plus a replay source (captured `.jsonl` or a synthetic meter) so the UI can be built and
the rules exercised with no dongle attached.

**Preflight** (`collector_water.js --check`) — MySQL, email, the resolved settings, that
`WATER_RTL433_CMD` actually resolves (file-exists for a path, PATH lookup for a bare name), and that
the build includes **protocol 223**. The last two matter because the command is now a bare `rtl_433`
resolved from PATH: a PATH that works in your shell but not under pm2 or systemd is a classic silent
failure, and an apt rtl_433 without the Orion decoder looks exactly like bad reception.

**Storage** — `water_readings`, `water_hourly`, `water_alerts`, `water_collector_state`,
`water_settings`, `water_raw_samples`. Two improvements over the JSON-file version, both about
restarts: cooldowns are queried from `water_alerts` rather than held in memory, and the baseline is
rehydrated from the DB so gallons used while the collector was down are not silently dropped.

**Alerts** — email primary (wrestling_stats nodemailer pattern), ntfy optional and off by default.
Per-alert delivery outcome is recorded and shown; "raised" and "delivered" are different facts.

**UI** — five pages, responsive, light/dark. Charts are hand-rolled inline SVG (`BarChart.jsx`) —
one series, one color; the overnight window is an annotation band, not a second series; "no data"
renders differently from "zero" because on a leak monitor those mean opposite things.

## Verified (2026-08-01, agent env)

- All three leak rules and the ingest guards unit-tested — 125/125 pass overall, ~1s, no DB/radio.
- Full ingest path against live MySQL with a replayed meter: readings → hourly buckets → collector
  state → API → dashboard, correct in light, dark, and mobile.
- Overnight, continuous-flow, and watchdog rules all confirmed firing and not firing at the right
  boundaries.

### Bug found and fixed during verification

The rate filter divided delta by elapsed minutes with no floor. The meter broadcasts every few
seconds, so a legitimate +1 gal arriving one second after the previous packet computed to 60 gal/min
and was rejected — and because a rejected reading deliberately does not advance the baseline, the
*next* packet looked worse than the last, and the collector went **permanently deaf**.

Inherited from `monitor.mjs`, where real inter-packet gaps (~3s) mostly kept it under the limit —
so it would have shown up in production as intermittent, unexplained silence.

Fixed with `min_rate_window_min` (default 1 min) clamping the denominator, plus two regression tests
pinning both directions: rapid legitimate readings accepted, genuinely corrupt jumps still caught.

## Verified on real hardware (2026-08-01, Windows laptop + Nooelec)

First live decode at 00:38:35 local: `{"model":"Badger-ORION","id":16642655,"volume_gal":794120,
"mic":"CRC"}`. The collector is running under pm2, hearing our meter on 916.45 MHz, protocol 223,
one packet every ~4 s.

### Three bugs found from the live tables

**1. `volume_gal` — every packet decoded and was then silently discarded.** rtl_433 renamed the
Badger ORION fields between builds (`Volume`→`volume_gal`, `Integrity`→`mic`, `Flags-1`→`flags_1`).
The extractor only knew the older names, so it returned null for every single packet: meter working,
radio working, decoder working, collector "healthy", nothing recorded. Fixed by putting `volume_gal`
first in `VOLUME_FIELDS`, plus a named-error fallback so the *next* rename surfaces as
`CANNOT READ VOLUME from our meter: unrecognised volume field "x"` rather than as silence, plus a
unit guard that refuses `volume_m3`/`volume_l` rather than reading them as gallons (a 264× error
that would look like a catastrophic leak).

**2. The `no_volume` diagnostic logger had no cap.** `if (raw_logged <= RAW_SAMPLE_LIMIT)` — but
`raw_logged` stops incrementing at the limit, so the test stayed true forever. 449 rows in 35
minutes, on course for ~19,000/day. Now rate-limited to 10/hour like the rejected-packet path.

**3. A quiet hour was indistinguishable from a dead receiver.** `bump_hour` ran only when
`delta > 0`, and an hour's row existing is the ONLY thing that marks it `observed`. So an hour in
which the collector heard the meter 900 times and nobody ran a tap wrote no row at all — rendering
as "(no data)" on the chart and read as *missing* by `check_continuous` and `check_overnight`.
A perfect night and an unplugged dongle produced identical output.

This is the exact failure the "no data ≠ zero" rule exists to prevent, and it survived the whole
build because replay mode always has flow. Fixed by extracting `ingest.reading_effects(verdict)` —
a pure function returning `{insert, bump_hour, advance}` — so the invariant is pinned by five tests
instead of by a comment. `bump_hour` now fires on every *trusted* packet (accept, baseline,
backward, rollover) and not on rejected ones; `insert` still requires real flow.

Row present + 0 gal = we were listening, nothing moved. No row = we were not listening.

### Still true and worth remembering

`water_readings` staying empty during a quiet period is **correct** — one row per gallon used, and
the odometer only moves when water flows. `water_hourly` is different after fix 3: it now gets a row
per hour with `gallons = 0` and a rising `reading_count`, which is how the app knows it was
listening.

`reading_count` therefore now means **packets heard in that hour** (~900), not "readings that
carried flow". That is the more useful number, and it is what makes an hour's absence meaningful.

In the collector log, the 5-minute `radio ok — N packets in 5m` heartbeat is what distinguishes a
quiet house from a dead process; before it existed, "working perfectly" and "died an hour ago" looked
identical in `pm2 logs`.

## Needs hardware (cannot be done from the agent env)

1. **Live rtl_433 capture.** Replay exercises the identical ingest path, but not the radio.
   `node src/home_assist/modules/water/capture.js 10` — see `HARDWARE.md`.
2. **Email delivery.** `EMAIL_PASSWORD` in `.env` is a placeholder; it needs a Gmail **app**
   password (generated under 2-factor auth). `node collector_water.js --check` reports the state, and
   Diagnostics → *Verify SMTP* checks it from the UI.
3. **Reception at the permanent antenna location** — the thing most likely to decide whether this
   works at all. See `HARDWARE.md` § Reception.
4. **The watchdog end-to-end test.** Stop the collector, confirm the *receiver silent* email arrives
   and the dashboard flips to offline. See `UBUNTU_DEPLOY.md` step 7.

## Data growth & retention

Asked and measured rather than assumed — `node src/home_assist/modules/water/report.js dbsize`
prints this live, projected from readings actually observed:

| table | growth | bounded by |
|---|---|---|
| `water_readings` | one row per **gallon used** — ~200/day, ~73k/yr, **~4 MB/yr** | `readings_retention_days` (default 0 = keep) |
| `water_hourly` | fixed **8,760 rows/yr** (~1 MB/yr) regardless of usage | never pruned — it is what every chart and rule reads |
| `water_alerts` | a few hundred a year | `alerts_retention_days` (default 0 = keep) |
| `water_collector_state` | one row, upserted | n/a |
| `water_settings` | ~20 rows | n/a |
| `water_raw_samples` | diagnostic buffer | `raw_sample_keep` (default 500), swept hourly |

So the answer is roughly **5 MB a year**, and the defaults keep everything — deliberately, since
losing history to save 5 MB is a bad trade.

### The bug this question found

`water_raw_samples` had a real unbounded path. Rejected packets were logged one row per packet with
no cap, and `prune_raw` ran **only at collector startup**. A radio producing continuous garbage
would have written ~28,000 rows of up to 4KB per day — ~100 MB/day — and a collector that stays up
for months would never have pruned. The diagnostics for the failure would have taken the disk down
before the failure did.

Fixed:

- `rate_limit.js` — a pure "N per window" limiter; rejected-packet logging is capped at **10/hour**,
  with the suppressed count reported once on the next window (`+4,812 more suppressed`).
- The retention sweep moved into the tick, running **hourly**, not once at startup.
- `raw_sample_keep`, `readings_retention_days`, `alerts_retention_days` added to Settings.
- `report.js dbsize` so the question is answerable from the machine rather than from a guess.

Verified end to end: with `max_gal_per_min` forced to 0.01 so every packet is rejected, ~40 rejected
packets over 40s produced exactly **10 rows** and 10 log lines.

## Open items

1. **Tune `overnight_threshold_gal`.** Currently 3 gal, which is a guess. An ice maker, a
   water-softener regen cycle, and any recirculation pump all draw water overnight and none is a
   leak. Watch a week of clean nights on the History page, then set it just above the noise floor —
   from the Settings page, no redeploy.
2. **Cross-check the 1 gal/count calibration against the dial** on the next pit visit. Every number
   downstream is denominated in it.
3. **Pick a random `NTFY_TOPIC`** if you want phone push in addition to email, and set
   `alert_ntfy_enabled` to 1.
4. **Decide the continuous-flow window.** 6 hours is inherited from `monitor.mjs`. Once there is a
   week of real data, check whether anything legitimate (irrigation? a humidifier?) trips it.

## Ideas, not commitments

- **Cost estimate on the dashboard** — gallons × the Boulder tariff, so an overnight leak shows up in
  dollars. Probably the single change most likely to make the number feel real.
- **Weekly digest email** — the daily summary is per-day; a Sunday roll-up with the week's shape
  would surface a slow creep the daily one hides.
- **Away mode** — a flag that drops the overnight threshold to near-zero while nobody is home, where
  *any* flow is suspicious. Cheap to add; the rules already take thresholds as arguments.
