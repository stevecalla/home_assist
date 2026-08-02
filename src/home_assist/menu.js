#!/usr/bin/env node
/**
 * menu.js — interactive launcher for home_assist.
 *
 *   npm run home_assist_menu        (or: node src/home_assist/menu.js)
 *
 * Numbered menu built on Node's readline (no extra packages). Same pattern as
 * src/usat_apps/menu.js: a per-item short description, a [t] toggle to show/hide the underlying
 * CLI command (persisted to .menu_prefs.json), and [q] to quit. Self-contained — runs node/npm
 * directly, and works identically on Windows Git Bash and Ubuntu.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawn, execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.HOMEASSIST_PORT) || 8050;
const VITE_PORT = 5176;
const PREFS_FILE = path.join(__dirname, '.menu_prefs.json');
// Every RADIO item routes through listen.js rather than invoking rtl_433 directly: the binary is
// platform-resolved from .env (a bare `rtl_433` works on Ubuntu and on neither Windows machine),
// and listen.js is what stops the collector for the duration and restarts it afterwards. The dongle
// has exactly one owner at a time.
const LISTEN = 'src/home_assist/modules/water/listen.js';

const RESET = '\x1b[0m', BOLD = '\x1b[1m', DIM = '\x1b[2m';
const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m', BLUE = '\x1b[34m';
const c = (color, t) => `${color}${t}${RESET}`;

let _show_cli = false;
function load_prefs() {
  try { const j = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); if (typeof j.show_cli === 'boolean') _show_cli = j.show_cli; }
  catch (e) { /* defaults */ }
}
function save_prefs() {
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify({ show_cli: _show_cli }, null, 2) + '\n'); }
  catch (e) { /* ignore */ }
}

function prompt(rl, q) { return new Promise((res) => rl.question(q, res)); }

// Run a command (node or npm) with inherited stdio. shell:true on Windows so `npm` resolves.
function run_cmd(bin, args, label, cwd) {
  console.log(c(DIM, `  Running: ${bin} ${args.join(' ')}  (cwd: ${path.relative(REPO_ROOT, cwd || REPO_ROOT) || '.'})  (Ctrl-C to stop)\n`));
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd: cwd || REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    proc.on('close', (code) => {
      console.log(code === 0 ? c(GREEN, `\n  ✓ ${label} done.`) : c(RED, `\n  ✗ ${label} exited (${code}).`));
      resolve(code);
    });
  });
}

function open_url(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  try { execSync(cmd, { stdio: 'ignore' }); console.log(c(DIM, `  Opened ${url}`)); }
  catch (e) { console.log(`  Open manually: ${url}`); }
}

function hit_endpoint(pathname) {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${PORT}${pathname}`, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
      res.on('end', () => {
        console.log(c(res.statusCode < 400 ? GREEN : YELLOW, `  GET ${pathname} -> HTTP ${res.statusCode}`));
        console.log('  ' + b);
        if (res.statusCode === 401) console.log(c(DIM, '  (401 = no session cookie from this tool — sign in at the UI first.)'));
        resolve();
      });
    }).on('error', (e) => {
      console.log(c(YELLOW, `  Backend not reachable on :${PORT} — is it running? (${e.code || e.message})`));
      resolve();
    });
  });
}

const SECTIONS = [
  { label: 'RUN — web app', color: YELLOW, items: [
    { label: 'Dev — API + web (hot reload)', desc: 'Backend + Vite together; edits show live', bin: 'npm', args: ['run', 'home_assist_dev_all'], cli: 'npm run home_assist_dev_all' },
    { label: 'Dev — backend only (nodemon)', desc: `Express API on :${PORT}, auto-restarts on change`, bin: 'npm', args: ['run', 'home_assist_dev'], cli: 'npm run home_assist_dev' },
    { label: 'Dev — web only (Vite)', desc: `React UI on :${VITE_PORT}, proxies /api to :${PORT}`, bin: 'npm', args: ['run', 'home_assist_web'], cli: 'npm run home_assist_web' },
    { label: 'Build the web app', desc: 'npm install + compile React to web/dist', bin: 'npm', args: ['run', 'home_assist_build'], cli: 'npm run home_assist_build' },
    { label: `Start built server (:${PORT})`, desc: 'Express serves the built UI + API on one port', bin: 'npm', args: ['run', 'home_assist_server'], cli: 'npm run home_assist_server' },
  ]},

  { label: 'RUN — water collector (the radio)', color: BLUE, items: [
    { label: 'Collector — LIVE', desc: 'Spawn rtl_433 and read the real meter. This is the one that must stay up.', bin: 'npm', args: ['run', 'water_collector'], cli: 'npm run water_collector' },
    { label: 'Collector — preflight only', desc: 'Check DB, email and settings, print them, exit. Run this first on a new machine.', bin: 'node', args: ['collector_water.js', '--check'], cli: 'node collector_water.js --check' },
    { label: 'Collector — REPLAY (no dongle)', desc: 'Synthetic meter. Lets you build/see the UI with no hardware attached.', bin: 'npm', args: ['run', 'water_replay'], cli: 'npm run water_replay' },
    { label: 'Collector — REPLAY with a leak', desc: 'Synthetic running toilet — proves the continuous-flow rule and the alert email really fire.', bin: 'node', args: ['collector_water.js', '--replay', '--leak'], cli: 'node collector_water.js --replay --leak' },
    { label: 'Raw capture (rtl_433 to a file)', desc: 'Save decoder output to the data folder for later replay / field-name forensics.', bin: 'node', args: ['src/home_assist/modules/water/capture.js'], cli: 'node src/home_assist/modules/water/capture.js' },
  ]},

  { label: 'RADIO — listen to it yourself', color: BLUE, items: [
    { label: 'Listen — MY meter', desc: 'The collector\'s exact tuning, readable. Answers "is the radio hearing the meter right now"', bin: 'node', args: [LISTEN, 'meter'], cli: 'node ' + LISTEN + ' meter' },
    { label: 'Listen — the neighbourhood', desc: '915M / 1024k. Everything nearby EXCEPT your meter — 916.45 is outside this window, by design', bin: 'node', args: [LISTEN, 'nearby'], cli: 'node ' + LISTEN + ' nearby' },
    { label: 'Listen — neighbourhood + mine', desc: '916M / 2400k. Both in one window, so a neighbour\'s signal works as a fixed reference for antenna moves', bin: 'node', args: [LISTEN, 'wide'], cli: 'node ' + LISTEN + ' wide' },
    { label: 'Listen — hop the WHOLE band', desc: '902–928 MHz in 13 hops of 2.4 MHz, 20s each. Discovery only: you hear any one slice 8% of the time, and it holds the dongle for ~4 min', bin: 'node', args: [LISTEN, 'sweep'], cli: 'node ' + LISTEN + ' sweep' },
    { label: 'Signal figures (antenna work)', desc: 'Per-packet rssi/snr/freq in a table, with a running mean. What to watch while moving the aerial', bin: 'node', args: [LISTEN, 'signal'], cli: 'node ' + LISTEN + ' signal' },
    { label: 'Is protocol 223 in this build?', desc: 'rtl_433 -R help, filtered to Orion. No dongle needed, does not touch the collector', bin: 'node', args: [LISTEN, 'check'], cli: 'node ' + LISTEN + ' check' },
  ]},

  { label: 'DATABASE', color: CYAN, items: [
    { label: 'Create DB + tables', desc: 'CREATE DATABASE if missing, then all tables (idempotent)', bin: 'npm', args: ['run', 'db_init'], cli: 'npm run db_init' },
    { label: 'Show recent readings', desc: 'Last 20 accepted meter readings straight from MySQL', bin: 'node', args: ['src/home_assist/modules/water/report.js', 'readings'], cli: 'node src/home_assist/modules/water/report.js readings' },
    { label: 'Show hourly usage', desc: 'The hour buckets the leak rules actually read', bin: 'node', args: ['src/home_assist/modules/water/report.js', 'hourly'], cli: 'node src/home_assist/modules/water/report.js hourly' },
    { label: 'Show alert history', desc: 'Every alert fired, delivered or not', bin: 'node', args: ['src/home_assist/modules/water/report.js', 'alerts'], cli: 'node src/home_assist/modules/water/report.js alerts' },
    { label: 'Show settings', desc: 'Current thresholds (DB values over .env over built-in defaults)', bin: 'node', args: ['src/home_assist/modules/water/report.js', 'settings'], cli: 'node src/home_assist/modules/water/report.js settings' },
    { label: 'DB size + growth projection', desc: 'Rows and MB per water table, plus rows/year projected from what has actually been observed', bin: 'node', args: ['src/home_assist/modules/water/report.js', 'dbsize'], cli: 'node src/home_assist/modules/water/report.js dbsize' },
    { label: 'Clear all meter data (dry run)', desc: 'Shows what a reset WOULD empty; changes nothing. Settings are kept', bin: 'npm', args: ['run', 'water_reset'], cli: 'npm run water_reset' },
    { label: 'Clear all meter data — DO IT', desc: 'DESTRUCTIVE. Stops the collector, empties readings/hourly/alerts/raw/state, flushes the log, restarts. Settings are kept', bin: 'npm', args: ['run', 'water_reset_confirm'], cli: 'npm run water_reset_confirm', confirm: 'This erases all recorded meter history. Your thresholds and meter id are kept.' },
  ]},

  { label: 'TESTS (fast, no DB, no radio)', color: CYAN, items: [
    { label: 'Run all tests', desc: 'Auth/access + leak rules + ingest guards + time — about a second', bin: 'npm', args: ['run', 'home_assist_test'], cli: 'npm run home_assist_test' },
    { label: 'Leak-rule tests only', desc: 'Overnight / continuous flow / watchdog / summary', bin: 'node', args: ['src/home_assist/run_tests.js', 'modules/water'], cli: 'node src/home_assist/run_tests.js modules/water' },
    { label: 'Auth + access tests only', desc: 'Passwords, sessions, tamper rejection, panel access', bin: 'node', args: ['src/home_assist/run_tests.js', 'tests/auth'], cli: 'node src/home_assist/run_tests.js tests/auth' },
    { label: 'Syntax check every file', desc: 'node --check across the repo — catches the 2am pm2 crash class', bin: 'npm', args: ['run', 'home_assist_check'], cli: 'npm run home_assist_check' },
  ]},

  { label: 'USERS & ACCESS', color: CYAN, items: [
    { label: 'Add / update a user', desc: 'Create a web login (username/email, password, role)', bin: 'node', args: ['src/home_assist/admin.js', 'add'], cli: 'node src/home_assist/admin.js add' },
    { label: 'List users', desc: 'Show .env recovery + stored logins', bin: 'node', args: ['src/home_assist/admin.js', 'list'], cli: 'node src/home_assist/admin.js list' },
    { label: 'Reset a password', desc: 'Set a new password for an existing stored login', bin: 'node', args: ['src/home_assist/admin.js', 'passwd'], cli: 'node src/home_assist/admin.js passwd' },
    { label: 'Remove a user', desc: 'Delete a stored login (prompts + confirm)', bin: 'node', args: ['src/home_assist/admin.js', 'remove'], cli: 'node src/home_assist/admin.js remove' },
    { label: 'Show panel access', desc: 'Default + per-user allow-list + the panel catalog', bin: 'node', args: ['src/home_assist/admin.js', 'access'], cli: 'node src/home_assist/admin.js access' },
    { label: 'Where does data live?', desc: 'The resolved out-of-repo paths on THIS machine', bin: 'node', args: ['src/home_assist/admin.js', 'where'], cli: 'node src/home_assist/admin.js where' },
  ]},

  { label: 'OPEN / CHECK', color: GREEN, items: [
    { label: 'Open built UI', desc: `Single-port app at :${PORT}`, open: `http://localhost:${PORT}`, cli: `open http://localhost:${PORT}` },
    { label: 'Open dev UI', desc: `Vite dev server (hot reload) at :${VITE_PORT}`, open: `http://localhost:${VITE_PORT}`, cli: `open http://localhost:${VITE_PORT}` },
    { label: 'API status', desc: 'GET /api/status — liveness (public)', endpoint: '/api/status', cli: `curl http://localhost:${PORT}/api/status` },
    { label: 'API health (incl. MySQL)', desc: 'GET /api/health — liveness + database reachability', endpoint: '/api/health', cli: `curl http://localhost:${PORT}/api/health` },
    { label: 'Whoami', desc: 'GET /api/me — user + role + panels (needs a browser session)', endpoint: '/api/me', cli: `curl http://localhost:${PORT}/api/me` },
  ]},

  { label: 'DOCS', color: CYAN, items: [
    { label: 'Where the docs are', desc: 'Print the plans_and_notes layout and what each file is for', docs: true, cli: 'ls -R plans_and_notes src/home_assist/plans_and_notes' },
  ]},

  { label: 'PM2 (production — the Ubuntu box)', color: RED, items: [
    { label: 'Start this stack', desc: 'Web server + water collector, then pm2 save. Only touches these two.', bin: 'npm', args: ['run', 'pm2_start_all'], cli: 'npm run pm2_start_all' },
    { label: 'Status / list', desc: 'Everything pm2 is managing on this machine', bin: 'npm', args: ['run', 'pm2_status'], cli: 'npm run pm2_status' },
    { label: 'Restart the collector', desc: 'The radio process only — the one that must stay up', bin: 'npm', args: ['run', 'pm2_restart_water_collector'], cli: 'npm run pm2_restart_water_collector' },
    { label: 'Restart the web server', desc: 'The dashboard only; alerts keep running throughout', bin: 'npm', args: ['run', 'pm2_restart_home_assist'], cli: 'npm run pm2_restart_home_assist' },
    { label: 'Logs — collector', desc: 'Every accepted reading shows here (last 200 lines)', bin: 'npm', args: ['run', 'pm2_logs_water_collector'], cli: 'npm run pm2_logs_water_collector' },
    { label: 'Logs — web server', desc: 'Request log, minus the dashboard\'s 5s status poll', bin: 'npm', args: ['run', 'pm2_logs_home_assist'], cli: 'npm run pm2_logs_home_assist' },
    { label: 'Details — collector', desc: 'pm2 show: restarts, uptime, memory, log paths', bin: 'npm', args: ['run', 'pm2_show_water_collector'], cli: 'npm run pm2_show_water_collector' },
    { label: 'Monitor (live dashboard)', desc: 'pm2 monit — CPU/memory for every process', bin: 'npm', args: ['run', 'pm2_monitor'], cli: 'npm run pm2_monitor' },
    { label: 'Stop this stack', desc: 'Stops our two ONLY. Leak detection stops — you are unprotected until restarted.', bin: 'npm', args: ['run', 'pm2_stop_all'], cli: 'npm run pm2_stop_all' },
    { label: 'Survive a reboot', desc: 'pm2 startup — prints a command to run once, as admin. Without it nothing comes back after a power cut.', bin: 'npm', args: ['run', 'pm2_startup'], cli: 'npm run pm2_startup' },
    { label: 'Fix "In-memory PM2 is out-of-date"', desc: 'pm2 update — reloads the daemon to match the CLI. Restarts EVERY pm2 app on the machine.', bin: 'npm', args: ['run', 'pm2_update'], cli: 'npm run pm2_update' },
    { label: 'Deploy (build + restart both)', desc: 'Build the SPA, restart both processes, pm2 save', bin: 'npm', args: ['run', 'deploy'], cli: 'npm run deploy' },
  ]},
];

// Menu numbers are assigned by POSITION, not written into each item. Inserting a section used to
// mean renumbering everything below it by hand, which is exactly the sort of edit that silently
// leaves two items sharing an id.
let _next_id = 0;
for (const s of SECTIONS) for (const it of s.items) it.id = ++_next_id;

const ALL = SECTIONS.flatMap((s) => s.items);

// Docs live in two places, mirroring usat_apps: repo-root plans_and_notes/ for cross-cutting plans,
// src/home_assist/plans_and_notes/<module>/ per module. Printed here so the layout is discoverable
// without going looking for it.
const DOCS = [
  ['plans_and_notes/PLATFORM_PLAN.md', 'roadmap, standing constraints, candidate module #2'],
  ['plans_and_notes/ADDING_A_MODULE.md', 'the recipe: worked example + checklist'],
  ['plans_and_notes/CLOUDFLARE_AND_REMOTE_ACCESS.md', 'exposing it beyond the LAN — and whether to'],
  ['src/home_assist/plans_and_notes/README_HOME_ASSIST.md', 'the charter — why it is built this way'],
  ['src/home_assist/plans_and_notes/STATUS.md', 'platform snapshot: built / verified / needs you'],
  ['src/home_assist/plans_and_notes/water/STATUS.md', 'water module snapshot'],
  ['src/home_assist/plans_and_notes/water/BUILD_PLAN.md', 'the plan it was built against'],
  ['src/home_assist/plans_and_notes/water/HARDWARE.md', 'the meter + radio, and how we know'],
  ['src/home_assist/plans_and_notes/water/UBUNTU_DEPLOY.md', 'the 24/7 host runbook'],
  ['src/home_assist/plans_and_notes/water/RTL433_FIELD_GUIDE.md', 'listening to the radio yourself — the RADIO menu items, and the native commands under them'],
  ['src/home_assist/plans_and_notes/_template/', 'copy into <module>/ when adding a feature'],
  ['README.md', 'what it does'],
  ['CLAUDE.md', 'how to change it'],
];

function print_docs() {
  console.log(c(BOLD, '  Documentation\n'));
  DOCS.forEach(function (d) {
    const exists = fs.existsSync(path.join(REPO_ROOT, d[0].replace(/\/$/, '')));
    console.log('  ' + (exists ? c(GREEN, '✓') : c(YELLOW, '?')) + ' ' + d[0]);
    console.log('      ' + c(DIM, d[1]));
  });
  console.log('\n  ' + c(DIM, 'notes.txt at either level is a gitignored scratch pad.'));
}

function print_menu() {
  console.clear();
  console.log(c(BOLD + CYAN, '\n  home_assist') + c(DIM, '   —  water leak monitor'));
  console.log(c(DIM, '  ─────────────────────────────────────────────────────────\n'));
  for (const s of SECTIONS) {
    console.log(c(s.color + BOLD, `  ${s.label}`));
    for (const it of s.items) {
      console.log(`  ${c(BOLD, String(it.id).padStart(3) + '.')} ${it.label.padEnd(34)} ${c(DIM, it.desc)}`);
      if (_show_cli && it.cli) console.log('       ' + c(DIM, '$ ' + it.cli));
    }
    console.log('');
  }
  console.log('  ' + c(BOLD + YELLOW, '[t]') + c(DIM, ` toggle CLI commands (${_show_cli ? 'on' : 'off'})    `) +
    c(BOLD + YELLOW, '[q]') + c(DIM, ' quit') + c(DIM, '    (or 0 to exit)'));
}

async function main() {
  load_prefs();
  let rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  while (true) {
    print_menu();
    const ans = (await prompt(rl, c(BOLD, '\n  Select: '))).trim().toLowerCase();
    if (ans === 'q' || ans === 'quit' || ans === '0') { console.log(c(DIM, '\n  Bye.')); rl.close(); return; }
    if (ans === 't') { _show_cli = !_show_cli; save_prefs(); continue; }
    const it = ALL.find((x) => x.id === parseInt(ans, 10));
    console.log('');
    if (it && it.interactive && it.bin) {
      // Interactive sub-menu: release our readline so the child owns stdin, then recreate ours.
      rl.close();
      await run_cmd(it.bin, it.args, it.label, it.cwd);
      rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      continue;
    }
    // A destructive item has to be typed out in full. "y" is muscle memory; "yes" is a decision.
    if (it && it.confirm) {
      console.log(c(BOLD + YELLOW, '  ' + it.label));
      console.log(c(YELLOW, '  ' + it.confirm) + '\n');
      const ok = (await prompt(rl, c(BOLD, '  Type "yes" to continue (anything else cancels): '))).trim().toLowerCase();
      console.log('');
      if (ok !== 'yes') {
        console.log(c(DIM, '  Cancelled — nothing was changed.'));
        await prompt(rl, c(DIM, '\n  Press Enter to continue…'));
        continue;
      }
    }

    if (!it) console.log(c(YELLOW, '  Invalid choice.'));
    else if (it.docs) print_docs();
    else if (it.bin) await run_cmd(it.bin, it.args, it.label, it.cwd);
    else if (it.open) open_url(it.open);
    else if (it.endpoint) await hit_endpoint(it.endpoint);
    await prompt(rl, c(DIM, '\n  Press Enter to continue…'));
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { SECTIONS, ALL, DOCS, REPO_ROOT };
