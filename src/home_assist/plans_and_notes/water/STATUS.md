# STATUS — water module

Snapshot of what's built and what's next. Platform-level status is in `../STATUS.md`.

Last updated: 2026-08-01 (Real time tab, per-packet capture, sortable grid, metric tooltips).

## What it is

The Badger Orion leak monitor, ported from the standalone `monitor.mjs` into the platform as the
first module. Two processes:

- `collector_water.js` — rtl_433 → sanity guards → MySQL → leak rules → email. **Must never stop.**
- the `water` module inside `server_home_assist_8050.js` — reads MySQL, serves `/api/water/*`.

## Routes

| path | panel | what |
|---|---|---|
| `/water/monitor` | `water` | verdict banner, tiles, the **meter card** (Heartbeat / Long view), 48h bars, recent alerts |
| `/water/history` | `water` | hourly (24/48/72/168h) + daily (14/30/90d), table toggle |
| `/water/alerts` | `water` | full alert history with delivery status |
| `/water/settings` | `water-admin` | every threshold, email config, test alert |
| `/water/diagnostics` | `water-admin` | raw decoder lines, SMTP verify, recent readings, live reception |
| `/water/reference` | `water` | alert schedule, delivery, retention — read from the running config |

## Done

**Rules** (`rules/leak_rules.js`) — pure functions, ported one-for-one from `monitor.mjs`:

- `check_overnight` — usage between 2am and 5am over threshold.
- `check_run_alarm` — one unbroken run past `run_alarm_min` (60) OR `run_alarm_gal` (100). The
  FAST signal: minutes, not six hours. Keyed on the run's start time rather than a time bucket, so
  one leak is one email. Added 2026-08-01; before that the run meter was dashboard-only and a
  daytime leak had a six-hour blind spot on the alerting path.
- `check_run_cleared` — the all-clear when an alarming run stops. Informational.
- `check_continuous` — water in *every* hour for 6 consecutive hours. NOT redundant with the run
  alarm: a fill valve cycling every few minutes resets the run timer and is only visible here.
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
| `water_readings` | one row per **gallon used** -- ~200/day, ~73k/yr, **~4 MB/yr** | `readings_retention_days` (default 0 = keep) |
| `water_hourly` | fixed **8,760 rows/yr** (~1 MB/yr) regardless of usage | never pruned -- it is what every chart and rule reads |
| `water_reception` | **1,440 rows/day**, written every minute whether or not water moves | `reception_retention_days` (default 14) -- settles at ~20,160 rows and stops growing |
| `water_alerts` | a few hundred a year | `alerts_retention_days` (default 0 = keep) |
| `water_collector_state` | one row, upserted | n/a |
| `water_settings` | ~30 rows | n/a |
| `water_raw_samples` | diagnostic buffer | `raw_sample_keep` (default 500), swept hourly |

`water_reception` is the only table that grows on a **timer** rather than on usage, which is exactly
what makes it able to prove the radio is alive during a flat line -- and exactly why it is the only
one with a hard, always-on prune. The Reference panel says all of this in the UI, sourced from the
same settings rows.

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

## The Monitor redesign (2026-08-01)

The Monitor page was rebuilt around one question: *is water running right now, and am I even being
read?* The pieces, and why each exists:

| piece | what it is | why |
|---|---|---|
| **Meter card, Heartbeat mode** | per-minute odometer line + a green packet pulse, up to 72h, from `water_reception` | a flat reading with a healthy pulse means nobody used water; a flat reading with a **flatline** means the number on screen is stale. Those look identical on any single-line chart |
| **Meter card, Long view** | daily bars over any range, from `water_hourly` | past 72 hours per-minute rows are unreadable, and the rollup is the honest answer |
| **Run bands** | coloured spans where a continuous run happened (`run_spans`) | at 72 hours you need to see *when* it happened, not only that it is happening now |
| **Collapsible cards** | every card collapses; all start closed **except the meter** | the meter is why the page exists. Everything else is context you go looking for |
| **CardTools** | Expand / PNG / CSV per card, ported from usat_apps' merge panel | same toolbar, same behaviour as the other app |
| **SqlPanel** | the exact SQL each chart ran, built server-side from the same parameters | a chart you cannot reproduce is a chart you cannot argue with |

Two bugs found and fixed while verifying it:

1. **`reception_series` capped at 1440 minutes while the API allowed 72 hours.** Asking for 72h
   silently returned 24h -- the chip said 72h, the axis drew a day, nothing failed. Pinned by
   `tests/window_caps.test.js`, which asserts the two ceilings agree.
2. **PNG export painted every water colour `#888`.** `CardTools` resolved CSS variables against
   `document.documentElement`, but the water palette is scoped to `.w-root` so it cannot leak into
   another module -- so every lookup returned empty and fell back to grey. The overnight band, a 5%
   tint on screen, exported as an opaque slab. Now resolved against the chart's own element.

A third was designed out rather than fixed: the chart downsamples to one column per ~2px, and the
packet aggregate is **MIN over the bucket**, not average. A one-minute outage inside a four-minute
bucket still draws a flatline. On a monitor the worst minute is the one worth seeing.

## The Real time tab (2026-08-01)

A third mode on the meter card, backed by a new `water_packets` table: one row per decoded
transmission, every meter in range, bounded by a short prune rather than by usage.

| piece | what | why |
|---|---|---|
| `water_packets` | InnoDB, DATETIME(3), PK (meter_id, heard_at_utc) | sub-second ordering is the point; whole seconds collide at a 4s cadence |
| Capture scope | every Badger Orion packet, ours and the neighbours | a neighbour at a fixed distance is a free reference signal for antenna work |
| Counting scope | UNCHANGED -- our meter only | a neighbour must never advance an odometer or raise an alert. A test pins the ordering |
| Flush | its own 5-second timer | not the 60s tick; a live view fed by a once-a-minute write is not live |
| Chart | odometer at exact seconds, SNR per packet, one tick per packet, gap bands | an SNR dip before a gap is a path problem; a flat trace across one is not |
| Grid | sort, filter, freeze, paginate, row numbers, reset, red arrival flash | every column carries a definition served from the API |
| Signal bands | STRONG / OK / WEAK / POOR from `rules.SIGNAL_QUALITY` | one source for the badge, the scoreboard and the Reference page |

Bugs found on live hardware, each one invisible in replay mode:

1. **`integrity` and `freq_mhz` were always NULL.** The code read `Integrity` -- our own synthetic
   replay meter's field name. rtl_433 says `mic`. Frequency arrives as `freq1`/`freq2` for an FSK
   protocol. Both are now read tolerantly.
1b. **`-M freq` was added to DEFAULT_ARGS and it is not a real flag.** `rtl_433 -M help` lists
   `time|protocol|level|noise|stats|bits` and nothing else, and says plainly that `level` adds
   *Modulation, Frequency, RSSI, SNR and Noise*. Passing the bogus value is not ignored -- the run
   comes back with **no** signal metadata at all, which presents as a dead antenna rather than a bad
   flag. Removed from DEFAULT_ARGS, pinned by a test. If a machine's `.env` still carries it,
   `WATER_RTL433_ARGS` overrides the default and the columns stay blank.
2. **Packets reached MySQL once a minute.** The buffer flushed inside `tick()`. The browser polled
   every 4s and correctly showed nothing for 56 of them.
3. **Row keys included the array index.** One arrival at the top changed every key below it, so
   React remounted the whole table each poll and new-row detection saw all 200 rows as fresh.
4. **`type: 'bool'` had no branch in `coerce()`.** A bool fell through to `String(raw)`, and "0" is
   truthy -- so a switch saved as off read as on, and no boolean setting could be turned off at all.
   Settings now renders a real switch instead of a number box.
5. **The decode rate divided by the window, not the coverage.** Enable recording, open the 24h view
   three hours later, and it reported 13.9% -- which reads as a failing antenna when the real answer
   was "we have been recording for three of these twenty-four hours". It now measures over the span
   actually recorded and the label reads `decoded since 15:36` when the window is only partly covered.

Known gap, deliberately not built: `gap_spans` only sees silences BETWEEN two packets, so a
trailing silence -- the one happening right now -- is not in the gaps list. The `since last packet`
counter covers that case and turns red, which is the more visible place for it.

## Listening to the radio directly (2026-08-02)

Menu section **RADIO — listen to it yourself** (items 11-21), backed by
`modules/water/listen.js` and documented in `RTL433_FIELD_GUIDE.md` in this folder.

| Item | Window (MHz) | Hears |
|---|---|---|
| Listen — MY meter | 915.650 - 917.250 | our meter only, readable console |
| Listen — the neighbourhood | 914.488 - 915.512 | everything nearby EXCEPT ours -- deliberately |
| Listen — neighbourhood + mine | 914.800 - 917.200 | both, for antenna comparisons |
| Listen — hop the WHOLE band | 901.8 - 928.2, 2.4 at a time | discovery sweep, 13 hops x 20s, ~4 min |
| Signal figures | 915.650 - 917.250 | per-packet rssi/snr/freq + running mean, formatted in Node |
| Protocol 223 present? | -- | `-R help`, no dongle needed |

Three decisions worth keeping:

- **The wrapper stops and restarts the collector.** The dongle has one owner. Doing this by hand
  means remembering to restart it, and the failure mode of forgetting is silent -- an unmonitored
  house that looks fine. The restart is wired to both `close` and `exit`.
- **The narrow survey is a feature.** `-f 915M -s 1024k` cannot reach 916.45, so traffic on it
  proves dongle, driver, USB and antenna are all fine while our meter is silent. A test pins the
  window below the meter so nobody "fixes" it.
- **The sweep is discovery, not monitoring.** 26 MHz of ISM band against a 2.4 Msps ceiling means
  13 hops, so any one slice is heard 8% of the time and absence proves nothing. Hops are spaced
  2 MHz for a 2.4 MHz window so the joins overlap rather than landing on the filter rolloff. Tests
  pin both ends of the band and the minimum overlap.
- **Analogue audio is a separate script** (`modules/water/audio.js`, items 16-18). Different binary
  -- `rtl_fm`, not `rtl_433`, which has no audio path at all. It is here because hearing a local FM
  station is the most convincing proof the dongle, USB path, driver and blacklist all work; a decode
  count of zero has a dozen causes, audible silence has few. `--record N` writes a plain `.wav`,
  header built in Node with no ffmpeg/sox/aplay dependency, because audio played on a headless box
  comes out of a speaker in another room.
- **`weather` is the analogue mode that earns its keep.** NOAA Weather Radio, 162.400-162.550, is a
  continuous voice broadcast carrying severe-weather alerts and it works when the internet does not.
  It needed a third demodulator: `fm` is wideband at 200 kHz and renders a 25 kHz NOAA channel as
  faint hiss; `am` is wrong outright. Not an ALERTING path -- SAME decoding would mean holding the
  dongle full time, which is a second-dongle decision, not a software one.
- **Live retuning, and a scan before it.** Every audio mode asks for a frequency (Enter takes the
  default) and accepts `n`/`p`/`1-7` while playing to retune without restarting -- the collector is
  stopped ONCE for the session, only rtl_fm and the player are rebuilt per tune. `audio.js scan`
  uses `rtl_power` to rank all seven NOAA channels in one 6s sweep, because squelch is off by design
  and an empty channel sounds identical to a live one with dead air. Noise floor is the MEDIAN of
  the bins, not the mean -- a strong carrier drags a mean up and hides itself.
- **The scan shipped broken and the fix is the interesting part.** First version used a 190 kHz span
  and auto gain, and returned 0.0 dB of variation across every bin -- which it printed as "nothing
  on any channel". A narrow span makes rtl_power degenerate; auto gain lets the AGC normalise away
  the contrast being measured. Now 1 MHz at fixed `-g 40`, plus a GUARD: spread under 1.5 dB is
  reported as "this sweep did not measure anything", never as a finding. Plus `scan fm` as a control
  -- broadcast FM is the loudest thing in civilian radio, so if THAT sweeps flat the rig is broken.
  Without a control, "nothing found" is unfalsifiable.
- **Retune raced with the close handler.** `switching = true; kill(); switching = false;` reset the
  flag before 'close' fired a tick later, so every keypress read as the radio dying and quit the
  session. Fixed by tagging the child itself (`me.retired`) -- identity cannot race.
- **`am` is airband, not AM broadcast.** 0.53-1.7 MHz is far below the R820T's ~24 MHz floor and
  needs a direct-sampling mod or an upconverter. The mode refuses a frequency below the floor and
  says why rather than tuning somewhere meaningless.
- **No `jq`.** The signal table formats itself. jq is not on Git Bash, and a command that only runs
  on one of the two machines is not a diagnostic.

Menu numbers are now assigned by position rather than written into each item, so inserting a section
no longer means renumbering by hand. Tests pin id uniqueness and that every advertised doc exists.

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
