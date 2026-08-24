'use strict';
/**
 * mobile.test.js — the phone is where this dashboard actually gets read.
 *
 * You check a leak monitor from bed, from the car, from someone else's kitchen. The desktop layout
 * is where it gets BUILT, which is exactly why the mobile rules need pinning: nothing in the normal
 * working day fails when they break.
 *
 * These assert the rules exist and are written against selectors that MATCH. That second part is
 * not pedantry -- the first attempt at this styled `.w-tool`, a class that appears nowhere in the
 * app (the toolbar buttons are `.w-tools button`), so the rule parsed, shipped, and did nothing.
 * A CSS rule with no matching element fails silently and looks like success in a diff.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

const styles = read('src/styles.css');
const water = read('src/modules/water/water.css');
const app = read('src/App.jsx');
const help = read('src/components/HelpTip.jsx');

test('the viewport meta exists — without it none of the rest applies', function () {
  // A phone with no viewport tag renders at 980px and scales down: every media query below misses,
  // and the page is a legible-looking miniature nobody can tap.
  assert.match(read('index.html'), /name="viewport"[^>]*width=device-width/);
});

test('the export toolbar wraps instead of running off the screen', function () {
  // .w-tools holds up to seven controls (three view tabs + Expand/PNG/CSV/Table). As an inline-flex
  // with no wrap they extended past the right edge of a 390px screen -- in the DOM, unreachable on
  // the device.
  assert.match(water, /\.w-tools \{[^}]*flex-wrap: wrap/);
  assert.match(styles, /@media \(max-width: 820px\) \{\s*\.ha-card-actions \{ margin-left: 0; width: 100%; \}/,
    'the actions block must take the full card width once it wraps');
});

test('touch targets are sized for a thumb, and by selectors that exist', function () {
  const block = water.slice(water.indexOf('/* ── touch ─'));
  assert.ok(block.length > 200, 'the touch block must exist');
  // `.w-tools button`, NOT `.w-tool`. See the header comment.
  assert.match(block, /\.w-tools button \{ padding: 7px 12px/);
  assert.ok(block.indexOf('.w-tool {') === -1, '.w-tool is not a class this app uses');
  assert.match(block, /\.w-chip \{ padding: 7px 13px/);
  assert.match(block, /\.w-filt button \{ padding: 8px 13px/);
  // And the selector must actually appear in the app's markup.
  const tools = read('src/components/CardTools.jsx');
  assert.match(tools, /className="w-tools"/);
});

test('the packet table keeps an anchor column while it scrolls sideways', function () {
  // Twelve columns will never fit a phone and should not try. What matters is that scrolling right
  // to read SNR does not cost you the row you were reading -- numbers you cannot attribute.
  assert.match(water, /\.w-grid-scroll \.w-table td:first-child \{\s*position: sticky; left: 0/);
});

test('the rail Setup divider is hidden where the rail is a horizontal strip', function () {
  // Its ::after is `flex: 1` -- a horizontal rule meant to fill a column. Left in a row it stretches
  // to eat the whole remaining scroll width.
  const m = styles.slice(styles.indexOf('@media (max-width: 820px)'));
  assert.match(m, /\.rail-subhead \{ display: none; \}/);
  assert.match(m, /\.rail-group \{ display: none; \}/, 'group headers stay hidden too');
});

test('the ? explanations are reachable without a cursor', function () {
  // Every metric on the water pages explains itself through a `title` attribute. A phone has no
  // hover, so on the device this app is most read, every explanation was silently unavailable.
  assert.match(app, /import HelpTip from '\.\/components\/HelpTip\.jsx'/);
  assert.match(app, /<HelpTip \/>/, 'mounted once for the whole app');

  // Capture phase: the ? inside a chip sits in a <button> with its own handler, so it has to be
  // intercepted BEFORE the button acts -- otherwise asking what a number means changes your filter.
  assert.match(help, /addEventListener\('click', onClick, true\)/);
  assert.match(help, /removeEventListener\('click', onClick, true\)/, 'and cleaned up');
  // Gated on the POINTER, not the width: a mouse keeps the native tooltip, a tablet gets the sheet.
  assert.match(help, /matchMedia\('\(hover: none\)'\)/);
  assert.match(help, /closest\('\[title\]'\)/, 'the text lives on an ancestor, not the glyph');
  // The glyph stays 12px; the TARGET grows.
  assert.match(water, /\.w-q::after \{ content: ''; position: absolute; inset: -12px; \}/);
});

test('nothing in the touch block leaks into the desktop layout', function () {
  // Every touch rule must sit inside a media query. A stray one would silently fatten the desktop
  // UI, which is the change nobody would attribute to a "mobile" commit.
  const block = water.slice(water.indexOf('/* ── touch ─'));
  const opens = (block.match(/@media/g) || []).length;
  assert.ok(opens >= 2, 'a width-gated block and a pointer-gated block');
  // The sheet's own styling is deliberately unguarded — it only renders when HelpTip mounts it.
  assert.match(block, /\.w-help-sheet \{/);
});
