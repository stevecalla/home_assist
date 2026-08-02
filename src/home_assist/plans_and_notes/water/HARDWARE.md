# HARDWARE — the meter, the radio, and how we know

Everything here was established on real equipment, not from documentation. Where a fact was
guessed and later corrected, the correction is noted — those are the ones that cost time.

## The approach, and what was rejected

**Chosen:** read the utility water meter's own 900 MHz AMR broadcast with a cheap RTL-SDR dongle,
decode in software, run leak logic on top. No plumbing work, no permission needed, no cloud service.

Rejected, with reasons:

| Option | Why not |
|---|---|
| DIY clamp-on ultrasonic | A months-long analog project. |
| ESP32-CAM OCR of the dial | The meter is in an outdoor pit — no power, no wifi. |
| Inline turbine | Cutting the pipe, plus a wear part. |
| Droplet / Flume / Moen Flo | Works, but the DIY route was the point. |

## The dongle

**Nooelec NESDR SMArt v5** (RTL2832U + R820T2), ~$40. Working.

## The meter

- **Badger Orion**, pit transmitter, FCC ID **GIF2006B** — the older "classic" model. Identified
  from a photo of the endpoint in the pit.
- Boulder uses drive-by AMR, so it bubbles up continuously — roughly every few seconds, not on
  demand.

### Radio id: `16642655`

**This is not the serial printed on the endpoint** (~857xxxxx). That mismatch is the single most
time-consuming thing about this project, and the reason `capture.js` exists: the only reliable way
to find the id was a hose test — run water, watch which decoded id's volume moves.

A neighbour has a newer frequency-hopping Orion, id `40462356`, model `Orion-Endpoint`. If a capture
shows that id, it is not ours.

### Decoder

- **rtl_433**, protocol **223** — "Badger ORION water meter, 100kbps".
- **Fixed 916.45 MHz.** The classic Orion does *not* frequency-hop. Protocols 282/290 are for the
  newer hopping endpoints — using them here decodes nothing.
- **rtlamr cannot decode this meter at all.** It handles Itron ERTs (which is what the neighbours'
  gas and electric meters are, and why they decode so easily), not Badger Orion.

```bash
rtl_433 -f 916.45M -s 1600k -R 223 -F json
```

Human-readable output (drop `-F json`) shows: `model`, `ID`, `Flags-1`, `Volume`, `Flags-2`,
`Integrity: CRC`. Only **`Volume`** (the odometer) and **`Integrity`** (CRC — trust it) matter. The
flags are undocumented for the classic decoder; don't build on them.

### Calibration: 1 count = 1 gallon

Hose test, 2026-07-31: `Volume` rose 794113 → 794120 (7 counts) during ~6 minutes of kitchen faucet
(~7 gal). Solid, but **not yet cross-checked against the dial odometer** — worth doing on the next
pit visit, because everything downstream is denominated in this number.

## Reception

This is the part that decides whether the project works, and it is not a software problem.

- Strong Itron ERTs (the neighbours' gas/electric) decode easily from indoors.
- Our Orion is **weaker**: curbside pit, metal lid. It did decode from indoors during testing, but
  "it worked once" is not a 24/7 guarantee.
- For permanent use, the antenna wants to sit **at a window facing the pit**.
- **Extend USB, not coax.** A USB extension moves the whole dongle to the glass while the computer
  stays put. Coax is lossy at 915 MHz, so extending the antenna side throws away signal you cannot
  get back.

### Listening yourself

`RTL433_FIELD_GUIDE.md` in this folder covers using `rtl_433` directly — the five **RADIO** menu
items, the bandwidth arithmetic that decides what a given `-f`/`-s` pair can and cannot hear, and
the help commands that answer flag questions from the binary in front of you rather than from
memory. `npm run water_listen_signal` is the one to have running while moving the antenna.

### Proving reception before trusting it

```bash
node src/home_assist/modules/water/capture.js 10
```

Captures 10 minutes of raw decoder output to `<data dir>/captures/` and reports how many lines came
from meter `16642655`. If that count is zero while the total is not, the antenna needs to move — or
the id is wrong, and the capture file is the evidence to check it against.

The capture can then be replayed through the real ingest path:

```bash
node collector_water.js --replay --file "<the capture>"
```

## Hardware facts worth re-deriving if anything changes

If the meter is ever replaced, all of the following change together and nothing will warn you — the
symptom is simply silence, which is why the watchdog exists:

- The radio id.
- The protocol number (a new endpoint is likely a hopping model → 282/290).
- The frequency, or the fact that it is fixed at all.
- Possibly the units per count.

`node src/home_assist/modules/water/capture.js` plus the Diagnostics page is the path back.
