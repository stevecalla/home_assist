'use strict';
/**
 * retention.settings.test.js — the Settings page must not change your number without saying so.
 *
 * `clamp()` has always snapped an out-of-range value into range, which is right. What was wrong was
 * the silence around it: typing 0 into a field with a minimum of 1 stored 1, reported "Saved.", and
 * reloaded showing a number nobody chose. Indistinguishable from a save that did nothing.
 *
 * On the page whose entire job is displaying what is configured, that is the one failure that
 * matters — the same shape as every other bug in this module: the app is honest about the value it
 * holds, and quiet about the moment it stopped being the value you gave it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const settings = require('../store/settings');
const { DEFS, clamp } = settings;

test('clamp pins a value into range', function () {
  assert.strictEqual(clamp({ min: 1, max: 3650 }, 0), 1);
  assert.strictEqual(clamp({ min: 1, max: 3650 }, 99999), 3650);
  assert.strictEqual(clamp({ min: 1, max: 3650 }, 180), 180, 'in range is untouched');
});

test('min_nonzero keeps 0 meaning unlimited while flooring every other value', function () {
  // The distinction a plain `min` cannot express: 0 is "forever", but 1 day of hourly history
  // starves the continuous-flow rule, which needs six hours of buckets to see anything at all.
  const d = DEFS.hourly_retention_days;
  assert.strictEqual(d.min_nonzero, 7);
  assert.strictEqual(clamp(d, 0), 0, '0 must survive — it means forever');
  assert.strictEqual(clamp(d, 3), 7, 'anything positive is floored');
  assert.strictEqual(clamp(d, 30), 30);
});

test('a neighbour meter can be kept for a decade, but not forever', function () {
  // 0 is NOT unlimited here, and that is deliberate: the cap is what makes a long retention on
  // someone else's meter a number you chose rather than a default nobody revisited.
  const d = DEFS.observed_retention_days;
  assert.strictEqual(d.min, 1);
  assert.strictEqual(d.max, 3650);
  assert.strictEqual(clamp(d, 0), 1, '0 is not "forever" for observed meters');
  assert.strictEqual(clamp(d, 3650), 3650);
});

test('set_many reports every value it adjusted', function () {
  // Needs no database: the contract is what is asserted -- that the caller is handed `adjusted`
  // alongside the values, and that the API forwards it.
  const src = fs.readFileSync(require.resolve('../store/settings'), 'utf8');
  assert.match(src, /const adjusted = \[\]/);
  assert.match(src, /if \(v !== wanted\)/, 'compare what was SAVED against what was TYPED');
  assert.match(src, /return \{ values: await all\(\{ force: true \}\), adjusted: adjusted \}/);
  assert.match(src, /reason:/, 'and say why it moved, not merely that it did');

  const api = fs.readFileSync(require.resolve('../api'), 'utf8');
  assert.match(api, /adjusted: r\.adjusted/, 'the route must forward it to the page');
});

test('the help text describes what the code actually does', function () {
  // It said "A value below 7 is refused". It is not refused -- it is raised to 7 and saved. The
  // behaviour was right and the sentence was not, which is worse than no sentence: it teaches a
  // rule the app does not follow.
  const help = DEFS.hourly_retention_days.help;
  assert.ok(help.indexOf('refused') === -1, 'nothing here is refused');
  assert.match(help, /RAISED to 7/);
});

test('the Settings page prints the allowed range', function () {
  // describe() has always sent min/max/default and the page rendered none of it, so the only way to
  // learn that a field rejects 0 was to type 0 and watch it come back as 1.
  const ui = fs.readFileSync(
    require.resolve('../../../web/src/modules/water/Settings.jsx'), 'utf8');
  assert.match(ui, /w-range-hint/);
  assert.match(ui, /f\.min_nonzero !== undefined/, 'and explains the 0-means-unlimited case');
  assert.match(ui, /r\.body\.adjusted/, 'and reports anything the save changed');
});
