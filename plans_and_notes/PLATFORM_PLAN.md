# home_assist — platform plan

Repo-root `plans_and_notes/` holds **cross-cutting** plans: things about the shell itself, or about
more than one module. Per-module notes live under `src/home_assist/plans_and_notes/<module>/`.
Same split as usat_apps (`sql_programs/plans_and_notes/` vs `src/usat_apps/plans_and_notes/`).

## Where this is going

One place to look at the house. Water is feature #1 because it is the one with a dollar figure
attached (a running flapper is ~200 gal/day), but the shell exists so that #2 costs a manifest file
and a nav entry rather than a second app with a second login.

The test of whether the architecture is right is not how good the water panel looks — it is how
cheap the *second* module turns out to be. If adding one requires touching `panel_access.js`, the
router, or the rail, something has regressed.

## Phases

| # | Phase | State |
|---|---|---|
| 1 | Platform shell — auth, sessions, panel access, module registry, side rail, menu, admin CLI | **done** |
| 2 | Water module — collector, leak rules, MySQL, alerts, dashboard | **done** (unverified against live radio) |
| 3 | Live-hardware validation on Windows: real rtl_433 capture + email delivery | **next** |
| 4 | Ubuntu cutover — the permanent 24/7 host | after 3 |
| 5 | Threshold tuning from a week of real nights | after 4 |
| 6 | Module #2 | open |

Phases 3–5 are not code work. They are the part that decides whether any of this actually protects
the house, and none of it can be done from a sandbox.

## Candidate module #2

Not committed to any of these — listed so the shell can be sanity-checked against real second uses:

- **Power** — a second RTL-SDR-decodable meter, if the electric meter is an Itron ERT. The neighbours'
  gas/electric ERTs already decode easily from indoors, which suggests ours would too. This is the
  cheapest candidate because it reuses the entire collector shape: a radio source, an odometer, hourly
  buckets, threshold rules. Would be a genuine test of whether the module boundary holds.
- **Temperature / humidity** — cheap 433 MHz sensors that rtl_433 already decodes. Different data
  shape (instantaneous readings, not a monotonic counter), which is the *useful* kind of test: it
  would show whether `water_*`-shaped assumptions leaked into the platform.
- **Furnace / water-heater runtime** — needs a sensor, so it is a hardware project first.

Whichever comes first, do the throwaway version inside `modules/_template` before committing to the
data model. The water module's schema took its shape from three months of running `monitor.mjs`, not
from a whiteboard.

## Standing constraints

These are decisions, not preferences. Changing one is a real decision to make deliberately:

1. **The collector is the product.** Anything that risks the collector's uptime for the web layer's
   benefit is the wrong trade. Two processes, always.
2. **Silence is not safety.** Every module that watches something must be able to say "I have stopped
   being able to see" as loudly as "something is wrong".
3. **LAN only.** No internet exposure. Alerts reach you when away; the dashboard does not need to.
4. **Mirror usat_apps.** Familiarity across the two repos is worth more than any local cleverness.
5. **Nothing sensitive in the repo.** Runtime state lives outside it, via
   `utilities/directory_tools/determine_os_path.js`.

## Deliberately out of scope

- A metrics/analytics stack (usat_apps has one; it serves a team, this serves a house).
- SSO.
- A mobile app — the dashboard is responsive, which is enough.
- Home Assistant (the OSS project) integration. Different thing, same name collision. If the house
  ever grows enough devices to want it, this repo becomes a data source for it rather than a rival.
