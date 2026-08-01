'use strict';
/**
 * mailer.test.js — the deadline wrapper around SMTP.
 *
 * The bug this pins: `mailer.verify()` is called from the collector's startup preflight. Without a
 * timeout, a firewalled or slow network leaves the leak monitor hanging *before it starts watching*.
 * A monitor blocked on its email check is worse than one with broken email — the second one still
 * watches the meter.
 *
 * No network here: `with_deadline` is exercised directly with promises that resolve, reject, or
 * never settle.
 */
const test = require('node:test');
const assert = require('node:assert');

const mailer = require('../notify/mailer');

test('a promise that never settles resolves as a timeout, not a hang', async function () {
  const never = new Promise(function () { /* deliberately never resolves */ });
  const r = await mailer.with_deadline(never, 50, 'SMTP verify');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /timed out/);
});

test('a fast success passes straight through', async function () {
  const r = await mailer.with_deadline(Promise.resolve({ ok: true, response: '250 OK' }), 1000, 'x');
  assert.deepStrictEqual(r, { ok: true, response: '250 OK' });
});

test('a rejection becomes { ok:false } rather than throwing', async function () {
  // The whole point: callers record the outcome in water_alerts.delivered, so this must never throw.
  const r = await mailer.with_deadline(Promise.reject(new Error('535 auth failed')), 1000, 'x');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, '535 auth failed');
});

test('a late resolution after the deadline does not double-resolve', async function () {
  let resolveIt;
  const slow = new Promise(function (res) { resolveIt = res; });
  const r = await mailer.with_deadline(slow, 30, 'x');
  assert.strictEqual(r.ok, false);
  resolveIt({ ok: true });                    // arrives too late
  await new Promise(function (res) { setTimeout(res, 20); });
  assert.strictEqual(r.ok, false, 'the first outcome stands');
});

test('verify() reports "not configured" without touching the network', async function () {
  const saved = {
    s: process.env.EMAIL_SENDER, p: process.env.EMAIL_PASSWORD, r: process.env.EMAIL_RECIPIENT,
  };
  delete process.env.EMAIL_SENDER; delete process.env.EMAIL_PASSWORD; delete process.env.EMAIL_RECIPIENT;
  try {
    const r = await mailer.verify();
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not configured/);
  } finally {
    if (saved.s) process.env.EMAIL_SENDER = saved.s;
    if (saved.p) process.env.EMAIL_PASSWORD = saved.p;
    if (saved.r) process.env.EMAIL_RECIPIENT = saved.r;
  }
});

test('send() with no config fails cleanly rather than throwing', async function () {
  const saved = process.env.EMAIL_SENDER;
  delete process.env.EMAIL_SENDER;
  mailer.close();                              // drop any cached transporter
  try {
    const r = await mailer.send({ subject: 'x', text: 'x' });
    assert.strictEqual(r.ok, false);
  } finally {
    if (saved) process.env.EMAIL_SENDER = saved;
    mailer.close();
  }
});
