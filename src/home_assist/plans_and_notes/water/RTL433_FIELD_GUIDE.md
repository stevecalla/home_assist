# Using rtl_433 directly — a field guide

For when you want to listen to the radio yourself rather than through the collector: checking the
antenna, seeing what else is on the air, or working out why a decode stopped.

Everything below the menu table is native `rtl_433` — nothing in it is specific to this app except
the `npm` commands that stop and start the collector.

**Neighbours' meter ids are not recorded here.** They are broadcast in the clear and anyone with a
$25 dongle can read them, but writing other households' utility endpoints into a git repo is a
different act from overhearing them. Ids below are shown as `<id>`; run the survey and you will see
the real ones on your own screen. Our own meter id lives in `.env` / `.env.example`, where it
belongs.

---

## The short version: use the menu

Six listening positions are in `npm run home_assist_menu`, under **RADIO — listen to it yourself**.
They stop the collector, hand the dongle over, and restart it when you Ctrl-C — including if you
forget. Prefer them to typing `rtl_433` by hand.

| Menu | Command | Window (MHz) | What it hears |
|---|---|---|---|
| Listen — MY meter | `npm run water_listen_meter` | 915.650 – 917.250 | your meter only, readable |
| **Listen — the neighbourhood** | `npm run water_listen_nearby` | 914.488 – 915.512 | everything nearby **except** your meter |
| Listen — neighbourhood + mine | `npm run water_listen_wide` | 914.800 – 917.200 | both, in one window |
| Listen — hop the WHOLE band | `npm run water_listen_sweep` | 901.8 – 928.2, 2.4 at a time | anything in the ISM band, 8% of the time |
| Signal figures | `npm run water_listen_signal` | 915.650 – 917.250 | per-packet rssi/snr/freq + running mean |
| Protocol 223 present? | `npm run water_rtl_check` | — | no dongle needed |

The rest of this file is the native commands underneath, for when you want to go off-menu.

---

## The one rule that matters

**One process owns the dongle at a time.** The collector holds it. Trying to run `rtl_433` alongside
it gives you:

```
usb_claim_interface error -6
```

So every hand-typed session starts and ends the same way:

```
cd ~/development/home_assist/app && npm run pm2_stop_water_collector
```

```
...listen...
```

```
npm run pm2_start_water_collector || npm run pm2_restart_water_collector
```

**You are unprotected in between.** No leak detection, and the watchdog cannot fire because nothing
is running to fire it. If you are prone to wandering off, set a timer. This is the entire reason the
menu items exist: they make the restart automatic rather than remembered.

---

## Anatomy of a command

```
rtl_433 -f 916.45M -s 1600k -R 223 -F json -M level
         └ centre    └ bandwidth └ decoder └ output  └ extra fields
```

| Flag | Does | Leave it out and… |
|---|---|---|
| `-f` | Centre frequency | Defaults to **433.92 MHz** — a different band entirely from the meter |
| `-s` | Sample rate, which **is** the bandwidth | Uses the version's default; the banner tells you which |
| `-R n` | Enable only decoder `n` | Every default-enabled decoder runs. Fine for exploring, more CPU |
| `-F` | Output format | Human-readable key/value on the console |
| `-M` | Extra fields. `level` adds Modulation, **Frequency**, RSSI, SNR and Noise — all five, from the one flag | Those columns are simply absent |

---

## How bandwidth actually works

There is no "range" setting. **The sample rate IS the bandwidth**, and it is centred on `-f`.

```
-f 915M -s 1024k

      914.488 ◄────────── 1.024 MHz ──────────► 915.512
                             ▲
                        915.000  (the -f)
```

So the whole of it is one line of arithmetic:

```
low  = f - (s / 2)
high = f + (s / 2)
```

### Why the full rate, not half

Nyquist says a sampler at rate `fs` can represent `fs/2` of bandwidth, so `-s 1024k` ought to buy
512 kHz. It buys 1.024 MHz because an RTL-SDR samples in **quadrature**: two streams, I and Q, 90
degrees apart, produced by mixing the incoming signal against the tuner's local oscillator. A
complex stream carries twice the information of a real one at the same rate, and the practical
consequence is that the tuned frequency sits in the *middle* of the window rather than at the top.

You do not need the theory. You need `f ± s/2`, and the fact that it is `s` and not `s/2`.

### Why the edges are not as good as the middle

The window is not a clean rectangle. The tuner's analog filter rolls off toward the edges, so a
transmitter sitting in the outer ~10% is attenuated relative to one in the middle. It is a soft
boundary, not a wall — which is worse than a wall, because a marginal signal at the edge decodes
sometimes and looks like a flaky antenna.

**Put what you care about in the middle.** The collector tunes 916.45 exactly, not 916.

### What a dongle can and cannot do

| | |
|---|---|
| RTL2832U hard ceiling | **3.2 Msps** — 3.2 MHz |
| Reliable in practice | **~2.4 Msps** — above that, USB 2 starts dropping samples |
| Valid ranges | 225–300 ksps, then 900 ksps–3.2 Msps. Nothing in between |
| US ISM band | 902–928 MHz = **26 MHz wide** |
| Shortfall | about **11×** |

So "watch the whole 900 MHz band at once" is not a thing this hardware does. A receiver that
genuinely covers 26 MHz in one gulp is a different and much more expensive class of device. The
$25 dongle sees about a ninth of the band, wherever you point it.

CPU is the second limit. Demodulation cost scales with sample rate, and `-s 2400k` with every
decoder enabled will work a laptop hard. That is the other reason the collector runs narrow.

### The table that stops the mistake

| Command | Window (MHz) | Hears the meter at 916.45? |
|---|---|---|
| `-f 433.92M -s 250k` | 433.795 – 434.045 | no — wrong band entirely |
| `-f 915M -s 1024k` | 914.488 – 915.512 | **no** — 940 kHz short |
| `-f 915M -s 2400k` | 913.800 – 916.200 | **no** — still 250 kHz short |
| `-f 916M -s 2400k` | 914.800 – 917.200 | yes, but near the edge |
| `-f 916.45M -s 1600k` | 915.650 – 917.250 | yes, dead centre — what the collector uses |

Row two is the one to remember. `-f 915M` reads like "the 915 band" and is nothing of the sort:
902–928 is 26 MHz wide and a 1 MHz window sees **4%** of it.

---

## Covering more than one window: hopping

`rtl_433` takes **any number of `-f` positions** and `-H <seconds>` of dwell on each. That is how you
cover ground the sample rate cannot.

```
npm run water_listen_sweep
```

Thirteen positions, 2.4 MHz each, spaced **2 MHz** so they overlap, covering 901.8–928.2 with 20
seconds on each — a full sweep every four minutes.

Two design points, both of which are easy to get wrong:

- **Space the hops closer than the window is wide.** 2 MHz steps for a 2.4 MHz window gives 400 kHz
  of overlap. Butting them edge to edge puts every join on the attenuated filter rolloff, which is
  precisely where a signal gets missed.
- **Start at LOW + step/2, not at LOW.** A window centred on 902 throws half of itself away below
  the band.

### The cost: duty cycle

You are listening to any one slice **1/13 of the time — 8%**. This is the whole character of the
technique and it decides what hopping is good for:

| Transmits every | 20s dwell catches it? |
|---|---|
| ~4 s (our Orion) | yes, comfortably — several packets per visit |
| ~60 s | usually |
| ~5 min | mostly **no** |

So **absence from a sweep proves nothing.** Hopping answers "where is there traffic", after which
you go and listen properly on a fixed frequency. It is a discovery tool, never a monitor — and it
holds the dongle, and therefore stops leak detection, for minutes at a time.

Off-menu, by hand:

```
rtl_433 -f 903M -f 905M -f 907M -f 909M -f 911M -f 913M -f 915M -f 917M -f 919M -f 921M -f 923M -f 925M -f 927M -s 2400k -M level -H 20
```

---

## Ask the binary, not the internet

`rtl_433` documents itself, and the build **on the machine in front of you** is the only authority
that matters. Options come and go between versions, the apt package lags source by a lot, and a
Stack Overflow answer describing a flag your build does not have is worse than no answer — it sends
you debugging hardware. Every one of these is instant, needs no dongle, and does not touch the
collector.

| Ask | Answers |
|---|---|
| `rtl_433 -h` | Everything. Long — pipe it to `less` or grep it |
| `rtl_433 -M help` | The valid `-M` metadata values, and what each adds |
| `rtl_433 -R help` | Every protocol this build can decode, numbered. `\| grep -i orion` for ours |
| `rtl_433 -F help` | The output formats — `kv`, `json`, `csv`, `log`, `mqtt`, `influx`, `syslog` |
| `rtl_433 -Y help` | Demodulator settings (`classic`, `minmax`, `autolevel`, `squelch`, `ampest`/`magest`) |
| `rtl_433 -V` | Version, and the compile-time options that determine which of the above exist |

Most of these exit non-zero after printing. **That is not a failure** — it is the same convention as
`pm2 startup`: the help text *is* the output, and the exit code just says "I did not do the job you
named." Do not chain them with `&&`.

### `-M help` — the one that settles arguments

The two lines that matter, verbatim from the box:

```
[-M time[:<options>]|protocol|level|noise[:<secs>]|stats|bits] Add various metadata to every output line.
        Use "level" to add Modulation, Frequency, RSSI, SNR, and Noise meta data.
```

Read the first line as the menu: **`time`, `protocol`, `level`, `noise`, `stats`, `bits` — six
values, and nothing else is accepted.** The second line is the whole answer to "which flag do I need
for signal figures": **`level` adds Modulation, Frequency, RSSI, SNR and Noise, all five, from the
one flag.**

The rest of the output expands the values that take sub-options — `time` has a family
(`time:iso`, `time:unix`, `time:utc`, `time:usec`, `time:rel`, `time:off`), `noise` takes an
interval in seconds, `stats` takes a level and an interval. Run it on the machine you are on rather
than trusting this paragraph; that is the entire point of the section.

Two from that list are worth knowing even though we do not use them:

- **`time:utc`** would make rtl_433 stamp in UTC. We deliberately do not: the collector stamps both
  `*_utc` and `*_mtn` itself, in Node, from `WATER_TZ`. Two sources of truth for time is how hour
  buckets drift between the laptop and the Ubuntu box.
- **`stats`** reports periodic decoder statistics — how often each protocol *attempted* a decode
  against how often it succeeded. Useful when you suspect a decoder is seeing your signal and
  rejecting it, which looks identical to not hearing it at all.

### `-R help` — is the decoder even in this build?

```
rtl_433 -R help 2>&1 | grep -i orion
```

Want `[223] Badger ORION water meter, 100kbps`. **If it is missing, `-R 223` cannot work and no
amount of antenna work will help** — the apt package is frequently too old. Build from source; see
`UBUNTU_DEPLOY.md`. `npm run water_rtl_check` is this command with the answer spelled out.

The `2>&1` matters: some builds print the protocol list to stderr, so a bare pipe to `grep` finds
nothing and you conclude the decoder is absent when it is right there.

---

## The flag that does not exist: `-M freq`

There is no `-M freq`. `-M help` above lists six valid values and `freq` is not one of them — and
`level` already gives you frequency, so even the intent was redundant.

The failure mode is what makes this worth a section. rtl_433 does **not** ignore the unknown value
and carry on — the run comes back with **no signal metadata at all**. Every `rssi`, `snr` and `freq`
is null. That looks exactly like a dead antenna, so you go outside and move the aerial when the
problem is six characters in a config file.

**If signal columns are blank, read the arguments before you touch the hardware.**

---

## Output formats

| Want | Use |
|---|---|
| Readable, browsing | *(no `-F`)* — the default key/value console output |
| Signal figures | `-F json` |
| Both console messages and JSON | `-F log -F json` |
| Readable **and** signal figures | `-F json` piped through `jq` (below) |
| To a file for replay | `-F json > file.jsonl` |

```
rtl_433 -f 916M -s 2400k -M level -F json | jq -c '{t:.time, model, id:(.id // .Id), rssi, snr, freq:(.freq // .freq1)}'
```

FSK protocols like the Orion report two tone frequencies, `freq1` and `freq2`, rather than a single
`freq` — hence the `//` fallback above.

---

## Recipes

**Confirm your own meter still decodes** — the collector's config, readable:

```
rtl_433 -f 916.45M -s 1600k -R 223
```

**Survey the neighbourhood** — the clean, readable one, and the proof-of-life command:

```
rtl_433 -f 915M -s 1024k
```

This is the one to reach for when your own meter has gone quiet, because it **cannot** hear your
meter — 916.45 is 940 kHz above the top of the window. So if traffic still scrolls past here, the
dongle, the driver, the USB path and the antenna are all fine, and the problem is your meter or its
tuning. A command that deliberately excludes the thing you are worried about is a better test of the
receiver than one that includes it.

**Survey the 915 band including your meter:**

```
rtl_433 -f 916M -s 2400k -M level -F json | jq -c '{t:.time, model, id:(.id // .Id), snr}'
```

**The busy band** — weather stations, doorbells, tyre sensors, remotes:

```
rtl_433 -f 433.92M
```

**Hop between the two bands you care about** — 433 and 915, one minute each:

```
rtl_433 -f 433.92M -f 916.45M -H 60
```

**Everything, including decoders that are off by default:**

```
rtl_433 -f 916M -s 2400k -G 4
```

`-G 4` enables ~40 protocols disabled because they false-positive. **Exploration only.** You will
see devices that do not exist. Never in anything that alerts.

---

## Messages you will see, and what they mean

| Message | Means |
|---|---|
| `[R82XX] PLL not locked!` | The tuner grumbling at start-up. Usually benign — only worry if nothing ever decodes |
| `bitbuffer_add_bit: row count limit (50 rows) reached` | A decoder being fed **static** and trying to make sense of it. Normal on an empty band with everything enabled |
| `New defaults active, use "-Y classic -s 250k"…` | Version 22+ changed the demodulator and default rate. Informational |
| `Use "-F log" if you want any messages…` | You passed `-F json`, so console messages were suppressed. Add `-F log` alongside it |
| `usb_claim_interface error -6` | The collector still has the dongle |
| `No supported devices found` | Dongle not enumerated, or `dvb_usb_rtl28xxu` grabbed it. `lsusb`, then check the blacklist |

---

## What is actually on the air here

Observed 2026-08-01 at `-f 915M -s 1024k`:

| Model | Count | What it is |
|---|---|---|
| `Fineoffset-WH65B` | 1 | A neighbour's weather station. Transmits regularly — a **useful reference signal** for antenna work |
| `ERT-SCM` | 3 | Itron Encoder-Receiver-Transmitter, Standard Consumption Message — the protocol most US utility meters use. All three report `ERT Type 12`, which is commonly **gas**, though the type mapping is not authoritative. If one of them is ours, the way to find out is to compare its `Consumption Data` against the gas meter dial, not to trust the type code |
| `Badger-ORION` | — | Ours — and **absent** from that capture, because 916.45 sits above the top of the window |

The neighbour's weather station is worth knowing about: when you move the antenna, a signal at a
fixed distance that you did not move is the control. If your SNR rises and theirs does not, you
improved *your* path. If both rise, you improved the receiver.

---

## Explore wide, run narrow

Wide settings are for finding things. The collector deliberately uses a **narrow window on the exact
frequency** — a better decode rate for the one meter that matters, and far less CPU.

Do not "improve" the collector by widening it.

---

## Capture instead of watching

```
npm run water_capture 10
```

Ours, not rtl_433's — a wrapper that uses the collector's own resolved arguments, so what you
capture is exactly what it hears. Writes raw JSON to `<data dir>/captures/`, outside the repo. It
captures **every** Orion packet, yours and the neighbours', and shows a live `lines / ours` tally.

Then:

```
node collector_water.js --replay --file "<the capture>"
```

That runs the real ingest path — sanity guards, leak rules, all of it — against exactly what the
radio heard, with **no dongle needed**. More honest than the synthetic generator, which only ever
emits fields we already expect.

It owns the dongle too. Stop the collector first.

---

## Troubleshooting

| Symptom | Look at |
|---|---|
| Nothing decodes at all | Wrong band, or wrong bandwidth — check the window maths above before blaming the antenna |
| Everything decodes except your meter | `916.45` outside the window; or `-R 223` missing from a build that needs it |
| Decodes are intermittent | Antenna. Compare your SNR against the neighbour's weather station over the same period |
| `rssi` / `snr` / `freq` all blank | **Check for `-M freq` first** — an invalid `-M` value suppresses the whole set. Otherwise `-M level` is simply missing |
| Works standalone, not under the collector | `npm run water_check` — it prints the resolved args and which `.env` key supplied them |

---

## If you find a third meter

Three ERT-SCM endpoints are audible from here, all `ERT Type 12`. One of them may be our gas meter.
That is a candidate for a **second module** rather than an addition to this one — the water module's
ingest, rules and alerts are all denominated in gallons of water, and a gas meter that borrows them
would be a gas meter wearing a water module's assumptions.

The first step is not code. It is standing at the gas meter with a phone, reading the dial, and
comparing it against the `Consumption Data` figure for each of the three ids. Two of them will not
move with your gas usage. See `plans_and_notes/ADDING_A_MODULE.md` if one of them does.
