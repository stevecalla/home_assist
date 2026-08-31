'use strict';
/**
 * email_content.test.js — what an alert email actually says.
 *
 * build_email is pure given (alert, cfg, ctx), so all of this is testable without SMTP, a database
 * or a radio. Worth pinning because email is the ONLY channel that reaches someone who is not
 * looking at the dashboard, and every fault here is invisible from the app: the page can be
 * perfect while the message that wakes you at 3am says nothing useful.
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.WATER_TZ = process.env.WATER_TZ || 'America/Denver';
const alerts = require('../store/alerts');

const CFG = { meter_id: 16642655, overnight_start_hour: 2, overnight_end_hour: 5 };
const MONTHS = {
  this_month: { label: 'August 2026', gallons: 2480, days: 31, observed_days: 20, complete: false, partial: true },
  last_month: { label: 'July 2026', gallons: 3180, days: 31, observed_days: 31, complete: true, partial: false },
};
// The field names are check_overnight()'s, verbatim: { total, threshold, hours_missing, ... }.
// They used to be total_gal / threshold_gal / start_hour / end_hour -- names invented here to match
// names invented in build_email, so the suite and the code agreed with each other and neither
// agreed with the rules. Every assertion below passed while the real overnight email was going out
// with no figures in it at all. See meter_alerts.test.js, which now builds these from the rules.
const overnight = {
  kind: 'overnight',
  message: 'Water ran overnight: 12 gal between 2:00 and 5:00',
  detail: { day: '2026-08-30', total: 12, threshold: 3, hours_missing: 0 },
};

test('the subject leads with the FACT and the meter name, not a timestamp', function () {
  // It used to read "[WATER] Overnight flow - 2026-08-31 06:00:12": a prefix, a category and a
  // date. On a phone lock screen that is everything except how much and whose. The subject is the
  // only part of an email guaranteed to be read.
  const e = alerts.build_email(overnight, CFG, { meter_id: 14905174, meter_name: '4528 Sprucedale' });
  assert.strictEqual(e.subject, '[WATER] 12 gal overnight — 4528 Sprucedale');
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(e.subject), 'no timestamp in the subject');
});

test('an unnamed meter still gets a usable subject', function () {
  const e = alerts.build_email(overnight, CFG, { meter_id: 14905174 });
  assert.strictEqual(e.subject, '[WATER] 12 gal overnight');
});

test('the meter is named, with the id kept beside it', function () {
  // An id identifies nothing to a neighbour, and is a lookup for an owner with four meters. The id
  // still travels, because it is what the packet table is searched by.
  const e = alerts.build_email(overnight, CFG, { meter_id: 14905174, meter_name: '4528 Sprucedale' });
  assert.match(e.text, /Meter: 4528 Sprucedale \(14905174\)/);
});

test('the internal `kind` string no longer appears as a row', function () {
  // "Signal: overnight" was the enum leaking into the email, and the headline already says it.
  const e = alerts.build_email(overnight, CFG, { meter_id: 16642655 });
  assert.ok(e.text.indexOf('Signal:') === -1);
});

test('detail rows are labelled for a human, not dumped from the object', function () {
  // The old code did Object.keys(detail) with underscores swapped for spaces, producing rows like
  // "min gal per hour: 1" and making every email read like a log line.
  const e = alerts.build_email(overnight, CFG, { meter_id: 16642655 });
  assert.match(e.text, /Used overnight: 12 gal/);
  assert.match(e.text, /Alerts above: 3 gal/);
  assert.match(e.text, /Overnight window: 2:00 to 5:00/);   // from cfg, not the detail
  assert.ok(e.text.indexOf('total gal') === -1, 'no raw key names');
  assert.ok(e.text.indexOf('hours missing') === -1);
});

test('every email carries this month and last month', function () {
  // "12 gal overnight" is alarming if the house usually does 3 and unremarkable if it usually does
  // 40. The months are what turn a number into a judgement.
  const e = alerts.build_email(overnight, CFG, { meter_id: 16642655, months: MONTHS });
  assert.match(e.text, /August 2026: 2,480 gal so far \(20 days\)/, 'a part month says so');
  assert.match(e.text, /July 2026: 3,180 gal/);
});

test('a month with gaps admits it rather than reporting a low total as complete', function () {
  const months = {
    this_month: MONTHS.this_month,
    last_month: { label: 'July 2026', gallons: 2900, days: 31, observed_days: 28, complete: false, partial: false },
  };
  const e = alerts.build_email(overnight, CFG, { meter_id: 16642655, months: months });
  assert.match(e.text, /July 2026: 2,900 gal — 3 day\(s\) not recorded/);
});

test('the email says what to CHECK, not only what happened', function () {
  // Only the receiver-silent alert ever did. Someone told that water ran overnight, and not that a
  // toilet flapper is the overwhelmingly likely cause, has been informed and not helped.
  const e = alerts.build_email(overnight, CFG, { meter_id: 16642655 });
  assert.match(e.text, /What to check:/);
  assert.match(e.text, /toilet that runs after flushing/);
  assert.match(e.html, /<ul/, 'and as a list in the HTML part');

  for (const kind of ['overnight', 'continuous', 'run', 'stale']) {
    assert.ok(Array.isArray(alerts.CHECKLIST[kind]) && alerts.CHECKLIST[kind].length,
      kind + ' must tell the reader what to do about it');
  }
});

test('the footer speaks to whoever is actually reading it', function () {
  // "Thresholds are editable on the Water > Settings page" is addressed to the operator. A
  // neighbour cannot open that page and does not administer this app -- the same mistake the
  // Meters page had, in the one place the neighbour definitely sees.
  const mine = alerts.build_email(overnight, CFG, { meter_id: 16642655 });
  assert.match(mine.text, /Settings page/);

  const theirs = alerts.build_email(overnight, CFG, { meter_id: 14905174, meter_name: 'Next door' });
  assert.ok(theirs.text.indexOf('Settings page') === -1, 'do not point them at a page they cannot open');
  assert.match(theirs.text, /Reply to this email/, 'give them a way out instead');
});

test('the summary states the months as a sentence, and not twice', function () {
  // The daily summary has no incident: "where do I stand" IS its subject, so the months belong in
  // the opening lines rather than as the eighth row of a table. And exactly once — the same two
  // numbers repeated on one screen is noise, not emphasis.
  const e = alerts.build_email(
    { kind: 'summary', message: 'Yesterday: 147 gal.', detail: { total_gal: 147 } },
    CFG, { meter_id: 16642655, months: MONTHS });
  assert.match(e.text, /August 2026: 2,480 gal so far \(20 days\)\. July 2026 finished at 3,180 gal\./);
  assert.ok(!/so far.*so far/.test(e.text), 'the qualifier must not be doubled');
  assert.strictEqual((e.text.match(/July 2026/g) || []).length, 1, 'stated once, not as a row as well');
});

test('the summary subject carries yesterday AND the month so far', function () {
  // The standing report, not an incident. Yesterday alone leaves out the figure people open it for,
  // and the month is the one that answers "am I on track for a normal bill".
  const e = alerts.build_email(
    { kind: 'summary', message: 'Yesterday: 147 gal.', detail: { total_gal: 147 } },
    CFG, { meter_id: 16642655, meter_name: 'Home', months: MONTHS });
  assert.strictEqual(e.subject, '[WATER] 147 gal yesterday \u00b7 2,480 gal in August — Home');

  // And degrades to just yesterday when the months could not be resolved -- a failed lookup must
  // not cost the subject the figure it definitely has.
  const bare = alerts.build_email(
    { kind: 'summary', message: 'Yesterday: 147 gal.', detail: { total_gal: 147 } },
    CFG, { meter_id: 16642655, meter_name: 'Home' });
  assert.strictEqual(bare.subject, '[WATER] 147 gal yesterday — Home');
});

test('the receiver-silent alert drops the months and keeps its subject short', function () {
  // Its whole message is "I cannot see this meter". Month totals underneath offer context for data
  // it has just said it is not receiving. And the subject carried the fact AND the consequence AND
  // the meter name — two em-dashes, unreadable on a lock screen.
  const e = alerts.build_email(
    { kind: 'stale', message: 'No meter readings for 95 min.', detail: { minutes: 95 } },
    CFG, { meter_id: 16642655, meter_name: 'Home', months: MONTHS });
  assert.strictEqual(e.subject, '[WATER] Receiver silent — Home');
  assert.ok(e.text.indexOf('August 2026') === -1, 'no month context on an alert that cannot see the meter');
});

test('the receiver-silent alert keeps its own footer', function () {
  // The one alert where the next step was already right: it means nothing is being watched.
  const e = alerts.build_email(
    { kind: 'stale', message: 'No meter readings for 95 min.', detail: { minutes: 95 } },
    CFG, { meter_id: 16642655 });
  assert.match(e.text, /collector_water\.js is up/);
  assert.match(e.text, /Silent for: 1h 35m/, 'durations read as durations, not as raw minutes');
});

test('the daily summary carries shape and a comparison, not one number', function () {
  // It used to be "Last 24h: 147 gallons." — a figure with nothing to judge it against, mailed
  // every day. That trains people to ignore the sender, which is the sender you need them to
  // notice at 3am.
  const e = alerts.build_email(
    { kind: 'summary',
      message: 'Yesterday: 147 gal, 4 of it overnight. Your 7-day average is 103 gal — up 43%.',
      detail: { total_gal: 147, overnight_gal: 4, avg_gal: 103, avg_over_days: 7 } },
    CFG, { meter_id: 16642655, months: MONTHS });
  assert.strictEqual(e.subject, '[WATER] 147 gal yesterday \u00b7 2,480 gal in August');
  assert.match(e.text, /Of that, overnight: 4 gal/);
  assert.match(e.text, /Your 7-day average: 103 gal\/day/);
});

test('build_email never throws when the context is missing', function () {
  // ctx is null for the test button and the daily summary path. An email builder that throws takes
  // the alert with it, and the alert is the product.
  for (const ctx of [null, undefined, {}, { meter_id: 1 }]) {
    const e = alerts.build_email({ kind: 'test', message: 'Test alert', detail: null }, CFG, ctx);
    assert.ok(e.subject && e.text && e.html);
  }
});
