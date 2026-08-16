# The water meter appliance — smallest, plug and play

A box an ordinary person plugs in, joins to their WiFi from a phone, and then opens in a browser to
see their water. No terminal, no SSH, no `.env`, no meter id typed in from a bill.

---

## The reframe

The hardware is the easy part. **"Plug and play" is almost entirely software work**, and it is work
that does not exist in the current build at all:

| The current build assumes | An end user needs |
|---|---|
| You SSH in | Nothing but a phone |
| You edit `.env` and know your meter id | The device finds the meter and asks which is theirs |
| You run `npm run db_init`, `home_assist_build`, `pm2_start_all` | It is already running when the light goes green |
| You know the LAN and can find an IP | A name that resolves, or a QR code |
| You `git pull` to update | It updates itself, safely, or never |

Budget accordingly: the hardware is a weekend, the plug-and-play is the project.

---

## Three sizes, honestly

| | **A · Pi 4/5** | **B · Pi Zero 2 W** | **C · ESP32 + CC1101** |
|---|---|---|---|
| Size | 85 × 56 mm board, ~120 × 80 × 40 mm cased | **65 × 30 mm board, ~90 × 45 × 25 mm cased** | Matchbox |
| Board cost | $55–60 | **$15** | ~$6 |
| BOM with radio, case, PSU, storage | ~$170 | **~$90** | ~$20 |
| Power | 5–8 W | **~2 W** | 0.3 W |
| Runs your repo unchanged | **Yes** | No — needs SQLite + a prebuilt SPA | No — decoder rewritten from scratch |
| Effort beyond onboarding | None | ~1 week | ~2 months |
| Honest verdict | Overkill for one meter | **The answer** | The eventual product, not the next step |

**B is the right target.** It is genuinely small, it is $15, and the code changes it needs are
bounded and worth making anyway.

C is where this goes if it ever becomes a product — a $6 microcontroller with a $3 radio, no Linux,
no SD card, boots in a second. But it means reimplementing protocol 223's FSK sync, framing and CRC
against `rtl_433`'s decoder as the reference. That is real engineering, and it should not be attempted
until people are actually using B.

---

## What B looks like

```
   ┌────── 90 × 45 × 25 mm ──────┐
   │                             │
   │  Pi Zero 2 W                │──── short USB ──── RTL-SDR ──── SMA ──── antenna
   │  Linux · rtl_433 · SQLite   │     (or internal, shielded)
   │  Node · SPA · WiFi          │
   │                             │
   └─────────────────────────────┘
         USB-C 5 V           ● status LED
```

| Part | | ~Cost |
|---|---|---|
| Pi Zero 2 W (WiFi built in) | | $15 |
| RTL-SDR (Nano/dongle) | | $30 |
| 32 GB A2 microSD | see the wear note | $9 |
| USB-C PSU, 5 V 2.5 A | | $9 |
| Case, pigtail, SMA antenna | | $25 |
| **Total** | | **~$88** |

Everything a person touches: a power lead and an antenna that screws on.

---

## What "plug and play" actually requires

Five pieces. None are hard individually; together they are the product.

### 1. WiFi onboarding without a keyboard

The classic consumer-IoT problem, and where most support tickets will come from.

The device boots, finds no saved network, and **becomes an access point** — `WaterMeter-A4F2`. The
user joins it from a phone, a captive portal opens automatically, they pick their network and type
the password. The device saves it, drops the AP, joins the network. If it ever cannot reconnect, it
falls back to AP mode rather than sitting there dark.

`comitup` and `RaspiWiFi` do this on Raspberry Pi OS and are worth using rather than writing. Test
the reconnect-failure path specifically — it is the one that gets skipped and the one that strands
devices when someone changes their router.

### 2. Meter discovery, not configuration

**This is the piece that most changes the current design.** Today the meter id lives in `.env`
because you knew yours. An end user does not, and never will.

On first run the device listens for a few minutes and shows every Orion it heard:

```
   Meters heard near you
   ───────────────────────────────
   ●  16642655    strong    12/min
   ○  14905174    weak       2/min
   ○  49799708    weak       1/min
```

Then it asks them to prove which is theirs: **run an outside tap for two minutes.** The device
watches which odometer moves and pairs to it. That is the same run-a-tap idea from the neighbourhood
plan, and it does the same double duty — it identifies the meter *and* it means nobody's meter is
ever monitored without someone physically turning their own tap.

If two candidates move, **refuse and ask again.** Pairing to the wrong meter shows a household
someone else's water, which is the worst thing this device can do.

### 3. It is already running when the light goes green

No `db_init`, no build step, no pm2 commands. The SD image ships with everything installed, the
schema created and the SPA already built. First boot does WiFi and pairing, nothing else.

A single status LED carries the whole state, because a person will not read logs:

| LED | Means |
|---|---|
| Slow blue pulse | Waiting for WiFi setup — join `WaterMeter-xxxx` |
| Fast blue | Connecting |
| Amber | Connected, listening, no meter paired yet |
| **Steady green** | Working. Hearing your meter |
| Red | Not hearing the meter for over an hour — move the antenna |

That red state matters more than it looks. **Silence must never read as safety** — the same rule the
watchdog exists to enforce, expressed in a lamp.

### 4. Findable

`http://watermeter.local` via mDNS covers most cases, and a QR code on the case pointing at the same
name covers the rest. Serve on **port 80**, not 8050 — an end user should never type a port.

Tailscale is a great option for the technical minority and should stay optional. It is not something
to walk a stranger through.

### 5. Updates that cannot brick it

Two partitions, install to the inactive one, flip, and roll back automatically if the new one fails
to come up healthy. Or genuinely never update. **Do not ship `git pull` on a timer** — a bad update
in a house you cannot visit is unrecoverable, and this is a device whose failure mode is a flooded
basement.

---

## Code changes for B

Bounded, and all of them improve the project regardless.

| Change | Why | Size |
|---|---|---|
| **MySQL → SQLite** | 512 MB cannot host MariaDB alongside Node. The schema is simple and there is no concurrent-writer problem — one collector, one reader | ~2 days. `mysql2` → `better-sqlite3`, dialect fixes in the schema and stores, tests should mostly pass untouched |
| **Prebuild the SPA into the image** | Vite on a Zero is painful. Build on a laptop, ship `dist` | Hours |
| **Meter pairing flow** | Replaces `WATER_METER_ID` in `.env`. New first-run UI plus a "which id moved" matcher | ~3 days |
| **Status LED daemon** | Reads collector state, drives a GPIO LED | A day |
| **WiFi onboarding** | Integrate `comitup`, test the failure paths | ~2 days |
| **Image build script** | Reproducible SD image, or it is not a product | ~2 days |

Roughly **two weeks** to something you could hand to a neighbour without instructions.

Everything else is untouched: `leak_rules.js`, `ingest.js`, the collector, the dashboard, the alert
email, every test. The pure layers port because they were kept pure.

---

## The two things that will bite

**SD card wear.** ~17,000 packet rows a day plus MariaDB journal plus logs kills consumer microSD in
months, silently, as corruption. On a Zero you cannot boot from SSD, so instead: default
`packets_enabled` to **off**, keep `water_reception` (one row a minute) and the hourly rollups, add
`log2ram`, and mount the DB with less aggressive syncing. The Real time tab becomes an opt-in
diagnostic rather than something running permanently.

**The Pi is an RF noise source.** Everything measured tonight on medium wave applies here one band
up. Keep the SDR on a short pigtail with the antenna outside the case, and if reception is worse than
the laptop's, suspect this before the antenna.

---

## Sequence

| | Do | Answers |
|---|---|---|
| 1 | Buy a Zero 2 W. Install the stack by hand, SQLite swap included. Point it at your meter | Does a $15 computer keep up with 1.6 Msps and the collector? |
| 2 | Run it beside the laptop for 48 h, compare decode rates | Is reception as good? |
| 3 | Build the pairing flow and the LED | Can you set it up without touching a terminal? |
| 4 | Onboarding + image build | Can someone else? |
| 5 | Give one to a neighbour and say nothing | **The only test that counts** |

**Step 1 is the gate and it is one evening.** If a Zero 2 W cannot run the collector at 1.6 Msps with
headroom, everything above is moot and the answer is a Pi 4 at twice the size. Measure before
committing — `ps -eo pcpu,comm --sort=-pcpu` on the Zero tells you in a minute, exactly as it did on
the Latitude tonight.
