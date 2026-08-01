# UBUNTU_DEPLOY — moving the collector to the 24/7 host

The repo is developed on the Windows laptop and runs permanently on the Linux Dell Latitude. One env
var (`WATER_RTL433_CMD`) is the entire code-level port; everything below is host setup.

Do these in order. Steps 1–3 are the ones that actually fail.

## 0. Get the repo there

```bash
mkdir -p ~/development/home_assist
git clone <repo> ~/development/home_assist/app   # or copy the folder
cd ~/development/home_assist/app
npm install
cp .env.example .env        # then edit — see step 5
```

**Clone into `app/`, not `home_assist/` itself.** The data directory is
`~/development/home_assist/data` — a *sibling* of the repo, matching how usat
(`usat/sql_programs` + `usat/data`) and wrestling (`wrestling/wrestling_stats` +
`wrestling/data`) are laid out. Clone one level up and the data folder lands inside the repo, where
a `git clean -xfd` would take your users with it.

## 1. Blacklist the DVB-T kernel driver

Linux claims RTL2832U devices as TV tuners by default, so rtl_433 finds "no device" even though the
dongle is plugged in. This is the number-one first-time failure.

```bash
echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/blacklist-rtl.conf
sudo rmmod dvb_usb_rtl28xxu 2>/dev/null
sudo update-initramfs -u
```

Reboot, or unplug/replug the dongle. Verify:

```bash
rtl_test -t        # should list the R820T2 tuner
```

If it says "usb_claim_interface error -6", the driver is still loaded.

## 2. Confirm the decoder actually has protocol 223

The apt build of rtl_433 is frequently too old to include the Badger ORION decoder. Check before
anything else:

```bash
rtl_433 -R help | grep -i orion
```

You want a line mentioning **223 · Badger ORION water meter, 100kbps**.
`node collector_water.js --check` (step 5) runs this same check automatically and reports it.
If it is missing, build from source — there is no workaround, the decoder is simply not in the binary:

```bash
sudo apt install -y libtool libusb-1.0-0-dev librtlsdr-dev rtl-sdr build-essential cmake pkg-config
git clone https://github.com/merbanan/rtl_433.git && cd rtl_433
mkdir build && cd build && cmake .. && make -j4 && sudo make install
```

## 3. Prove reception at the permanent location

Before wiring up services. Antenna at a window facing the pit; extend **USB**, not coax.

```bash
node src/home_assist/modules/water/capture.js 10
```

Look at the reported count for meter `16642655`. Zero means move the antenna — do not proceed and
hope. See `HARDWARE.md`.

## 4. Stop the machine sleeping

A suspended laptop is a silent monitor, and silence is the failure mode this whole project exists to
avoid.

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

Also disable lid-close suspend in `/etc/systemd/logind.conf`:

```
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
```

then `sudo systemctl restart systemd-logind`.

## 5. Configure

Edit `.env`:

```
WATER_RTL433_CMD_LINUX=rtl_433     # already correct if you copied .env from the laptop
MYSQL_*                             # local MySQL on this box
EMAIL_SENDER / EMAIL_PASSWORD / EMAIL_RECIPIENT
HOMEASSIST_ADMIN_USER / HOMEASSIST_ADMIN_PASS
```

**The decoder line needs no edit.** `WATER_RTL433_CMD_WINDOWS` / `_LINUX` / `_MAC` are resolved by
platform — the same suffix convention wrestling_stats uses for
`GOOGLE_APPLICATION_CREDENTIALS_*` — so the laptop's `.env` is already correct here. The
preflight prints which key it used. `.env` is still gitignored and does not travel with the repo,
so you will copy it across (secrets and all) or retype it; the point is that it needs no
per-machine surgery once it is there.

Then:

```bash
npm run db_init
node collector_water.js --check     # preflight: DB, email, settings — no radio, no writes
```

The preflight prints the resolved data dir. On Linux that is
`/home/steve-calla/development/home_assist/data` unless `HOMEASSIST_DATA_DIR` overrides it —
`node src/home_assist/admin.js where` prints it too.

**If the Ubuntu account is not `steve-calla`,** change the one constant at the top of
`utilities/directory_tools/determine_os_path.js`. There is deliberately no per-username lookup (see
`CLAUDE.md` § House rules), so this is a one-line edit rather than a map entry.

**Windows-only caveat, for when you go back to the laptop:** the Windows data path lives inside
MySQL's version-numbered `secure_file_priv` folder
(`C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/data/home_assist`), matching usat_apps and
wrestling_stats. A MySQL 8.0 → 8.4 upgrade or uninstall can relocate or remove it, taking
`auth.json` and `panel_access.json` with it. Low stakes — `auth.json` regenerates on next start, and
the `.env` recovery admin means you cannot be locked out — but worth knowing so it is a shrug
instead of a mystery. Linux is unaffected; its path is under your home directory.

## 6. Build the UI and start under pm2

```bash
npm i -g pm2                # ONE global install — see the note below
npm run home_assist_build
npm run pm2_start_all       # both processes + pm2 save
npm run pm2_startup         # prints a command to run once as root; run what it prints
npm run pm2_save
```

`npm run pm2_status` should show `home_assist` and `water_collector` both online.

**Use the global `pm2`, never `npx pm2`.** The pm2 daemon is a machine-wide singleton, so every
client on the box must be the same version as the running daemon. `npx` resolves to whatever npm has
cached, which produces:

```
>>>> In-memory PM2 is out-of-date, do: $ pm2 update
In memory PM2 version: 5.4.3
Local PM2 version: 7.0.3
```

If you see that, `npm run pm2_update` reloads the daemon to match — but note it **restarts every pm2
app on the machine**, not just ours.

**`pm2_startup` is not optional.** `pm2 save` records the process list; only `pm2 startup` creates
the boot service that replays it. Without it, a power cut leaves the house unmonitored and nothing
tells you.

**Scope of the `_all` scripts:** `pm2_start_all` / `pm2_stop_all` / `pm2_restart_all` /
`pm2_delete_all` name our two processes explicitly, so running one from this repo can never take
down something else you have under pm2. `pm2_list`, `pm2_status`, `pm2_monitor` and `pm2_logs_all`
are machine-wide, but read-only.

## 7. Verify the loop end to end

This is the step people skip, and it is the only one that proves anything:

1. **Test alert** — Water → Settings → *Send a test alert*. An email should arrive. If it does not,
   nothing else on this page matters.
2. **Watchdog** — `npm run stop_all` (or just stop the collector), wait `stale_minutes` (default 90,
   or drop it to 5 temporarily on the Settings page), and confirm the *receiver silent* alert
   arrives and the dashboard flips to offline. **This is the most important test in the project:** a
   monitor that has silently stopped listening reports a flat zero, which looks exactly like a quiet
   night.
3. **Real readings** — Water → Diagnostics → the raw decoder lines should show `Badger-ORION` and
   your id, and the Monitor odometer should be climbing.

## 8. Firewall (LAN only)

The dashboard binds dual-stack so a phone on the home network can reach it. Do not expose 8050 to
the internet — email already covers you when away.

```bash
sudo ufw allow from 192.168.0.0/16 to any port 8050
```

## Windows ↔ Linux differences, in full

| | Windows | Ubuntu |
|---|---|---|
| Decoder command | `WATER_RTL433_CMD_WINDOWS` = full path to `rtl_433_64bit_static.exe` | `WATER_RTL433_CMD_LINUX` = `rtl_433` — **both live in the same .env** |
| Repo | `C:\Users\calla\development\home_assist\app` | `~/development/home_assist/app` |
| Data dir | `C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/data/home_assist` | `/home/steve-calla/development/home_assist/data` |
| rtl_433 | `development\tools\noolec_v4_radio\rtl_433-win-x64-nightly\` | `/usr/local/bin/rtl_433` |
| Process manager | pm2 (or just a terminal) | pm2 + `pm2 startup` |
| DVB blacklist | n/a | required (step 1) |
| Sleep | n/a | must be disabled (step 4) |

Everything else — the code, the schema, the tests — is identical. `path.join` everywhere, no
shell-isms, and `time.js` uses the configured `WATER_TZ` rather than the process timezone precisely
so that moving hosts cannot silently shift the overnight window.
