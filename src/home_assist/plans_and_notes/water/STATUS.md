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
- **162.475 is this house's NOAA channel**, measured by the scan at +6.5 dB over a floor the other
  six sat within 2 dB of. It is the mode's default, overridable with `WATER_NOAA_CHANNEL`. Audible
  but rough: the 3-inch stub is a quarter wave at 916 MHz and only 16% of one at 162 MHz. A 46 cm
  whip would fix that -- but must NOT be left on, since 46 cm at 916 MHz is ~1.4 wavelengths and
  breaks the pattern into lobes. Telescoping antenna, extended for weather, collapsed for water.
- **Retuning raced libusb, not just the close handler.** Two bugs stacked. First: `switching = true;
  kill(); switching = false;` reset before 'close' fired a tick later, so a retune read as the radio
  dying. Second, and the one that survived the first fix: SIGTERM lets rtl_fm exit gracefully and
  libusb frees the interface some ms AFTER the process is gone, so the replacement lost the race
  with `usb_claim_interface error -6`. Now waits for 'close' plus a 400 ms settle, SIGKILL after
  1.5s, and a single-retune lock. The same wait applies on quit -- otherwise the collector restarts
  into the same error. Ctrl-C only appeared to work because the signal hit the whole process group.
- **The earlier close-handler race.** `switching = true; kill(); switching = false;` reset the
  flag before 'close' fired a tick later, so every keypress read as the radio dying and quit the
  session. Fixed by tagging the child itself (`me.retired`) -- identity cannot race.
- **`am` is airband, not AM broadcast.** 0.53-1.7 MHz is far below the R820T's ~24 MHz floor and
  needs a direct-sampling mod or an upconverter. The mode refuses a frequency below the floor and
  says why rather than tuning somewhere meaningless.
- **No `jq`.** The signal table formats itself. jq is not on Git Bash, and a command that only runs
  on one of the two machines is not a diagnostic.

Menu numbers are now assigned by position rather than written into each item, so inserting a section
no longer means renumbering by hand. Tests pin id uniqueness and that every advertised doc exists.

## Retention + the meter selector (2026-08-04)

**Every table now has a bound, and other people's meters have their own.**

| Table | Retention |
|---|---|
| `water_hourly` | **NEW** `hourly_retention_days`, default 0 = forever (~1 MB/meter/yr) |
| `water_readings` | `readings_retention_days`, default forever |
| `water_reception` | `reception_retention_days`, 14 |
| `water_packets` | `packets_retention_days`, 1 |
| `water_alerts` | `alerts_retention_days`, forever |
| `water_raw_samples` | `raw_sample_keep`, 500 rows |
| **any meter that is not ours** | **NEW** `observed_retention_days`, **45**, a CEILING over all of the above |

Three decisions worth keeping:

- **The hourly rollup has a floor, enforced twice.** It is the table every chart and every leak
  rule reads, so short retention there does not cost detail -- it stops the monitor being able to
  detect things. `check_continuous` needs six consecutive hours, the overnight rule needs last
  night, the daily summary needs yesterday. Values below 7 days are refused on save AND again inside
  `prune_hourly`, so a row edited straight into `water_settings` by hand cannot quietly disarm a
  rule. `min_nonzero` was added to the settings schema for this: `min` alone cannot express "0 means
  forever but 1 is invalid".
- **The observed ceiling can shorten but never extend.** It runs last in the sweep, after every
  per-table rule has had its say, so transmissions still expire at their own 1-day setting whatever
  it says. It is keyed by `meter_id <> owned` rather than by a flag, so there is no state to drift.
- **It refuses to run without an owned meter id.** A missing id would make `meter_id <> NULL` match
  nothing in SQL, which happens to be safe -- but relying on that subtlety, when the blast radius is
  deleting the history this app exists to keep, is not a design.

**The meter selector** replaced the This meter / All meters toggle in the Real time toolbar. Same
pill, same position, one more capability -- the UI shape did not change.

- New **`water_meters`** registry, populated automatically from the packet flush. It exists because
  `water_packets` is pruned within a day: a list derived from packets loses any meter that went
  quiet overnight, and options that come and go read as a bug rather than as reception.
- Carries `label`, `owned`, `collect_readings` and **`gallons_per_unit` per meter** -- classic Orion
  endpoints count 1 gallon, newer ones 0.1, and applying the wrong factor is a silent 10x error that
  looks entirely plausible on a chart.
- `?meter=` now accepts `mine`, `all`, or **a specific id**, resolved server-side into the same
  `(meter_id, scope)` pair the queries already took. No SQL changed.
- Decode rate, gaps and interval follow the SELECTION rather than always meaning "ours", so a
  neighbour's stats describe the neighbour instead of reporting a flat zero. On "all meters" they
  still mean your meter -- mixing several endpoints' arrival times into one median describes no real
  transmitter.
- Meters with no data are shown disabled with the reason, rather than offering a choice that
  produces an empty chart. An empty chart is indistinguishable from a broken one.

### Pass B -- the whole page follows the selection

The half-state is gone. Picking a meter used to change the Real time table while the banner, the
odometer, the four tiles and the clock above it silently kept describing your own house: one screen
about two different addresses, with nothing saying so.

| What changed | Why |
|---|---|
| **`/api/water/status`, `/meter`, `/hourly`, `/daily`, `/readings`, `/reception`** all take `?meter=` through the same `resolve_meter()` the packets endpoint already used | One resolver, one meaning. No SQL changed -- the queries were always per-meter |
| **Collector heartbeat is read from the OWNED meter's row regardless of selection** | "Receiver online" is a property of the process, not of the meter you are looking at. Read from a neighbour's row it would report the collector down the moment you selected one -- the most alarming thing this app can say, said wrongly |
| **Heartbeat chart reads `GREATEST(packets, packets_ours)`** | On a neighbour's row "ours" is zero by definition; the chart would have drawn a flatline, which on this chart means "the radio heard nothing" |
| **One `MeterPicker` component**, shared by Monitor, History and Diagnostics, in the same place on every tab | It used to live inside the Real time branch, so switching to Heartbeat silently reverted you to your own meter |
| **`meterSel.js`** -- selection is module state shared across pages, deliberately NOT persisted | Navigating between pages must not change which meter the numbers describe. But reopening the app tomorrow to a banner reading "All clear" about a house that is not yours is the one failure worth designing against |
| **"All meters" is table-only.** On Heartbeat, Long view and History it falls back to yours and says "showing yours" | Two houses' odometers cannot be summed into one line. Drawing one anyway under an "All meters" pill would be a chart that lies quietly |
| **Alert history does NOT follow the picker** | Alerts only ever fire for your meter. A filtered list would show empty, which reads as "no alerts" -- the opposite of "not applicable". The card says so when a neighbour is selected |
| **`backfill_observed_hourly()`** rebuilds observed meters' hourly totals from stored transmissions, on every collector start | Neighbours were captured as packets long before they were rolled up. Selecting one showed an empty history beside a live packet feed. `INSERT IGNORE`, so an hour the live path owns always wins and repeated starts cannot double-count |

**Display follows the picker; ACTION does not.** `ingest_other()` stores a neighbour's readings and
hourly totals and touches nothing else -- no `rules.`, no `alerts.`, no advance of the owned
baseline. Pinned by test, because this is the boundary that keeps a neighbour's shower from waking
you at 3am.

**Still owned-only, on purpose:** leak rules, every alert, the daily summary, and the raw-sample
card on Diagnostics (raw samples are the undecoded firehose -- filtering them defeats the card).

### Pass B.1 -- five things the first pass got wrong

Found by looking at the running server, which is the only place three of these could have shown up.

| Symptom | Cause | Fix |
|---|---|---|
| Banner said 3:32:34, the card said 3:32:30 and "9s ago" | The card read the odometer and last-heard off the newest row of the **packet array**; the banner read `/api/water/status`. Two sources, two poll intervals, both honest | Deleted the packet fallback. Status follows the selection now, so there is no reason for a second source -- and one source cannot disagree with itself |
| Every row of 14905174 badged **mine** | The cell renderer was handed `status.meter_id`, which now means "the meter in view" | `status.own_meter_id`. The stored `is_ours` column was always right; only the display was wrong |
| Diagnostics showed nothing for an observed meter | The reception chart and all four stats plotted `packets_ours`, which is **zero by definition** on a neighbour's row -- a flatline meaning "the radio heard nothing" | `/api/water/reception` now returns `packets_meter`; the chart and stats read it. Same bug the heartbeat chart had; this copy was missed |
| No numbers on the Long view bars | Never built | `showValues` on BarChart, with a 22px-per-bar floor so 90d and 365d drop the labels instead of overlapping them. Only **observed** bars get a number -- a `0` over a no-data stub erases the distinction the chart works hardest to keep |
| Alerts were owned-only | By design, but the wrong design | See below |

**Two of these were the same mistake:** letting one variable mean both "my meter" and "the meter in
view". That is the exact conflation Pass B existed to remove, reintroduced one argument at a time.
Both are now pinned by test.

### Pass B.2 -- alerts per meter

**Detection runs for every meter. Delivery does not.**

| Piece | Behaviour |
|---|---|
| `water_alerts.meter_id` | New column. Existing rows carry `0` -- written before alerts knew about meters, and stamping them with today's owned id would invent a fact. The API maps `0` to yours for display, which is honest: there was only one meter alerting then |
| **Cooldown ledger** | Now keyed `(meter_id, alert_key)`. **This is the dangerous one.** Keyed on `alert_key` alone, a neighbour whose overnight rule tripped first takes the slot and silences yours for six hours -- two houses sharing one mutex, and the failure is completely invisible |
| `water_meters.notify` | Defaults to **0**. `ensure_owned()` sets it to 1 for your meter on every boot, so it is true from first run rather than something to remember |
| `tick_observed()` | Same pure rules, each observed meter's own hour buckets, on the slow tick. `ingest_other()` on the packet path still touches no rule and no alert |
| **Receiver silent** | Never fires for an observed meter. Silence there means *this antenna lost them*, not *their pipe burst*. Guarded twice: `last_read_at: now` makes it unable to trip, and an explicit `kind === 'stale'` skip |
| Alerts page + Monitor card | Follow the picker. "All meters" is meaningful here -- unlike a usage chart, two meters' alerts can sit in one list without being summed into a lie |
| **Three delivery states, not two** | `✓ sent`, `✕ not sent` (a broken channel), and `◉ recorded only` (notify off). The last two render identically as a red cross unless separated, and one is the system working as designed -- conflating them teaches you to ignore the red ones that are real |

Only meters with `has_readings` get rules run over them. A meter with packets but no hourly rows
evaluates to a flat zero every hour, which the overnight rule correctly reads as "no water" -- true,
but not worth the queries.

### Pass B.3 -- one clock, labelled charts, and alerts that show their work

| What | Why |
|---|---|
| **One derived `lastPacketAt`**, used by the banner, the clock chip, the "since last packet" counter and the live chart edge | Three numbers an inch apart disagreed by four seconds. `water_collector_state` is stamped the instant a packet is decoded; `water_packets` is written by a batched flush and then fetched by a *separate* poll, so the table always trails. Both honest, one visible contradiction |
| When the packet table is on screen, **the newest row is the answer** | It is the thing you are looking at. A clock that disagrees with the row beneath it is worse than one that is two seconds conservative. Everything else falls back to state |
| `rtFocus`, not `rtPackets` | On "all meters" the newest row can be a neighbour's, and letting that set the banner would claim YOUR meter had just been heard when it had not |
| `PACKET_FLUSH_MS` 5000 → **2500** | Halves the residual skew. Still a batched INSERT -- a meter transmits every ~4s, so a flush carries 1-2 rows for a two-meter site |
| Value labels on the **Diagnostics** reception chart | Packets/minute is a small integer you compare against ~14, so the exact number is the point |
| **`per_hour` recorded on overnight and continuous alerts**, shown in a collapsed `<details>` | "Water ran overnight: 95 gal" is a *claim*. Every figure behind it was already computed and thrown away; now it is stored. An alert you cannot check is one you either believe blindly or learn to ignore. `null`, never `0`, for an hour with no reading |

259 tests pass, 58/58 files parse, SPA builds clean.

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
