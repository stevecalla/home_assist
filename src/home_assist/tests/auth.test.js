'use strict';
/**
 * auth.test.js — authentication + authorization, with no database and no network.
 *
 * Exercises the whole chain the platform depends on: password hashing, the .env recovery account
 * that must never lock you out, session signing and tamper rejection, the module-driven panel
 * catalog, and the default/per-user/admin access model.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the runtime data dir at a throwaway folder BEFORE anything resolves a file path.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'home_assist-test-'));
process.env.HOMEASSIST_DATA_DIR = TMP;
process.env.HOMEASSIST_ADMIN_USER = 'skip';
process.env.HOMEASSIST_ADMIN_PASS = 'recovery-pass';
delete process.env.HOMEASSIST_SESSION_SECRET;

const store = require('../auth/auth_store');
const session = require('../auth/session');
const panel_access = require('../access/panel_access');

test.after(function () { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ } });

// ───────────────────────────── passwords ─────────────────────────────

test('password hashing round-trips and rejects the wrong password', function () {
  const h = store.hash_password('correct horse');
  assert.match(h, /^scrypt\$/);
  assert.strictEqual(store.verify_password('correct horse', h), true);
  assert.strictEqual(store.verify_password('wrong horse', h), false);
});

test('the same password hashes differently each time (per-user salt)', function () {
  assert.notStrictEqual(store.hash_password('same'), store.hash_password('same'));
});

test('a malformed stored hash is rejected, not crashed on', function () {
  assert.strictEqual(store.verify_password('x', 'garbage'), false);
  assert.strictEqual(store.verify_password('x', null), false);
});

// ───────────────────────────── users ─────────────────────────────

test('the .env recovery account always works and is an admin', function () {
  const v = store.valid_user('skip', 'recovery-pass');
  assert.ok(v);
  assert.strictEqual(v.role, 'admin');
  assert.strictEqual(v.env, true);
});

test('the recovery account rejects a wrong password', function () {
  assert.strictEqual(store.valid_user('skip', 'nope'), null);
});

test('add / validate / remove a stored user', function () {
  store.add_user('helper', 'hunter22', 'user');
  const v = store.valid_user('helper', 'hunter22');
  assert.ok(v);
  assert.strictEqual(v.role, 'user');
  assert.ok(store.list_users().some(function (u) { return u.user === 'helper'; }));

  assert.strictEqual(store.remove_user('helper'), true);
  assert.strictEqual(store.valid_user('helper', 'hunter22'), null);
  assert.strictEqual(store.remove_user('helper'), false);
});

test('add_user on an existing user updates the password', function () {
  store.add_user('rotate', 'first-pass', 'user');
  store.add_user('rotate', 'second-pass');
  assert.strictEqual(store.valid_user('rotate', 'first-pass'), null);
  assert.ok(store.valid_user('rotate', 'second-pass'));
  store.remove_user('rotate');
});

test('login_configured sees the recovery account', function () {
  assert.strictEqual(store.login_configured(), true);
});

// ───────────────────────────── sessions ─────────────────────────────

test('a session signs and verifies', function () {
  const secret = store.session_secret();
  const token = session.sign({ user: 'skip', role: 'admin', ts: Date.now() }, secret);
  const p = session.verify(token, secret);
  assert.strictEqual(p.user, 'skip');
  assert.strictEqual(p.role, 'admin');
});

test('a tampered session is rejected', function () {
  const secret = store.session_secret();
  const token = session.sign({ user: 'skip', role: 'user', ts: Date.now() }, secret);
  const [body, mac] = token.split('.');
  // Re-encode the payload as an admin, keeping the original signature.
  const forged = Buffer.from(JSON.stringify({ user: 'skip', role: 'admin', ts: Date.now() }))
    .toString('base64url') + '.' + mac;
  assert.strictEqual(session.verify(forged, secret), null);
  assert.ok(body);
});

test('a session signed with a different secret is rejected', function () {
  const token = session.sign({ user: 'skip', role: 'admin', ts: Date.now() }, 'secret-a');
  assert.strictEqual(session.verify(token, 'secret-b'), null);
});

test('an expired session is rejected', function () {
  const secret = store.session_secret();
  const old = Date.now() - session.MAX_AGE_MS - 1000;
  const token = session.sign({ user: 'skip', role: 'admin', ts: old }, secret);
  assert.strictEqual(session.verify(token, secret), null);
});

test('garbage is rejected without throwing', function () {
  assert.strictEqual(session.verify('', 'k'), null);
  assert.strictEqual(session.verify('no-dot', 'k'), null);
  assert.strictEqual(session.verify('a.b', 'k'), null);
});

test('cookie parsing handles the usual header shapes', function () {
  const c = session.parse_cookies('a=1; home_assist_session=abc.def; other=x');
  assert.strictEqual(c[session.COOKIE], 'abc.def');
  assert.deepStrictEqual(session.parse_cookies(''), {});
  assert.deepStrictEqual(session.parse_cookies(undefined), {});
});

// ───────────────────────── panel catalog + access ─────────────────────────

test('the panel catalog is built from the module registry', function () {
  const keys = panel_access.keys();
  // Contributed by modules/water/module.js — proof the registry drives the catalog. ONE PER PAGE:
  // two coarse panels stopped describing seven pages, and "Water settings" had quietly come to
  // include the Meters page, which decides who gets emailed at 3am.
  ['water-monitor', 'water-history', 'water-alerts', 'water-reference',
    'water-settings', 'water-meters', 'water-diagnostics'].forEach(function (k) {
    assert.ok(keys.includes(k), k + ' missing from the catalog');
  });
  // The old coarse keys must be GONE from the catalog — they survive only as a migration mapping.
  assert.ok(!keys.includes('water'), 'the coarse water panel must be retired');
  assert.ok(!keys.includes('water-admin'), 'the coarse water-admin panel must be retired');
  // Contributed by the platform itself.
  assert.ok(keys.includes('admin'), 'admin panel missing');
});

test('catalog entries carry a label and a group for the rail', function () {
  const water = panel_access.catalog().find(function (p) { return p.key === 'water-monitor'; });
  assert.ok(water);
  assert.strictEqual(water.group, 'Water');
  assert.ok(water.label);
  // Every water panel shares one group, so the Admin page renders them under a single select-all.
  // Seven separate checkboxes with no group toggle is what makes per-page permissions tedious.
  panel_access.catalog().filter(function (p) { return p.key.indexOf('water') === 0; })
    .forEach(function (p) { assert.strictEqual(p.group, 'Water', p.key + ' must sit in the Water group'); });
});

test('an admin sees every panel', function () {
  const panels = panel_access.effective_panels('skip', 'admin');
  assert.deepStrictEqual(panels.slice().sort(), panel_access.keys().slice().sort());
  assert.strictEqual(panel_access.is_allowed('skip', 'admin', 'admin'), true);
});

test('a default user reads the data but cannot change who gets emailed', function () {
  const panels = panel_access.effective_panels('nobody', 'user');
  ['water-monitor', 'water-history', 'water-alerts', 'water-reference'].forEach(function (k) {
    assert.ok(panels.includes(k), 'a new user should see ' + k);
  });
  // The three that CHANGE something or expose the plumbing need an explicit grant.
  ['water-settings', 'water-meters', 'water-diagnostics'].forEach(function (k) {
    assert.ok(!panels.includes(k), k + ' must need an explicit grant');
  });
  assert.ok(!panels.includes('admin'), 'user admin must need an explicit grant');
});

test('the admin panel is hard-gated even if somehow granted', function () {
  panel_access.set_user('sneaky', ['water-monitor', 'admin']);
  assert.strictEqual(panel_access.is_allowed('sneaky', 'user', 'admin'), false);
  panel_access.clear_user('sneaky');
});

test('a per-user override narrows access', function () {
  panel_access.set_user('narrow', ['water-monitor']);
  assert.deepStrictEqual(panel_access.effective_panels('narrow', 'user'), ['water-monitor']);
  assert.strictEqual(panel_access.is_allowed('narrow', 'user', 'water-monitor'), true);
  assert.strictEqual(panel_access.is_allowed('narrow', 'user', 'water-history'), false);
  assert.strictEqual(panel_access.is_allowed('narrow', 'user', 'water-meters'), false);
  panel_access.clear_user('narrow');
  assert.ok(panel_access.effective_panels('narrow', 'user').includes('water-monitor'));
});

test('a per-user override can grant a restricted panel', function () {
  panel_access.set_user('trusted', ['water-monitor', 'water-settings']);
  assert.strictEqual(panel_access.is_allowed('trusted', 'user', 'water-settings'), true);
  // Granting Settings must NOT hand over the Meters page — that separation is the whole reason
  // for the split, since Meters is where alert recipients are set.
  assert.strictEqual(panel_access.is_allowed('trusted', 'user', 'water-meters'), false);
  panel_access.clear_user('trusted');
});

test('unknown panel keys are dropped rather than stored', function () {
  panel_access.set_user('typo', ['water-monitor', 'not-a-real-panel']);
  assert.deepStrictEqual(panel_access.effective_panels('typo', 'user'), ['water-monitor']);
  panel_access.clear_user('typo');
});

test('a grant written before the split still means what it meant', function () {
  // THE migration test. normalize() filters unknown keys, so a stored ['water'] would otherwise
  // become [] and lock that user out of everything -- silently, discovered only when someone says
  // the app went blank. Retired keys expand to the panels they used to cover.
  panel_access.set_user('legacy', ['water']);
  const view = panel_access.effective_panels('legacy', 'user');
  assert.deepStrictEqual(view.slice().sort(),
    ['water-alerts', 'water-history', 'water-monitor', 'water-reference']);
  assert.ok(!view.includes('water-meters'), 'expansion must not widen the old grant');

  panel_access.set_user('legacy', ['water', 'water-admin']);
  const all = panel_access.effective_panels('legacy', 'user');
  assert.strictEqual(all.length, 7, 'the two old keys covered all seven pages between them');
  assert.ok(all.includes('water-meters') && all.includes('water-diagnostics'));

  // Expansion is deduplicated: the old and new keys together must not produce repeats.
  panel_access.set_user('legacy', ['water', 'water-monitor']);
  const mixed = panel_access.effective_panels('legacy', 'user');
  assert.strictEqual(new Set(mixed).size, mixed.length, 'no duplicate keys');
  panel_access.clear_user('legacy');
});

test('the default grant can be narrowed for everyone at once', function () {
  panel_access.set_default([]);
  assert.deepStrictEqual(panel_access.effective_panels('anyone', 'user'), []);
  assert.strictEqual(panel_access.is_allowed('anyone', 'user', 'water-monitor'), false);
  // ...but never for an admin
  assert.strictEqual(panel_access.is_allowed('skip', 'admin', 'water-monitor'), true);
  panel_access.set_default('all');
});

test('a role-governed panel cannot be stored as a grant', function () {
  // The bug this closes: an admin ticks "Users & access" for a user, it saves, the summary line
  // dutifully reports the user can see it — and is_allowed() refuses it anyway, because `admin` is
  // governed by the ROLE. A stored permission the authorization check ignores is worse than a
  // missing feature: it reads as done.
  panel_access.set_user('roleless', ['water-monitor', 'admin']);
  const stored = panel_access.get().users.roleless;
  assert.deepStrictEqual(stored, ['water-monitor'], 'admin must not survive into the file');
  assert.strictEqual(panel_access.is_allowed('roleless', 'user', 'admin'), false);
  panel_access.clear_user('roleless');

  // Same for the default list — the select-all in the UI made this one click.
  panel_access.set_default(['water-monitor', 'admin']);
  assert.deepStrictEqual(panel_access.get().default, ['water-monitor']);
  panel_access.set_default('all');

  // It stays in the CATALOG though: labels still have to resolve wherever a key is rendered.
  assert.ok(panel_access.keys().includes('admin'), 'admin remains a catalog entry');
});

test('the admin checkbox is disabled in the UI, not merely ignored', function () {
  // Stripping it server-side alone would mean the box ticks, saves, and silently empties — which is
  // its own small betrayal. The reason has to be visible where the question gets asked.
  const fs2 = require('fs');
  const ui = fs2.readFileSync(require.resolve('../web/src/pages/Admin.jsx'), 'utf8');
  assert.match(ui, /const NOT_GRANTABLE = \['admin'\]/);
  assert.match(ui, /disabled=\{locked\}/, 'the box must be disabled');
  assert.match(ui, /role, not a panel/, 'and say why');
  // The summary line must report EFFECTIVE access, never the raw stored list.
  assert.match(ui, /e\.keys\.filter\(\(k\) => NOT_GRANTABLE\.indexOf\(k\) < 0\)/);
});

test('the admin page shows every card collapsed-able and the panel list always', function () {
  const fs2 = require('fs');
  const ui = fs2.readFileSync(require.resolve('../web/src/pages/Admin.jsx'), 'utf8');

  // The SHARED CollapsibleCard, not a local copy. It could not be used here until its styles moved
  // out of water.css — a shared component whose CSS lives inside one module can only be used by
  // that module, which is a shared component in name only.
  assert.match(ui, /import CollapsibleCard from '\.\.\/components\/CollapsibleCard\.jsx'/);
  // Pin the SHAPE — every card opens and closes — rather than a count, which only says how many
  // sections the page happened to have on the day it was written.
  const opens = (ui.match(/<CollapsibleCard/g) || []).length;
  assert.ok(opens >= 5, 'Users + panel default/per-user + meter default/per-user');
  assert.strictEqual((ui.match(/<\/CollapsibleCard>/g) || []).length, opens, 'every card must be closed');
  assert.ok(ui.indexOf('function Section(') === -1, 'the local duplicate must be gone');
  // Users open, the rest collapsed. Five expanded cards made the page a scroll to nowhere — you
  // could not see what sections existed without travelling past all of them. The one you always
  // want first stays open; the others announce themselves by title and open on request.
  assert.match(ui, /defaultOpen\n/, 'the Users card opens by default');
  assert.strictEqual((ui.match(/defaultOpen=\{false\}/g) || []).length, opens - 1,
    'every card except Users must start collapsed');

  // The grid renders in EVERY mode. It used to appear only under "Only selected", so the two modes
  // people actually leave things on showed no list at all — and "what can this person see?" had no
  // visible answer.
  assert.match(ui, /const qlist = \(set, setSet, readOnly\)/);
  assert.ok(ui.indexOf("{defMode === 'some' && qlist") === -1, 'the default card must always render it');
  assert.ok(ui.indexOf("{uMode === 'some' && qlist") === -1, 'the per-user card must always render it');
  assert.match(ui, /qlist\(allSet\(\), \(\) => \{\}, true\)/, 'read-only when the mode is not "some"');
  assert.match(ui, /qlist\(uMode === 'default' \? defaultSet\(\) : allSet\(\), \(\) => \{\}, true\)/);
});

test('"All panels" is rendered as the list it resolves to, not as a claim', function () {
  // "All panels" is not every panel — DEFAULT_ALL_EXCLUDE holds the sensitive ones back. Printing
  // the words instead of the resulting list is how someone comes away believing they granted
  // Diagnostics when they did not.
  const routes = require('fs').readFileSync(require.resolve('../api/routes'), 'utf8');
  assert.match(routes, /default_all_exclude: panel_access\.DEFAULT_ALL_EXCLUDE/,
    'the client cannot resolve "all" without knowing what is held back');

  const ui = require('fs').readFileSync(require.resolve('../web/src/pages/Admin.jsx'), 'utf8');
  assert.match(ui, /allExclude\.indexOf\(p\.key\) < 0/, 'and must apply it when resolving');
});

test('the shared card styles live at platform level, not inside water', function () {
  // CollapsibleCard sits in web/src/components/ and is used by both water and Admin. Its styles sat
  // in water.css, so the only way for a platform page to use it was to import a module's stylesheet
  // -- exactly the leak the `.w-` prefix exists to prevent. The styles moved instead.
  const fs2 = require('fs');
  const shell = fs2.readFileSync(require.resolve('../web/src/styles.css'), 'utf8');
  const water = fs2.readFileSync(require.resolve('../web/src/modules/water/water.css'), 'utf8');

  ['.ha-card {', '.ha-card-toggle {', '.ha-card-caret {'].forEach(function (rule) {
    assert.ok(shell.indexOf(rule) !== -1, rule + ' must be defined in styles.css');
  });
  // The toggle belongs entirely to the shared component and must not be redefined by a module.
  ['.ha-card-toggle {', '.ha-card-caret {'].forEach(function (rule) {
    assert.ok(water.indexOf(rule) === -1, rule + ' must NOT be duplicated in water.css');
  });
  // water.css may still TUNE the card (it is a denser page than Admin) but must not re-declare the
  // shell: a second `background`/`box-shadow` there would fork the surface and the two would drift.
  assert.ok(!/\.ha-card\s*\{[^}]*background:/.test(water),
    'water.css must not redeclare the card surface, only adjust spacing');
  // The retired names must be gone everywhere — a half-done rename is worse than either state.
  ['w-chart-card', 'w-chart-head', 'w-chart-title', 'w-chart-sub',
    'w-card-toggle', 'w-card-caret', 'w-card-actions'].forEach(function (old) {
    assert.ok(shell.indexOf(old) === -1, old + ' must not survive in styles.css');
    assert.ok(water.indexOf(old) === -1, old + ' must not survive in water.css');
  });

  // These rules now render OUTSIDE .w-root, where the water tokens are undefined. Without fallbacks
  // the caret loses its colour and the focus ring loses its outline -- an invisible focus indicator
  // is an accessibility regression, not a cosmetic one.
  assert.match(shell, /var\(--w-axis, var\(--muted\)\)/);
  assert.match(shell, /var\(--w-series, #2a78d6\)/);
});

test('a .env edit restarts the dev server', function () {
  // nodemon defaulted to --ext js, so editing .env changed nothing in a running process and the old
  // admin password kept working. Verified against nodemon: --watch .env with env in --ext does
  // trigger a restart.
  const pkg = JSON.parse(require('fs').readFileSync(require.resolve('../../../package.json'), 'utf8'));
  ['home_assist_dev', 'water_collector_dev'].forEach(function (name) {
    const cmd = pkg.scripts[name];
    assert.ok(cmd.indexOf('--watch .env') !== -1, name + ' must watch .env');
    assert.match(cmd, /--ext js,env/, name + ' must accept .env as a trigger');
  });
});

test('the auth diagnostic names the source a credential came from', function () {
  // "I changed the password in .env and the old one still works" has four causes that look
  // identical from a login form: a stored user shadowing the .env account, dotenv not overriding a
  // shell variable, a duplicate key in .env, or the wrong .env entirely. Printing the answer beats
  // guessing between them — which is exactly what this session spent a round doing.
  const cli = require('fs').readFileSync(require.resolve('../admin'), 'utf8');
  const i = cli.indexOf("if (cmd === 'auth')");
  assert.ok(i !== -1, 'the auth subcommand must exist');
  const body = cli.slice(i, cli.indexOf("if (cmd === 'envfix')", i));
  assert.match(body, /\.env loaded from/, 'the resolved path — the wrong file is a real cause');
  assert.match(body, /duplicated key\(s\) in \.env\. dotenv keeps the FIRST/);
  // Listing duplicates alone is not actionable: a file pasted twice duplicates everything and most
  // pairs are identical. Which ones DISAGREE is the part that names the discarded edit.
  assert.match(body, /These DISAGREE/);
  assert.match(body, /also stored, so a \.env password change does NOT retire the old one/);
  assert.match(body, /ACCEPTED via/, 'and say WHICH source accepted it');
  // Lengths only. A diagnostic that prints the password is one you cannot run over a shared screen.
  assert.match(body, /p2\.length \+ ' chars'/);
  assert.ok(body.indexOf('console.log(pw)') === -1);
});

test('envfix keeps the LAST duplicate and always backs up first', function () {
  // A .env pasted twice discards every later edit, silently, because dotenv keeps the FIRST value.
  // LAST wins here deliberately — the later block is where people type newer values, since you
  // append at the end rather than scrolling up to amend line 3. Losing the edit you just made is
  // worse than losing one from a month ago.
  const cli = require('fs').readFileSync(require.resolve('../admin'), 'utf8');
  const i = cli.indexOf("if (cmd === 'envfix')");
  assert.ok(i !== -1, 'the envfix subcommand must exist');
  const body = cli.slice(i, cli.indexOf("if (cmd === 'access')", i));
  assert.match(body, /last_index\[m\[1\]\] === i/, 'keep the last occurrence');
  // This file holds the Gmail app password and the MySQL password. A rewrite with no copy on disk
  // is not a convenience, it is a way to lose a credential.
  assert.match(body, /fs\.copyFileSync\(env_path, backup\)/);
  const backup_at = body.indexOf('copyFileSync');
  const write_at = body.indexOf('writeFileSync');
  assert.ok(backup_at !== -1 && write_at !== -1 && backup_at < write_at,
    'the backup must be written BEFORE the rewrite');
  assert.match(body, /mode: 0o600/, 'and the rewritten file keeps owner-only permissions');
  // Comments and blank lines are not config; rewriting must not eat them.
  assert.match(body, /if \(!m\) return true;/);
});

test('envcheck separates "will not start" from "cannot warn you"', function () {
  // On a leak monitor these are not the same severity. Without MYSQL_* nothing runs and you find
  // out immediately. Without EMAIL_* everything looks healthy and no alert can ever be delivered —
  // silence reading as safety is the failure this whole app is built against, so it gets its own
  // tier rather than sitting beside a missing port number.
  const cli = require('fs').readFileSync(require.resolve('../admin'), 'utf8');
  const i = cli.indexOf("if (cmd === 'envcheck')");
  assert.ok(i !== -1, 'the envcheck subcommand must exist');
  const body = cli.slice(i, cli.indexOf("if (cmd === 'access')", i));
  assert.match(body, /const REQUIRED = \[/);
  assert.match(body, /const ALERTING = \['EMAIL_SENDER', 'EMAIL_PASSWORD', 'EMAIL_RECIPIENT'\]/);
  assert.match(body, /no\\nleak email can ever be sent|leak email can ever be sent/);
  // .env.example is the contract, not a grep for process.env: settings.js reads through DEFS `env:`
  // and the platform keys go through platform_env(), so a grep misses the ones most easily deleted.
  assert.match(body, /\.env\.example/);
  // Names only. A completeness check that prints values is one you cannot run on a shared screen.
  assert.ok(body.indexOf('vals[') === -1, 'envcheck must not read values');
});

test('a commented key in .env.example still counts as documented', function () {
  // .env.example documents optional keys commented out with their defaults — `# EMAIL_PORT=587` is
  // the convention for "you may set this, here is what it is otherwise". Counting only uncommented
  // lines made the contract look smaller than it is, and told a user who had correctly set
  // EMAIL_HOST that it was undocumented and possibly a typo. A checker that cries wolf about
  // correct config is worse than no checker.
  //
  // The user's OWN .env is parsed WITHOUT that leniency: a commented line there is a value they
  // are deliberately not using, and counting it would hide a genuinely missing key.
  const cli = require('fs').readFileSync(require.resolve('../admin'), 'utf8');
  const body = cli.slice(cli.indexOf("if (cmd === 'envcheck')"), cli.indexOf("if (cmd === 'access')"));
  assert.match(body, /function keys_of\(file, commented\)/);
  assert.ok(body.indexOf('/^\\s*#?\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=/') !== -1,
    'the lenient regex allows a leading #');
  assert.match(body, /keys_of\(ex_path, true\)/, 'the EXAMPLE is parsed leniently');
  assert.match(body, /keys_of\(env_path\)/, "the user's own file is not");

  // And prove it against the real .env.example, which does comment these three out.
  const ex = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', '..', '.env.example'), 'utf8');
  ['EMAIL_HOST', 'EMAIL_PORT', 'EMAIL_SECURE'].forEach(function (k) {
    assert.ok(ex.indexOf('# ' + k + '=') !== -1,
      k + ' is documented commented-out — the case this leniency exists for');
  });
});
