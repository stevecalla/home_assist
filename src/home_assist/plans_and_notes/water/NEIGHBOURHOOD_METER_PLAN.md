# Neighbourhood water monitoring — a plan

Scaling the single-house Badger Orion monitor beyond one house.

Written as a plan to argue with, not a spec.

> ## Revision: the per-household device is the better answer
>
> This document was first written around a **shared neighbourhood receiver** — one antenna on a high
> point hearing 20–100 meters. Sections 1–5 analyse that.
>
> **A device each household buys and installs in their own home is a better architecture**, and it
> dissolves the two problems that dominate everything below:
>
> - **Consent stops being a policy and becomes structural.** The device hears its owner's meter.
>   There is no neighbour's data to mishandle because it was never collected. Most of section 1
>   becomes moot, and the pairing ceremony in section 4 becomes a convenience rather than a
>   safeguard.
> - **Coverage stops being a risk.** Section 2's physics — pits, wet ground, steel lids, terrain —
>   was the most likely thing to kill the shared-receiver plan. Forty feet to your own pit is a
>   solved problem. Each household solves their own siting, which is the one problem that does not
>   scale centrally.
>
> **Section 8 is the revised plan.** Keep 1–5 for the reasoning; act on 8.

---

## 1. The question that comes first: consent

**Reading your own meter is a hobby. Reading a hundred neighbours' meters is a different act**, and
the difference is not technical — the radio does not care whose pit it is.

Water data is more intimate than it looks. A minute-resolution flow trace tells you when a household
wakes, showers, goes to bed, when the house is empty, when someone is ill, when a second person
moved in. It is occupancy data with a plumbing wrapper.

### The legal picture, roughly

| | |
|---|---|
| **Receiving** unencrypted AMR broadcasts | Generally lawful in the US — the signal is unencrypted and radiates over public space. This is the same basis that makes `rtl_433` legal |
| **Divulging or using** what you received | Much murkier. US Communications Act §705 restricts divulging intercepted radio communications; state privacy statutes vary |
| **A service that stores and shows it to someone** | Squarely in the murky part, and "the data was in the air" is not the defence people assume it is |

I am not a lawyer and this needs one before anything goes past a pilot. But the practical answer is
the same as the ethical one, and it happens to also be the better product:

### Opt-in, per household, and they only ever see their own

- A household enrols and claims their meter. Nothing is shown to anyone who has not enrolled.
- Unclaimed meters are **counted, never stored** — you need to know a signal exists to plan
  coverage; you do not need to keep its readings.
- No cross-household comparison, leaderboards, or "your street uses X" — those all require using
  data from people who did not consent.
- Deleting an account deletes the history.

This costs you nothing you actually wanted and changes the project from "a man in his shed watching
the street" to a service people opt into. It is also the only version you could explain to a
neighbour, a journalist, or the utility without flinching. **If a design decision would embarrass you
at a block party, it is the wrong decision.**

### The other party: the utility

They may have views. Many Badger and Itron deployments already have a customer portal with this
data, often free. **Check what yours offers before building anything** — competing with a utility's
own app, using their meters, is a poor position.

---

## 2. The question that comes second: can you even hear them?

This determines the whole shape and cost, and it is measurable in a week.

Your own meter is 40 feet away, in a pit, under a metal lid, and it is marginal indoors. Meters in
pits are terrible transmitters — they are radiating into wet ground through a steel plate. The
budget, the node count, and whether "100 houses" is one device or six all fall out of one number:
**how many distinct meter ids can a well-sited antenna hear reliably?**

### The survey, before any product decisions

Put one node at the best available site — highest point, clearest sky, ideally a rooftop — and log
every Orion packet for a week. Do not decode anyone's volume; count ids, decode rate and RSSI.

| Measure | Why it decides something |
|---|---|
| Distinct meter ids heard | Your addressable market from that site |
| Packets/hour **per id** | A meter heard twice an hour cannot support leak detection. Set a floor and count only ids above it |
| RSSI distribution | Tells you whether more antenna height helps or you are at the physical limit |
| Ids that come and go | Marginal reception looks like coverage in a one-hour test and fails in production |

**Honest expectation:** 100 houses from one receiver is optimistic. A good outdoor antenna at height
might cover a few hundred metres in open suburbia and far less through terrain and buildings. Plan
for **one node per 20–40 homes** and be pleased if it is better. Boulder's topography will not help.

The tooling you already have does most of this — `listen.js sweep`, the meters-heard scoreboard, the
decode-rate maths, the gap detection. The survey is mostly a repackaging job.

---

## 3. The device

### Shape

```
outdoor antenna ── short coax ── SDR + small computer ── PoE ── house network ── internet
                                 (in a weatherproof box, at the antenna)
```

**Put the receiver at the antenna, not the antenna at the receiver.** Coax loses meaningful signal at
915 MHz; Ethernet does not. This is the same "extend USB, not coax" rule from your own build, one
size up.

### Parts, roughly

| Part | Note | ~Cost |
|---|---|---|
| Single-board computer | Pi 4/5 or equivalent. Needs to survive heat and power cuts | $60–90 |
| RTL-SDR | Same class as yours; a TCXO model for frequency stability outdoors | $35 |
| Antenna | 915 MHz vertical, 3–6 dBi collinear. **The single biggest lever** | $40–80 |
| Enclosure, PoE splitter, mount | Weatherproofing is not optional | $50–80 |
| **Per node** | | **~$200–280** |

### Two decisions worth making early

**Multiple narrow receivers beat one wide one.** Your own field guide already says it: narrow windows
decode better and cost far less CPU. If the neighbourhood has both Orion (916.45) and Itron ERT
(around 912–915), two dongles each on a fixed frequency beats one at 2.4 Msps trying to cover both.
Dongles are $35; CPU and decode rate are not.

**The node must work with the internet down.** Store locally (SQLite), forward when it can. A leak
does not pause for your ISP. This also means the node needs enough disk for a few days of buffer and
a clock that survives reboot.

---

## 4. Identity: which meter is whose

This is the hardest *product* problem, and it has an elegant answer.

You cannot derive an address from a meter id. The obvious approaches are all bad: reading ids off
meter faces means walking the street lifting lids; asking the utility means asking permission you
probably will not get; guessing from signal strength is nonsense.

### Pair by making the meter move

The meter is a sensor the household already controls. So:

1. Household enrols and is asked to run an outside tap for two minutes at a time of their choosing.
2. They press "start" in the app.
3. The service watches every unclaimed id and finds the one whose odometer advanced by roughly the
   right amount in that window.
4. That id is now theirs, pending a confirmation round to rule out coincidence.

**This solves consent and identity in one step.** Nobody's meter gets claimed without a person
physically turning a tap at their own house, which is about as strong a proof of association as you
can get without a utility database. It also self-documents: the pairing event is the consent record.

Guard against the obvious failure — two households running water simultaneously. Require a
distinctive volume, or a second confirmation round at a different time. **Refuse to pair rather than
pair wrongly**; the failure mode of a wrong pairing is showing one household another's data, which is
the single worst outcome this project can produce.

---

## 5. Architecture

### What ports directly from what you built

The valuable part of the existing work is not the app — it is the parts that were kept pure.

| Component | Reuse |
|---|---|
| `rules/leak_rules.js` | **Direct.** Pure functions over hour buckets and runs, no DB or clock. This is the product's brain and it already exists and is tested |
| `collector/ingest.js` | **Direct.** Rollover, backward readings, the impossible-jump filter and its rate floor. Hard-won and unit-tested |
| Decoder field tolerance | **Direct.** The `volume_gal` / `mic` / `freq1` lesson generalises to every meter you meet |
| The collector process | **Concept, not code.** Becomes an edge agent that buffers and forwards rather than writing to a local MySQL |
| The web app | **Rewrite.** Single-house session auth and panel access is the wrong shape for multi-tenant |
| MySQL schema | **Rethink.** Fine for one house; 100 meters is a time-series problem |

### Shape

```
edge node ──▶ MQTT/HTTPS ──▶ ingest ──▶ time series ──▶ rules ──▶ notify
                                            │
                                            └──▶ API ──▶ app (one household, one meter)
```

Keep the rules engine running server-side rather than on the node. A leak rule you can fix centrally
is worth more than one distributed across thirty boxes on a roof.

### Volume

Your own numbers scale linearly and are not frightening. About 12 packets/minute per meter:

| Scale | Packets/day | Per-packet storage at 1-day retention |
|---|---|---|
| 1 meter (you) | ~17k | ~5.5 MB |
| 30 meters | ~500k | ~170 MB |
| 100 meters | ~1.7M | ~570 MB |

Per-packet data is a diagnostic, not a product feature — keep a day or two, roll up to minute and
hour buckets for anything older. The rollups are what the rules and charts read anyway.

---

## 6. What could kill it

Listed so they are decisions rather than surprises.

| Risk | Reality |
|---|---|
| **Coverage** | Pits, terrain and steel lids. May be 15 houses per node, not 40. Survey first |
| **Meters change** | Utilities swap and re-key meters. A pairing that silently goes stale shows a household someone else's water, or nothing at all. Needs active detection |
| **Frequency-hopping meters** | Newer Orion variants hop. Fixed-frequency reception stops working and the fix is not a config change |
| **Liability** | Telling someone "no leak" when there is one is the exposure. Terms need to say advisory, not guaranteed — and the watchdog must be loud, because silence reading as safety is the failure this whole design fears |
| **The utility already does this** | Check their portal first. If they alert on continuous flow already, your product is a nicer UI on their data |
| **Encryption** | If a utility encrypts a future generation, the project ends. Not hypothetical — it has happened in electricity metering |

---

## 7. Phasing

Each phase answers one question and can stop the project cheaply.

| Phase | Does | Answers | Effort |
|---|---|---|---|
| **0. Survey** | One node, best site, one week of id logging | How many houses is a node worth? | A weekend |
| **1. Two households** | You and one willing neighbour. Full pairing flow, consent record, their own view | Does pairing work with a real stranger's meter? | Weeks |
| **2. Ten households** | Multi-tenant app, alerts, onboarding a non-technical person unaided | Is this a product or a favour? | Months |
| **3. Decide** | Legal review, utility conversation, entity and insurance | Is it worth being a business? | — |

**Phase 0 is the one to do.** It is cheap, it uses tools you already have, and its answer determines
everything downstream. Everything above it is speculation until you know how many meters one
well-placed antenna can actually hear.

---

## The short version

The radio problem is mostly solved — you solved it. The leak logic is solved and tested. What is
unsolved is **coverage** (physics, measurable in a week) and **consent** (a design and legal problem,
answerable now).

Do the survey. Get the number. Then decide whether there is a product here or a very good story about
the time you read the whole street's water meters and thought better of it.

---

# 8. The per-household device — the revised plan

One device per home, bought by the household, hearing only that household's meter.

## What changes

| | Shared receiver | Per-household device |
|---|---|---|
| Consent | Policy you must enforce, and can violate | **Structural.** You never hold anyone else's data |
| Coverage | The main risk. Terrain, pits, siting | Forty feet, indoors. Solved |
| Siting | You must find and keep rooftop access | The customer's problem, and an easy one |
| Scaling | Survey, install and maintain a node per 20–40 homes | Linear and self-serve |
| Failure blast radius | One node down = 30 households blind | One device down = one household |
| Hard part | Physics and law | **Being a hardware company** |

## Do not ship an SDR

An RTL-SDR is a **development** tool: general-purpose, ~2 W, needs a Linux host with USB. For one
known protocol on one fixed frequency, a sub-GHz transceiver does the same job for a tenth the cost
and a tenth the power. This is how commercial AMR readers are built.

| | Prototype | Product |
|---|---|---|
| Radio | RTL-SDR, ~$30 | CC1101 or SX1276, ~$3 |
| Host | Pi Zero 2 W, Linux, `rtl_433` | ESP32, protocol decoded on-chip |
| Power | ~2–3 W | ~0.3 W |
| BOM at small volume | ~$60 | **~$16–20** |

Prototype on Pi + SDR because that is what exists and what the decoder is written against. Ship
silicon that does exactly one thing.

**The work in between is real.** `rtl_433`'s protocol-223 decoder documents the framing, but
re-implementing FSK sync, framing and CRC on a CC1101 is a genuine engineering task, not a port. Do
it only once the product question is answered.

## The device still hears the neighbours — say so, and mean it

Physics does not care about your architecture. Every meter on the street shares the frequency, so
the device will receive them whether you want it to or not. **The consent story holds only because
the firmware discards them**, which makes that a load-bearing design commitment rather than an
implementation detail:

- Filter to the paired meter id at the earliest possible point — before storage, before upload.
- Never upload an unpaired id, not even for diagnostics. A "just for antenna tuning" exception is
  how this promise gets quietly broken.
- Say it plainly in the product copy. It is a feature, and the honesty is the differentiator.

## Pairing, now easy

The device hears one meter far louder than the rest, so the candidate list is short. The run-a-tap
flow from section 4 still works and is still worth having — it turns "probably the strongest signal"
into proof — but it is now a confirmation step rather than the whole consent mechanism.

## The competition, honestly

**Flume exists**, around $200, and Moen Flo and Phyn are adjacent. Same shape: sensor at the meter,
WiFi, app, leak alerts. Pretending otherwise would be the fastest way to waste a year.

The edge is real, though, and worth stating precisely. Flume straps a magnetometer to the meter and
**infers** flow. That means a battery in the pit, a device someone has to install outdoors, and
numbers that approximate rather than match the bill.

Reading the AMR broadcast instead means:

| | |
|---|---|
| **Nothing in the pit** | No lid to lift, no battery to replace, no outdoor install |
| **Billing-accurate** | It is the utility's own register — the same number they bill from, not an estimate |
| **Meter-agnostic within a protocol family** | Works on any Orion without touching it |

*"Matches your bill exactly, nothing to install outside"* is a genuine position.

## What it actually costs to ship

The software is the easy half. In rough order of how badly each can hurt:

| | |
|---|---|
| **FCC Part 15** | Receive-only still needs Class B compliance as a digital device. A pre-certified WiFi module avoids most of the intentional-radiator work, not all of it. Budget real money and months |
| **WiFi onboarding** | The classic consumer-IoT nightmare. Most support tickets will be here, not in the radio |
| **Firmware updates** | Must be signed, staged and reversible. A bad update bricks devices in houses you cannot visit |
| **Support** | 100 devices is 100 relationships. This scales worse than anything technical |
| **Returns and warranty** | Needs an entity, terms and a reserve |
| **Liability** | "No leak" when there was one is the exposure. Advisory, never guaranteed — and the watchdog must stay loud, because silence reading as safety is the failure this whole design fears |

## Revised phasing

| Phase | Does | Answers |
|---|---|---|
| **0. Second unit** | Build one more Pi + SDR unit, install at a willing neighbour's house, paired to their meter only | Does it work in a house that is not yours? |
| **1. Five units** | Cloud service, per-account view, alerts. Non-technical install | Is it a product or a favour? |
| **2. Silicon** | ESP32 + CC1101, decode protocol 223 on-chip | Can the BOM reach $20? |
| **3. Business** | FCC, entity, insurance, manufacturing | Is it worth being a company? |

**Phase 0 is a weekend and answers the only question that matters right now.** Everything past it is
speculation until a second household's meter is being read reliably by a box that is not on your
desk.

The shared-receiver survey in section 7 is no longer the first step — it was answering a question
this architecture does not ask.
