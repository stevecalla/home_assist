'use strict';
/**
 * card_order.test.js — the order of things on a page, in two senses.
 *
 *  1. CardStack: the reader's own card order, and how a SAVED order survives the page changing.
 *  2. The panel catalog: the access checkboxes must be listed in the same order as the side rail.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const panel_access = require('../access/panel_access');
const SRC = path.join(__dirname, '..');

// apply_order is exported from an ESM component; loaded the same way lib/num.js is in
// number_format.test.js -- by stripping the export keywords rather than adding a build step to a
// test run that has to stay fast enough to be worth running before every deploy.
function load_apply_order() {
  const src = fs.readFileSync(path.join(SRC, 'web', 'src', 'components', 'CardStack.jsx'), 'utf8');
  const i = src.indexOf('export function apply_order');
  const j = src.indexOf('export default function');
  const body = src.slice(i, j).replace(/^export /gm, '');
  return new Function(body + '\nreturn apply_order;')();   // eslint-disable-line no-new-func
}

const IDS = ['issues', 'usage', 'sessions', 'recent', 'health'];

test('no saved order means the declared order', function () {
  const apply = load_apply_order();
  assert.deepStrictEqual(apply(IDS, null), IDS);
  assert.deepStrictEqual(apply(IDS, []), IDS);
});

test('a saved order is honoured', function () {
  const apply = load_apply_order();
  const saved = ['health', 'issues', 'usage', 'sessions', 'recent'];
  assert.deepStrictEqual(apply(IDS, saved), saved);
});

test('a card added later still appears, in its declared position', function () {
  // THE case that matters. Someone reorders this page today; a release next year adds a card. If
  // the saved order were treated as the whole list, that card would be invisible to exactly the
  // people who use the page enough to have reordered it -- and invisible without an error.
  const apply = load_apply_order();
  const saved = ['health', 'issues'];                       // saved before the others existed
  const now = ['issues', 'usage', 'sessions', 'recent', 'health'];
  const out = apply(now, saved);
  assert.deepStrictEqual(out.slice().sort(), now.slice().sort(), 'every current card is present');
  assert.ok(out.indexOf('health') < out.indexOf('usage'), 'and the saved preference still holds');
});

test('a card that no longer exists is dropped, not rendered as a hole', function () {
  const apply = load_apply_order();
  assert.deepStrictEqual(apply(['a', 'b'], ['b', 'gone', 'a']), ['b', 'a']);
});

test('the order is a per-browser preference, not data', function () {
  // localStorage, wrapped, and never sent anywhere. Which card someone likes at the top is not
  // worth a column, a round trip, or a row in the events table.
  const src = fs.readFileSync(path.join(SRC, 'web', 'src', 'components', 'CardStack.jsx'), 'utf8');
  assert.match(src, /localStorage/);
  assert.ok(src.indexOf('fetch(') === -1, 'the order is never sent to the server');
  // Every access wrapped: Safari private mode throws on write, and a layout preference is never
  // worth a blank page.
  const accesses = (src.match(/window\.localStorage\.\w+/g) || []).length;
  const tries = (src.match(/try \{/g) || []).length;
  assert.ok(tries >= accesses, 'every localStorage access sits inside a try');
});

test('a card can be moved without a mouse', function () {
  // Drag-and-drop as the ONLY mechanism excludes keyboards, phones and screen readers. The
  // buttons are the accessible path and the only one that can be tested without simulating
  // pointer physics -- which is also why they are the ones pinned here.
  const src = fs.readFileSync(path.join(SRC, 'web', 'src', 'components', 'CardStack.jsx'), 'utf8');
  assert.match(src, /aria-label=\{'Move ' \+/, 'the move buttons are labelled');
  assert.match(src, /data-cardmove=/, 'and addressable, so focus survives the reorder');
  // Only the handle arms a drag. A draggable card body turns selecting a value in a table into a
  // drag of the whole card.
  assert.match(src, /draggable=\{armed === id\}/);
});

test('both stacks are wired, with distinct storage keys', function () {
  // One key per page. A shared key would make reordering Admin silently reorder Metrics.
  const admin = fs.readFileSync(path.join(SRC, 'web', 'src', 'pages', 'Admin.jsx'), 'utf8');
  const metrics = fs.readFileSync(path.join(SRC, 'web', 'src', 'modules', 'metrics', 'Metrics.jsx'), 'utf8');
  assert.match(admin, /storageKey="admin"/);
  assert.match(metrics, /storageKey="metrics"/);
  for (const [name, src] of [['Admin', admin], ['Metrics', metrics]]) {
    const ids = (src.match(/\{ id: '[a-z-]+', label: '/g) || []).length;
    assert.strictEqual(ids, 5, name + ' should have all five cards in the stack');
  }
});

// ── the access checkboxes ──────────────────────────────────────────────────────────────────────

test('the access catalog lists panels in the same order as the side rail', function () {
  // The list you TICK and the list you NAVIGATE have to agree, or you are editing one mental model
  // against another. They diverged the moment a module contributed a panel to a group the shell
  // also contributes to: catalog() appended every platform panel after every module panel, so the
  // rail read "Users & access, Metrics" and the access card read "Metrics, Users & access".
  const nav = fs.readFileSync(path.join(SRC, 'web', 'src', 'nav.js'), 'utf8');
  const rail = (nav.match(/panel: '([a-z-]+)'/g) || []).map(function (m) { return m.slice(8, -1); });
  const cat = panel_access.catalog().map(function (p) { return p.key; });

  // Same panels, ignoring any the rail does not route to.
  const routed = cat.filter(function (k) { return rail.indexOf(k) >= 0; });
  assert.deepStrictEqual(routed, rail,
    'catalog order must match the rail: rail=' + rail.join(',') + ' catalog=' + routed.join(','));
});

test('groups keep their registry order, and Admin leads with Users & access', function () {
  const cat = panel_access.catalog();
  const groups = [];
  cat.forEach(function (p) {
    const g = p.group || 'General';
    if (groups.indexOf(g) < 0) groups.push(g);
  });
  assert.deepStrictEqual(groups, ['Water', 'Admin']);

  const admin = cat.filter(function (p) { return p.group === 'Admin'; }).map(function (p) { return p.key; });
  assert.deepStrictEqual(admin, ['admin', 'metrics']);

  // The water manifest's sequence is deliberate -- reading pages, then the three that change
  // behaviour -- and the sort must be STABLE enough to leave it alone.
  const water = cat.filter(function (p) { return p.group === 'Water'; }).map(function (p) { return p.key; });
  assert.deepStrictEqual(water, ['water-monitor', 'water-history', 'water-alerts', 'water-reference',
    'water-settings', 'water-meters', 'water-diagnostics']);
});
