# Email — sending alerts as `water-alerts@kidderwise.org`

Set up 2026-08-24. Replaces sending from a personal Gmail address.

## Why

Alerts used to come from a personal Gmail account. That works indefinitely while the only recipient
is you — Gmail already trusts mail you send to yourself.

It stops working the moment a meter's `notify_email` belongs to **someone else**. Automated mail
from a personal Gmail account, to someone who has never corresponded with you, about *their* water,
is the exact profile a spam filter drops.

And it drops it **silently**. Gmail accepts the message, `water_alerts` records `delivered = 1`, and
it dies in their spam folder. The ledger says the neighbour was told; the neighbour was not. That is
the same failure this module's watchdog exists to prevent — silence is not safety.

Sending from a domain we control fixes it, because the domain can vouch for the sender.

## How it works

Three moving parts. The one people get wrong is the first: **Cloudflare is not in the sending path.**

| Part | Does what | Why it is needed |
|---|---|---|
| **Gmail** | Sends every message, as it always did | Nothing about the transport changed — still `smtp.gmail.com:587` with the same app password |
| **Cloudflare Email Routing** | *Receives* mail addressed to `water-alerts@kidderwise.org` and forwards it to the Gmail inbox | Gmail will not let you send as an address until you prove you own it — it emails a confirmation link there. Also gives replies and bounces somewhere to land |
| **Cloudflare DNS (SPF)** | Publishes "Google may send mail as kidderwise.org" | This is the part that actually keeps alerts out of spam |

So mail flows **out** through Google and **in** through Cloudflare. They never meet.

## Configuration

`.env` on each machine. The app-level change that made this possible is `EMAIL_USER` — before it,
`EMAIL_SENDER` was used as *both* the From address and the SMTP login, which is only true on Gmail.

```
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_SENDER=water-alerts@kidderwise.org    # what recipients see
EMAIL_USER=<the Gmail account>              # who logs in to SMTP
EMAIL_FROM_NAME=Water Monitor               # the name beside the address
EMAIL_PASSWORD=<Gmail APP password>         # unchanged, 16 chars, no spaces
EMAIL_RECIPIENT=<default recipient list>
```

`EMAIL_FROM_NAME` matters once a neighbour is a recipient. Blank, the From line falls back to the
machine's hostname — `home_assist (steve-calla-Latitude-7420) <water-alerts@kidderwise.org>`. That
is useful while you are the only recipient (it says which box sent the mail without opening it) and
wrong the moment someone else receives one: a hostname in the From line reads as technical noise at
best, and as something to report as spam at worst.

`EMAIL_USER` blank falls back to `EMAIL_SENDER`, so any Gmail-only install keeps working untouched.

`.env.example` carries both options as commented blocks. **Only one `EMAIL_SENDER` and one
`EMAIL_USER` may be uncommented** — dotenv keeps the FIRST occurrence of a key and silently discards
every later one, so a leftover uncommented line wins and the edit below it does nothing.
`node src/home_assist/admin.js envcheck` reports duplicates.

## One-time setup (done)

1. **Cloudflare → kidderwise.org → Email → Email Routing** → enable → **Add missing records**
   (3 MX, 1 DKIM, 1 SPF)
2. **Destination Addresses** → the Gmail account → verify
3. **Routing rules → Create address** → `water-alerts` → *Send to an email* → the Gmail account
4. **Test receiving** before going further: email `water-alerts@kidderwise.org` from a phone and
   confirm it lands in Gmail. Everything after this depends on it
5. **Gmail → Settings → Accounts and Import → Send mail as → Add another email address**
   - Address `water-alerts@kidderwise.org`
   - **Gmail pre-fills the SMTP server from the domain's MX records — those are Cloudflare's
     *inbound* servers and will not send.** Overwrite with `smtp.gmail.com`, port 587, username =
     the Gmail account, password = the app password, TLS
   - Confirm via the link Gmail sends to `water-alerts@`
   - Verify afterwards that the entry reads *"Mail is sent through: smtp.gmail.com"*
6. **Cloudflare → DNS → Records** → edit the TXT record on `kidderwise.org` starting `v=spf1`:

   ```
   v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all
   ```

   **Merge — never add a second SPF record.** Two make both invalid. Cloudflare's own
   `include:_spf.mx.cloudflare.net` covers the forwarding; Google's covers the sending. Both belong
   in the one record.

   The Email Routing page locks its DNS records; click **Unlock** there before editing.

## Verifying

```
node collector_water.js --check
```

The email line should read `ok (water-alerts@kidderwise.org -> ...)`.

Then the real test, which is **not** sending to yourself:

1. Point `EMAIL_RECIPIENT` (or a meter's `notify_email`) at a **non-Google** address you own
2. Settings → **Send a test alert**
3. Open it there and view the raw message / full headers
4. Look for **`spf=pass`** and `From: water-alerts@kidderwise.org`

Inbox rather than spam at a third-party provider is the only evidence that matters. Gmail-to-Gmail
proves nothing — it would have worked before any of this.

## Switching back

Comment out the two Option B lines in `.env`, uncomment Option A, restart. Nothing else changes; the
DNS records and the Gmail alias can stay in place indefinitely and cost nothing.

## Traps hit during setup

- **Gmail pre-fills the wrong SMTP server** (the domain's MX). Inbound servers; they do not send.
- **Quotes in the Cloudflare TXT editor.** The records table displays TXT values wrapped in quotes.
  Match whatever the edit box shows — do not end up with doubled quotes.
- **`envcheck` reads commented lines leniently** to spot documented-but-unset keys, so a comment
  line beginning `v=spf1 ...` is reported as a key named `v`. Worth knowing before it looks like a
  real finding.
- The destination address may show **Verified** immediately if it is the same address as the
  Cloudflare account login. That badge is not proof of anything — the forwarding test in step 4 is.

## Still global, not per-user

Everything here is module-wide. What *is* per-meter is the delivery target: `notify` and
`notify_email` on the Meters page, which override `EMAIL_RECIPIENT` for that meter (**replace**, not
add to). Which *kinds* of alert fire, the daily-summary hour, cooldowns and all ntfy settings remain
global.

**ntfy has no per-meter equivalent, and that is a real gap.** Enable push and a neighbour's meter
would email *them* and push *you*, because `ntfy_topic` is global and dispatch never consults the
meter for it. Latent today — `alert_ntfy_enabled` is `0`.
