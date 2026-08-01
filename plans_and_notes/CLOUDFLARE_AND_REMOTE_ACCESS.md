# Cloudflare & remote access

How to put `home.kidderwise.org` (or similar) in front of this, and — more importantly — what has to
be true first. `home_assist` was built LAN-only on purpose, so exposing it is a real decision rather
than a config change.

## Read this before the how-to

usat_apps sits behind Cloudflare because it is an internal tool for a staffed organisation. This is
your house. The difference that matters:

- Its auth is **one local password** (scrypt, but still — one password, no MFA, no lockout, no rate
  limiting on `/api/login`).
- A leaked session tells someone **when your house uses water**, which is a good occupancy signal.
- `/api/health` and `/api/status` are unauthenticated by design (for the proxy's health aggregator).

So: **do not port-forward 8050, and do not put this behind a plain Cloudflare DNS record.** If you
want it reachable from outside, the only configuration worth doing is **Cloudflare Tunnel +
Cloudflare Access**, where Cloudflare authenticates you (email OTP or Google) *before* a request ever
reaches the app. Then the app's own password is a second factor rather than the only one.

If the goal is just "know about a leak when I'm out", **you already have that** — the alert email
does not require the dashboard to be reachable. Consider whether you need this at all.

---

## Option A (recommended) — Cloudflare Tunnel + Access

No open ports, no public IP, no port forwarding on the router. `cloudflared` makes an outbound
connection, so it works behind CGNAT too.

You already have `~/.cloudflared` on the laptop, so the account and cert are likely in place.

### 1. Install and authenticate on the Ubuntu box

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
cloudflared tunnel login        # opens a browser; pick kidderwise.org
```

### 2. Create the tunnel and point a hostname at it

```bash
cloudflared tunnel create home-assist
cloudflared tunnel route dns home-assist home.kidderwise.org
```

That DNS step creates a proxied CNAME to `<tunnel-id>.cfargotunnel.com` — orange cloud, automatic.
Nothing to do in the DNS dashboard by hand.

### 3. Config

`/etc/cloudflared/config.yml`:

```yaml
tunnel: home-assist
credentials-file: /root/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: home.kidderwise.org
    service: http://127.0.0.1:8050
  - service: http_status:404
```

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

### 4. Put Access in front of it — this is the step that matters

Zero Trust dashboard → **Access → Applications → Add an application → Self-hosted**:

- Application domain: `home.kidderwise.org`
- Session duration: 24h (or 1 week — it is your house)
- Policy: **Allow**, include **Emails** → `callasteven@gmail.com`

Now Cloudflare demands an identity before anything reaches port 8050. An unauthenticated request
never touches Node — which is the whole point, because it means the app's own login is not the thing
standing between the internet and your house.

### 5. Keep the app's Vite base at `/`

Nothing to change. The tunnel serves the app at the root of its own hostname, exactly like
`usat-app.kidderwise.org` does for usat_apps. No `--base` rebuild needed.

### 6. Verify

```bash
curl -I https://home.kidderwise.org/api/status     # should be a 302 to the Access login, NOT 200
```

**If that returns 200 with JSON, Access is not enforcing** — the app is naked on the internet. Fix
before going further.

---

## Option B — behind a shared proxy, usat_apps style

Only worth it if you end up running several home services on one box and want one hostname. Mirrors
`utilities/proxy/proxy_routes.js` in sql_programs, where each prefix maps to a local port and a
`host` tag gates which public hostname may reach it:

```js
'/':        { target: 'http://127.0.0.1:8050', health: '/api/status', host: 'home' },
'/garage':  { target: 'http://127.0.0.1:8031', health: '/api/status', host: 'home' },
```

Then a single tunnel points `home.kidderwise.org` → the proxy port, and the proxy fans out. If you
go this way, build the SPA path-aware for any non-root prefix:

```bash
npm --prefix src/home_assist/web run build -- --base=/whatever/
```

`web/src/lib/api.js` and `main.jsx` are already base-aware (`import.meta.env.BASE_URL`), so a
sub-path build works without code changes — same as usat_apps' `usat_apps_build_proxy`.

**Do not reuse the usat `:8000` proxy for this.** It is host-gated to `usat-api` / `usat-app` and it
is a work system; mixing a house dashboard into it couples two things that should fail independently.

---

## What NOT to do

| | Why |
|---|---|
| Port-forward 8050 on the router | Exposes a single-password app, plus unauthenticated `/api/status`, to the whole internet. |
| A plain proxied DNS A record to your home IP | Same problem — Cloudflare's orange cloud hides your IP, it does not authenticate anyone. |
| Cloudflare Access without a Tunnel | Access only protects traffic that goes through Cloudflare; anyone who finds the origin IP bypasses it. |
| Open MySQL (3306) to anything | The collector and web server are both local. There is never a reason. |

---

## Hardening to do first, if you expose it at all

The app was built for LAN, so these are gaps that only matter once it is public. Do them **before**
step 4 above, not after:

1. **Rate-limit `/api/login`.** There is none today. `express-rate-limit` is already a dependency in
   wrestling_stats; add it to `api/routes.js` on the login route (e.g. 10 attempts / 15 min / IP).
2. **Set `HOMEASSIST_SESSION_SECRET` explicitly** in `.env`. Today one is generated into `auth.json`
   on first run — fine locally, but you want a known value you can rotate.
3. **Set `Secure` on the session cookie** when served over HTTPS. `auth/session.js` `cookie_string()`
   hardcodes `HttpOnly; SameSite=Lax; Path=/`; add `; Secure` behind an env flag.
4. **Consider gating `/api/health`.** It reports MySQL reachability, which is a small information
   leak. `/api/status` is fine to leave open — the tunnel needs something to health-check.
5. **A long, unique admin password.** It is the second factor once Access is the first.

None of this is needed for LAN-only operation, which is why it is not built. If you decide to expose
it, treat this list as the actual work — the tunnel setup above is the easy part.

## Recommendation

Start with **Option A, Access enforced, and items 1–3** above. Or skip the whole thing: the email
alerts already reach you anywhere, and the dashboard is only interesting when you are home and
curious. Exposing a house occupancy signal to the internet to save opening a laptop is a poor trade.
