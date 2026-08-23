'use strict';
// User management CLI for home_assist (mirrors src/usat_apps/admin.js). Usage:
//   node src/home_assist/admin.js add [user]     (prompts for password + role)
//   node src/home_assist/admin.js list
//   node src/home_assist/admin.js passwd <user>  (reset a password)
//   node src/home_assist/admin.js remove <user>
//   node src/home_assist/admin.js access         (show the panel-access config: default + per-user)
//   node src/home_assist/admin.js where          (show where runtime data lives on this machine)
//   node src/home_assist/admin.js envcheck      (is .env complete? compares keys to .env.example)
//   node src/home_assist/admin.js envfix        (de-duplicate .env, keeping the LAST value; backs up first)
//   node src/home_assist/admin.js auth [user] [password]
//                                                (which .env was loaded, what it defines, and
//                                                 whether a credential is accepted — and via which
//                                                 of the two sources. No password is echoed.)
//
// Stored users live OUTSIDE the repo (auth.json under utilities/directory_tools/determine_os_path).
// recovery account (HOMEASSIST_ADMIN_*) is managed in the repo-root .env, not here — that one can
// never be removed, which is what stops you locking yourself out of your own house dashboard.
const env_root = require('./env').ROOT;

const fs = require('fs');
const path = require('path');
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

  /**
   * `auth [user] [password]` — why does THIS credential work, or not.
   *
   * Exists because "I changed the password in .env and the old one still works" has four different
   * causes that look identical from a login form:
   *
   *   1. a STORED user of the same name shadowing the .env recovery account
   *   2. dotenv not overriding a variable already exported in the shell
   *   3. a duplicate key in .env (dotenv keeps the FIRST)
   *   4. the wrong .env — the loader walks up to the repo root, which is not always where you edited
   *
   * Guessing between them costs more than printing the answer. No password is ever echoed; only
   * lengths, so a stale value is visible without being disclosed over someone's shoulder.
   */
  if (cmd === 'auth') {
    const env_path = path.join(env_root, '.env');
    console.log('.env loaded from : ' + env_path + (fs.existsSync(env_path) ? '' : '   [MISSING]'));

    // A duplicate key is invisible in a login form and obvious here.
    //
    // The list of duplicates alone is not actionable, though: a file pasted twice duplicates
    // EVERYTHING, and most pairs are identical and harmless. What matters is which duplicated keys
    // DISAGREE -- those are the ones silently discarding an edit, because dotenv keeps the first.
    //
    // Values are compared, never printed. A config diagnostic you cannot run over a shared screen
    // is one you will not run when you need it.
    try {
      const lines = fs.readFileSync(env_path, 'utf8').split(/\r?\n/);
      const vals = {};
      lines.forEach(function (l) {
        const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
        if (!m) return;
        if (!vals[m[1]]) vals[m[1]] = [];
        vals[m[1]].push(m[2].trim());
      });
      const dupes = Object.keys(vals).filter(function (k) { return vals[k].length > 1; });
      if (dupes.length) {
        const differ = dupes.filter(function (k) {
          return vals[k].some(function (v) { return v !== vals[k][0]; });
        });
        const same = dupes.length - differ.length;
        console.log('WARNING: ' + dupes.length + ' duplicated key(s) in .env. dotenv keeps the FIRST.');
        if (differ.length) {
          console.log('  These DISAGREE — the later value is being discarded:');
          differ.forEach(function (k) {
            console.log('    ' + k + '   (' + vals[k].length + ' occurrences, values differ)');
          });
          console.log('  Fix: edit the FIRST occurrence, or delete the stale block.');
        }
        if (same) console.log('  ' + same + ' duplicated key(s) hold the same value — harmless, but worth tidying.');
      }
    } catch (e) { /* reported as MISSING above */ }

    [['HOMEASSIST_ADMIN_USER', 'HOMEASSIST_ADMIN_PASS'],
     ['HOMEASSIST_TEST_USER', 'HOMEASSIST_TEST_PASS']].forEach(function (pair) {
      const u = process.env[pair[0]];
      const p2 = process.env[pair[1]];
      console.log('  ' + pair[0].replace('HOMEASSIST_', '').padEnd(11) + ' user=' +
        (u ? '[' + u + ']' : '(unset)') + '  password ' +
        (p2 ? p2.length + ' chars' : '(unset)'));
    });

    const stored = store.list_users();
    console.log('stored users     : ' + (stored.length ? stored.map(function (x) { return x.user; }).join(', ') : '(none)'));
    // The shadowing case, named explicitly — it is the one nobody thinks of.
    const env_names = store.env_accounts().map(function (x) { return x.user; });
    const shadowed = stored.filter(function (x) { return env_names.indexOf(x.user) >= 0; });
    if (shadowed.length) {
      console.log('WARNING: also stored, so a .env password change does NOT retire the old one: ' +
        shadowed.map(function (x) { return x.user; }).join(', '));
    }

    if (a1) {
      const pw = process.argv[4];
      if (pw === undefined) { console.log('\nUsage: admin.js auth <user> <password>'); return; }
      const r = store.valid_user(a1, pw);
      console.log('\nvalid_user(' + a1 + ', ...) -> ' +
        (r ? 'ACCEPTED via ' + (r.env ? '.env recovery' : 'stored auth.json') + ' as ' + r.role
           : 'rejected'));
    } else {
      console.log('\nAdd a user and password to test one:  admin.js auth <user> <password>');
    }
    return;
  }

  /**
   * `envfix` — rewrite .env keeping ONLY the last occurrence of each duplicated key.
   *
   * A .env pasted twice discards every later edit silently, because dotenv keeps the FIRST value.
   * Hand-editing a 40-line file with 22 duplicated keys is exactly the kind of task where someone
   * deletes the wrong block and loses a real credential.
   *
   * LAST wins here, deliberately, and it is the opposite of what dotenv does: the later block is
   * where people type their newer values -- you append or paste at the end, you do not scroll up to
   * amend line 3. Losing an edit you just made is worse than losing one you made a month ago.
   *
   * Backs up first, always, and prints the backup path before touching anything. This file holds
   * the Gmail app password and the MySQL password; a rewrite that goes wrong with no copy on disk
   * is not a convenience.
   */
  if (cmd === 'envfix') {
    const env_path = path.join(env_root, '.env');
    if (!fs.existsSync(env_path)) { console.log('No .env at ' + env_path); return; }
    const raw = fs.readFileSync(env_path, 'utf8');
    const lines = raw.split(/\r?\n/);

    const last_index = {};
    lines.forEach(function (l, i) {
      const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m) last_index[m[1]] = i;
    });
    const dropped = [];
    const kept = lines.filter(function (l, i) {
      const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (!m) return true;                                  // comments and blanks survive untouched
      if (last_index[m[1]] === i) return true;
      dropped.push(m[1]);
      return false;
    });

    if (!dropped.length) { console.log('No duplicate keys in ' + env_path + ' — nothing to do.'); return; }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = env_path + '.backup-' + stamp;
    fs.copyFileSync(env_path, backup);
    fs.writeFileSync(env_path, kept.join('\n'), { mode: 0o600 });

    console.log('Backed up to : ' + backup);
    console.log('Rewrote      : ' + env_path);
    console.log('Removed ' + dropped.length + ' earlier duplicate line(s), keeping the LAST value of each:');
    console.log('  ' + Array.from(new Set(dropped)).join(', '));
    console.log('\nRestart the server, then re-check:  node src/home_assist/admin.js auth <user> <password>');
    return;
  }

  /**
   * `envcheck` — is .env still complete after an edit?
   *
   * The contract is `.env.example`, which is committed and curated. A plain grep for
   * `process.env.X` is NOT the contract: settings.js reads its values through DEFS `env:` fields and
   * the platform-suffixed keys go through platform_env(), so a grep misses exactly the keys someone
   * is most likely to have deleted by accident.
   *
   * Names only, never values. The question this answers is "did I remove something that matters",
   * and that is answerable from key names alone.
   */
  if (cmd === 'envcheck') {
    const env_path = path.join(env_root, '.env');
    const ex_path = path.join(env_root, '.env.example');
    if (!fs.existsSync(env_path)) { console.log('No .env at ' + env_path); return; }

    /**
     * `commented` matters only for .env.example, and it is not a detail.
     *
     * The example file documents optional keys COMMENTED OUT with their defaults —
     * `# EMAIL_PORT=587` — which is the convention for "you may set this, here is what it is
     * otherwise". Counting only uncommented lines made the contract look smaller than it is, so a
     * user who legitimately set EMAIL_HOST was told it was undocumented and possibly a typo. A
     * checker that cries wolf about correct config is worse than no checker.
     *
     * Your OWN .env is parsed without it: a commented line there is a value you are not using.
     */
    function keys_of(file, commented) {
      const out = [];
      const counts = {};
      const re = commented
        ? /^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/
        : /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(function (l) {
        const m = l.match(re);
        if (!m) return;
        counts[m[1]] = (counts[m[1]] || 0) + 1;
        if (counts[m[1]] === 1) out.push(m[1]);
      });
      return { list: out, counts: counts };
    }

    const mine = keys_of(env_path);
    const dupes = Object.keys(mine.counts).filter(function (k) { return mine.counts[k] > 1; });
    console.log('.env      : ' + env_path);
    console.log('keys      : ' + mine.list.length + (dupes.length ? '   DUPLICATES: ' + dupes.join(', ') : '   (no duplicates)'));

    if (!fs.existsSync(ex_path)) { console.log('No .env.example to compare against.'); return; }
    const ex = keys_of(ex_path, true);   // commented keys are documented keys

    // Without these the app does not work: no database, or no way to log in.
    const REQUIRED = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE',
      'HOMEASSIST_ADMIN_USER', 'HOMEASSIST_ADMIN_PASS'];

    const missing = ex.list.filter(function (k) { return mine.list.indexOf(k) < 0; });
    const extra = mine.list.filter(function (k) { return ex.list.indexOf(k) < 0; });
    // A third tier, and on a LEAK MONITOR it is not a footnote: without these the app runs, the
    // charts fill in, and nothing can ever tell you about a leak. Silence is not safety, so a
    // missing delivery channel must not sit in the same bucket as a missing port number.
    const ALERTING = ['EMAIL_SENDER', 'EMAIL_PASSWORD', 'EMAIL_RECIPIENT'];
    const missing_required = missing.filter(function (k) { return REQUIRED.indexOf(k) >= 0; });
    const missing_alerting = missing.filter(function (k) { return ALERTING.indexOf(k) >= 0; });
    const missing_optional = missing.filter(function (k) {
      return REQUIRED.indexOf(k) < 0 && ALERTING.indexOf(k) < 0;
    });

    console.log('');
    if (missing_required.length) {
      console.log('MISSING and REQUIRED — the app will not work without these:');
      missing_required.forEach(function (k) { console.log('   ' + k); });
    } else {
      console.log('All required keys present (database + login).');
    }
    if (missing_alerting.length) {
      console.log('\nMISSING and needed to DELIVER ALERTS. The dashboard will look fine and no');
      console.log('leak email can ever be sent — which is the one failure this app exists to avoid:');
      missing_alerting.forEach(function (k) { console.log('   ' + k); });
    }
    if (missing_optional.length) {
      console.log('\nIn .env.example but not in your .env — each falls back to a built-in default,');
      console.log('so this is only a problem if you were relying on your own value:');
      missing_optional.forEach(function (k) { console.log('   ' + k); });
    }
    if (extra.length) {
      console.log('\nIn your .env but not documented in .env.example — a typo, or a key added since:');
      extra.forEach(function (k) { console.log('   ' + k); });
    }
    // The suffix convention is the one people trip on: ONE .env is shared between the Windows
    // laptop and the Ubuntu box, so both suffixes belong in the file even though only one resolves
    // on the machine you are standing at.
    const suffixed = mine.list.filter(function (k) { return /_(WINDOWS|LINUX|MAC)$/.test(k); });
    if (suffixed.length) {
      console.log('\nPlatform-suffixed keys (this machine resolves _' +
        (process.platform === 'win32' ? 'WINDOWS' : process.platform === 'darwin' ? 'MAC' : 'LINUX') + '):');
      suffixed.forEach(function (k) { console.log('   ' + k); });
    }
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
