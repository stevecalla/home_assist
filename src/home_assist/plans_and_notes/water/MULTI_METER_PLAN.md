# Multi-meter + per-user access — plan

A global meter selector every view obeys, neighbour meters visible as "Observed", and optional
per-user meter restriction.

Merges the master reference draft (`home_assistant_water_monitor.md`, 2026-08-16) with what has since
been verified against the code. **No code written yet — this is for approval.**

---

## 1. What changed since the draft

Three findings from reading the current schema and collector.

### The schema is already multi-meter

| Table | Key | Ready |
|---|---|---|
| `water_readings` | `idx_meter_time (meter_id, read_at_utc)` | **Yes** |
| `water_hourly` | `PRIMARY KEY (meter_id, hour_key)` | **Yes** |
| `water_reception` | `PRIMARY KEY (meter_id, minute_utc)` | Keyed — but see below |
| `water_packets` | `PRIMARY KEY (meter_id, heard_at_utc)` | **Yes, already storing every meter** |

Nothing is single-meter by design. What restricts the app today is **one filter in `ingest.js`**
against `WATER_METER_ID`, applied before anything is written. Phase 1 is opening a gate, not
reshaping a database — a materially smaller job than the draft assumed.

### `water_reception` has columns that will start lying

It is keyed per meter but its columns assume there is only ever one:

```
packets_total   every meter decoded, ours and neighbours
packets_ours    from our meter_id only
other_ids       other meter ids heard, for antenna work
```

Write a row per minute **per meter** and `packets_ours` silently becomes "packets for whichever
meter this row is about", while `other_ids` becomes the same list repeated on every row.

**Add a `packets` column with the honest per-meter count**, keep the legacy three populated only on
the owned meter's row, and move the Heartbeat query onto `packets`. A column whose meaning depends
on which row you are reading is the same class of bug as "no data" and "zero" rendering identically.

### Protocols 282/290 will only be partly heard, and that is physics

The draft's Phase 1 says enable `-R 223 -R 282 -R 290`. Necessary but **not sufficient**: 282/290
endpoints **frequency-hop**, and the collector runs a deliberately narrow fixed window —
`-f 916.45M -s 1600k`, which is 915.65–917.25 MHz. A hopping endpoint is only heard on the hops that
land inside it. Neighbour `40462356` was decoded, so some hops do land; coverage will be partial and
uneven, and packet counts for those meters will look like poor reception rather than a design limit.

The fix is widening or hopping, and both trade against the meter that actually matters — the
"explore wide, run narrow" rule in `RTL433_FIELD_GUIDE.md` exists precisely because widening costs
decode rate and CPU on the one meter you depend on.

**Recommendation:** enable 282/290, keep the window narrow, and **label partial coverage in the UI**
rather than widening. A second dongle is the honest fix if hopping endpoints matter later — it lets
one radio stay narrow on 916.45 forever.

---

## 2. Stack facts (filling section 6 of the draft)

| | |
|---|---|
| DB engine | **MySQL / MariaDB**, database `home_assist` |
| UI framework | **React** (Vite), ESM, hand-rolled inline-SVG charts — no chart library |
| API / server | **Express**, CommonJS, `server_home_assist_8050.js`, routes under `/api/water/*` |
| Existing auth | **Yes** — scrypt local users, signed cookie sessions, panel-level access via `panel_access.json` outside the repo |
| Collector | `collector_water.js` → `modules/water/collector/{rtl433,run,ingest}.js` |
| Readings tables | `water_readings`, `water_hourly`, `water_reception`, `water_packets`, `water_alerts`, `water_collector_state`, `water_settings`, `water_raw_samples` |

Section 7 of the draft — how to give Claude file access — is now moot; the repo is reachable.

---

## 3. Phases

Keeping the draft's structure, with the findings folded in.

| Phase | Delivers | Work | Size |
|---|---|---|---|
| **1 · Ingest all Orion** | Every Badger Orion in range produces data | Add `-R 282 -R 290`; **remove the single-meter gate in `ingest.js`**; per-model gallons scale (classic ×1, endpoint ÷10); per-meter retention | ~2 days |
| **2 · Meter registry** | One source of truth | `water_meters` table — id, label, model, scale, owned, collect_readings, first/last_seen, packets_seen. Auto-register on first hearing; backfill known ids; mark `16642655` owned | ~1 day |
| **3 · Global selector** | One picker | Dropdown: All + **Owned / Observed** groups; URL param `?meter=`; per-user default; `GET /api/water/meters` with has-data flags | ~1 day |
| **4 · Wire into views** | Selection works everywhere | All seven views; per-view "All" semantics; **every endpoint filters server-side** | ~3 days |
| **5 · Access control** | Per-user restriction | `meter_access.json` beside `panel_access.json`; `require_meter()` applied centrally; filtered dropdown; admin CLI | ~2–3 days |

Phase 5 was marked deferred in the draft. That still reads right — but see the note in section 6.

### The gallons scale is the trap in Phase 1

Classic ×1, newer endpoint ÷10. Get it wrong and a neighbour's usage is off by **10×** in a way
that looks plausible — a leak that is not there, or a real one hidden. This belongs in the registry
per meter, validated once against a known reading, never inferred at query time.

---

## 4. "All meters" semantics

The draft's table, with one clarification.

| View | Single meter | "All" |
|---|---|---|
| Real-time table | filter to id | one row per packet, mixed — **works today** |
| Real-time chart | one series | **deltas, never cumulative** |
| Heartbeat | that meter's reception | per-meter rows |
| Long view / usage | that meter's totals | **owned summed; observed shown separately, never summed** |
| History charts | that meter | multi-series |
| Alerts | that meter's alerts | all, but thresholds exist only where configured |
| Diagnostics | that meter's signal | per-meter |

**"Deltas, not cumulative" is the right call and worth keeping.** Odometers sit at unrelated absolute
values — 794,120 against 12,300 — so overlaying raw readings produces parallel lines whose spacing
means nothing but their serial numbers. Deltas are the only comparison that carries information.

Beyond three or four series it stops being legible whatever you plot. Cap it, or let the selector
multi-select rather than pretending "All" scales.

---

## 5. What I would add to the draft

### Retention on observed meters

Packets already expire (`packets_retention_days`, default 1). **`water_hourly` has no retention** —
8,760 rows per meter per year, kept forever. Turning on `collect_readings` for neighbours quietly
starts an indefinite archive of when other households shower, sleep and travel.

The draft's Phase 1 already says "retention per-meter", which is the right instinct. Make it
explicit: a `observed_history_days` setting, defaulted to something bounded, so the limit is a
setting rather than an intention. Owned meters stay unbounded.

Not a legal problem — it is your receiver in your house. It is a *decide-it-on-purpose* problem.

### Alerts stay owned-only, by construction

The draft has this right via "thresholds only where configured". Worth stating as a rule rather than
an emergent property: **an observed meter can never raise an email.** Emailing yourself about a
neighbour's leak is a decision with a doorstep conversation attached, and it should never arrive by
default.

### The meter list endpoint needs filtering too

Easy to miss in Phase 5. If the dropdown is populated from an unfiltered `GET /api/water/meters`, a
restricted user learns which meters exist and how many neighbours the receiver can hear — which is
itself information they were not granted. **Filter the list by the same rule that filters the data.**

### Meters with no data should be visibly unavailable

Grey them out with the reason inline — *"no readings collected"* — rather than letting someone select
one and get an empty chart. An empty chart is indistinguishable from a broken one.

---

## 6. Open decisions

| | Question | My lean |
|---|---|---|
| 1 | **Observed history retention** — bounded days, or keep forever like owned? | **Bounded.** Default 30 days |
| 2 | **Phase 5 order** — still deferred, or before phase 4? | Deferred is fine **unless** anyone but you will log in before phase 4 ships |
| 3 | **Widen the window for 282/290?** | **No.** Label partial coverage; a second dongle later if it matters |
| 4 | Labels/nicknames in phase 2 or later? | **Phase 2.** They cost nothing and turn nine-digit ids into something readable |

---

## 7. Cheapest useful slice

If you want something working before committing to all five phases: **phases 2 and 3 against the
data that already exists.** `water_packets` already holds every meter, so a registry plus a dropdown
gives you a working selector on the Real time table and chart — no ingest changes, no schema
rewrite, no retention decision. About two days.

That would let you use the control and find out whether the other views are worth the rest.
