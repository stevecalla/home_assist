'use strict';
/**
 * mailer.js — outbound email for home_assist, ported from the wrestling_stats pattern
 * (utilities/email_sends/nodemailer.js + send_job_status_email.js), converted ESM -> CJS.
 *
 * Same transport as wrestling_stats: Gmail SMTP over STARTTLS on 587, pooled, authenticated with
 * EMAIL_SENDER + EMAIL_PASSWORD (a Gmail APP password generated under 2-factor auth — your normal
 * account password will not work).
 *
 * Platform-level on purpose: this sits in src/home_assist/notify/, not inside the water module,
 * because the next feature will want to send email too.
 *
 * The transporter is created LAZILY on the first send. Requiring this file must never open a
 * socket or throw when the credentials are absent — a monitor that dies at boot because email is
 * misconfigured is worse than one that logs "email not configured" and keeps watching the meter.
 */
const os = require('os');

let _transporter = null;
let _nodemailer = null;

function config() {
  return {
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: Number(process.env.EMAIL_PORT) || 587,
    secure: String(process.env.EMAIL_SECURE || '').toLowerCase() === 'true', // true only for 465
    sender: process.env.EMAIL_SENDER || '',
    password: process.env.EMAIL_PASSWORD || '',
    recipient: process.env.EMAIL_RECIPIENT || process.env.EMAIL_SENDER || '',
  };
}

function configured() {
  const c = config();
  return !!(c.sender && c.password && c.recipient);
}

// Every SMTP phase gets an explicit timeout. Without these, nodemailer will happily wait on a
// half-open socket indefinitely — and this module is called from the collector's startup preflight,
// so a firewalled or slow network would leave the leak monitor hanging before it ever started
// watching. A monitor blocked on its email check is worse than one with broken email.
const SMTP_TIMEOUT_MS = 10000;

function transporter() {
  if (_transporter) return _transporter;
  const c = config();
  if (!configured()) return null;
  if (!_nodemailer) _nodemailer = require('nodemailer');
  _transporter = _nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    pool: true,
    connectionTimeout: SMTP_TIMEOUT_MS,   // TCP connect
    greetingTimeout: SMTP_TIMEOUT_MS,     // waiting for the server banner
    socketTimeout: SMTP_TIMEOUT_MS,       // inactivity mid-conversation
    auth: { user: c.sender, pass: c.password },
  });
  return _transporter;
}

// Belt and braces: nodemailer's own timeouts cover the socket phases, but a hung DNS lookup or a
// library edge case should still not outlive this. Never rejects.
function with_deadline(promise, ms, label) {
  return new Promise(function (resolve) {
    let done = false;
    const t = setTimeout(function () {
      if (done) return;
      done = true;
      resolve({ ok: false, error: label + ' timed out after ' + Math.round(ms / 1000) + 's' });
    }, ms);
    promise.then(function (v) {
      if (done) return;
      done = true; clearTimeout(t); resolve(v);
    }, function (e) {
      if (done) return;
      done = true; clearTimeout(t); resolve({ ok: false, error: e.message });
    });
  });
}

// Prove the SMTP credentials work without sending anything. Used by the Settings page's
// "test alert" button, the Diagnostics page, and the collector's startup preflight.
async function verify() {
  const t = transporter();
  if (!t) return { ok: false, error: 'email not configured (EMAIL_SENDER / EMAIL_PASSWORD / EMAIL_RECIPIENT)' };
  return with_deadline(
    t.verify().then(function () { return { ok: true }; }),
    SMTP_TIMEOUT_MS + 2000,
    'SMTP verify'
  );
}

/**
 * Send one message. Never throws — returns { ok, error } so the caller can record the outcome
 * in water_alerts.delivered without a try/catch at every call site.
 */
async function send(mail) {
  const t = transporter();
  if (!t) return { ok: false, error: 'email not configured' };
  const c = config();
  return with_deadline(
    t.sendMail({
      from: { name: mail.from_name || ('home_assist (' + os.hostname() + ')'), address: c.sender },
      to: mail.to || c.recipient,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    }).then(function (info) { return { ok: true, response: info && info.response }; }),
    SMTP_TIMEOUT_MS * 3,     // a send may legitimately take longer than a verify
    'SMTP send'
  );
}

function close() {
  try { if (_transporter) _transporter.close(); } catch (e) { /* ignore */ }
  _transporter = null;
}

/**
 * html_alert — the shared email shell: a colored status banner over a details table, following the
 * send_job_status_email.js layout so these look like the rest of your job mail.
 */
function html_alert(opts) {
  const rows = (opts.rows || []).map(function (r) {
    return '<tr><td style="padding:6px 12px 6px 0;white-space:nowrap;"><strong>' + esc(r[0]) +
      '</strong></td><td style="padding:6px 0;">' + esc(r[1]) + '</td></tr>';
  }).join('');
  return '' +
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:720px;margin:auto;">' +
      '<h2 style="margin:0 0 6px 0;">' + esc(opts.title || 'home_assist') + '</h2>' +
      '<div style="background-color:' + (opts.color || '#6c757d') + ';color:#fff;padding:12px 14px;' +
        'border-radius:10px;font-weight:bold;margin-bottom:14px;font-size:15px;">' +
        esc(opts.headline || '') +
      '</div>' +
      (opts.body ? '<p style="font-size:15px;line-height:1.5;margin:0 0 16px 0;">' + esc(opts.body) + '</p>' : '') +
      (rows ? '<table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:14px;">' + rows + '</table>' : '') +
      (opts.footer ? '<p style="color:#6c757d;font-size:12px;margin-top:20px;">' + esc(opts.footer) + '</p>' : '') +
    '</div>';
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { config, configured, verify, send, close, html_alert, with_deadline, SMTP_TIMEOUT_MS };
