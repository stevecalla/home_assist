'use strict';
/**
 * pm2_startup_help — `pm2 startup`, wrapped so it stops looking like a failure.
 *
 * Bare `pm2 startup` cannot install anything: writing a systemd unit needs root, and pm2 will not
 * sudo on your behalf. So it PRINTS the command you must run and exits **1**. Through the menu that
 * rendered as "x Survive a reboot exited (1)" — a red cross on a command that had just done the
 * only thing it is able to do, which is the kind of false alarm that teaches you to ignore real
 * ones.
 *
 * This runs the same command, keeps its output, explains what to do with it, and exits 0.
 *
 * Deliberately NOT part of `deploy`. `pm2 save` belongs there — it records the process list and
 * changes every time that list does. `pm2 startup` is a once-per-machine, root-level, Linux-only
 * step; chaining it would print the same instructions on every deploy and break the && chain.
 */
const { spawnSync } = require('child_process');

const line = (s) => console.log(s);

if (process.platform !== 'linux') {
  line('');
  line('  pm2 startup is Linux-only — it installs a systemd unit.');
  line('  On Windows, use pm2-installer or a Scheduled Task if you want pm2 to survive a reboot.');
  line('  Nothing to do here.');
  line('');
  process.exit(0);
}

const r = spawnSync('pm2', ['startup'], { encoding: 'utf8', windowsHide: true });
const out = ((r.stdout || '') + (r.stderr || '')).trim();

// The line pm2 wants you to run always begins with sudo.
const cmd = out.split('\n').map((l) => l.trim()).find((l) => l.indexOf('sudo ') === 0);

line('');
if (!cmd) {
  // Either pm2 is missing, or it is already installed and had nothing to print.
  line(out || '  pm2 produced no output — is pm2 installed globally? (npm i -g pm2)');
  line('');
  process.exit(0);
}

line('  ONE-TIME SETUP — this is what makes pm2 come back after a reboot.');
line('');
line('  Copy this line and run it as root. You only ever do this once per machine:');
line('');
line('    ' + cmd);
line('');
line('  Then, with both processes running:');
line('');
line('    npm run pm2_status && npm run pm2_save');
line('');
line('  Verify, and then actually test it:');
line('');
line('    systemctl is-enabled pm2-$USER      # want: enabled');
line('    sudo reboot                          # the only test that counts');
line('');
line('  CAUTION: the path above is pinned to the node version you are running now. If you');
line('  later upgrade node and remove that version, the unit points at a binary that no longer');
line('  exists — pm2 will not start at boot and you will not find out until the next power cut.');
line('  Re-run this command after any node upgrade.');
line('');
process.exit(0);
