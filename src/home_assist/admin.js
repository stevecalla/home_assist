'use strict';
// User management CLI for home_assist (mirrors src/usat_apps/admin.js). Usage:
//   node src/home_assist/admin.js add [user]     (prompts for password + role)
//   node src/home_assist/admin.js list
//   node src/home_assist/admin.js passwd <user>  (reset a password)
//   node src/home_assist/admin.js remove <user>
//   node src/home_assist/admin.js access         (show the panel-access config: default + per-user)
//   node src/home_assist/admin.js where          (show where runtime data lives on this machine)
//
// Stored users live OUTSIDE the repo (auth.json under utilities/directory_tools/determine_os_path).
// recovery account (HOMEASSIST_ADMIN_*) is managed in the repo-root .env, not here — that one can
// never be removed, which is what stops you locking yourself out of your own house dashboard.
require('./env');

const readline = require('readline');
const store = require('./auth/auth_store');
const panel_access = require('./access/panel_access');
const data_dir = require('./data_dir');

function ask(rl, q) { return new Promise(function (r) { rl.question(q, r); }); }

async function main() {
  const [cmd, a1] = process.argv.slice(2);

  if (cmd === 'where') {
    const d = data_dir.describe();
    console.log('platform  : ' + d.platform + ' (user ' + d.user + ')');
    console.log('data dir  : ' + d.app_data + (d.overridden ? '   [HOMEASSIST_DATA_DIR]' : ''));
    console.log('  auth.json          ' + data_dir.file_sync('auth.json'));
    console.log('  panel_access.json  ' + data_dir.file_sync('panel_access.json'));
    console.log('  captures/          ' + data_dir.file_sync('captures'));
    console.log('\nresolved by utilities/directory_tools/determine_os_path.js');
    if (process.platform === 'win32') {
      console.log('NOTE: the Windows path is MySQL\'s version-numbered secure_file_priv folder.');
      console.log('      An 8.0 -> 8.4 upgrade can relocate it. auth.json regenerates, and the');
      console.log('      .env recovery admin means you cannot be locked out.');
    }
    return;
  }

  if (cmd === 'list') {
    const env = store.env_accounts();
    env.forEach(function (u) { console.log('  ' + u.user + '  [' + u.role + ', .env recovery]'); });
    const u = store.list_users();
    if (!u.length) console.log('  (no stored users)');
    u.forEach(function (x) { console.log('  ' + x.user + '  [' + (x.role || 'user') + ', stored]'); });
    return;
  }

  if (cmd === 'access') {
    const c = panel_access.get();
    console.log('default:', JSON.stringify(c.default));
    const keys = Object.keys(c.users || {});
    if (!keys.length) console.log('users: (no overrides)');
    else keys.forEach(function (k) { console.log('  ' + k + ': ' + JSON.stringify(c.users[k])); });
    console.log('\npanels: ' + panel_access.catalog().map(function (p) { return p.key; }).join(', '));
    console.log('restricted by default: ' + panel_access.DEFAULT_ALL_EXCLUDE.join(', '));
    return;
  }

  if (cmd === 'passwd' || cmd === 'reset') {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const user = (a1 || (await ask(rl, 'Username to reset: '))).trim();
    if (!store.list_users().some(function (u) { return u.user === user; })) {
      console.log('No such stored user: ' + user); rl.close(); return;
    }
    const pass = (await ask(rl, 'New password: ')).trim();
    store.add_user(user, pass);
    console.log('Password updated for: ' + user);
    rl.close(); return;
  }

  if (cmd === 'remove') {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const users = store.list_users();
    if (!users.length) { console.log('(no stored users to remove)'); rl.close(); return; }
    let user = a1;
    if (!user) {
      console.log('Stored users:');
      users.forEach(function (u, i) { console.log('  ' + (i + 1) + ') ' + u.user); });
      const sel = (await ask(rl, 'Pick a number (or type a username) to remove: ')).trim();
      const idx = parseInt(sel, 10);
      user = (idx >= 1 && idx <= users.length) ? users[idx - 1].user : sel;
    }
    if (!users.some(function (u) { return u.user === user; })) { console.log('No such stored user: ' + user); rl.close(); return; }
    const yn = (await ask(rl, 'Remove "' + user + '"? (y/N): ')).trim().toLowerCase();
    if (yn === 'y' || yn === 'yes') {
      console.log(store.remove_user(user) ? 'Removed: ' + user : 'No such user: ' + user);
      try { panel_access.clear_user(user); } catch (e) { /* ignore */ }
    } else console.log('Cancelled.');
    rl.close(); return;
  }

  if (cmd === 'add') {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const user = (a1 || (await ask(rl, 'Username / email: '))).trim();
    const pass = (await ask(rl, 'Password: ')).trim();
    const role = ((await ask(rl, 'Role (user/admin) [user]: ')).trim().toLowerCase() === 'admin') ? 'admin' : 'user';
    store.add_user(user, pass, role);
    console.log('Added/updated user: ' + user + ' (' + role + ')');
    rl.close(); return;
  }

  console.log('usage: node src/home_assist/admin.js add [user] | passwd <user> | list | remove <user> | access | where');
}

main();
