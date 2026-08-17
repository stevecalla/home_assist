'use strict';
/**
 * alerts.js — cooldowns, delivery, and history for the water module.
 *
 * The leak rules (rules/leak_rules.js) decide WHAT is wrong. This decides whether to say it again,
 * who to tell, and records what happened.
 *
 * Cooldowns come from the water_alerts table rather than an in-memory map. monitor.mjs kept them in
 * state.notified, which meant a collector restart could re-send an alert you had already
 * acknowledged — or, worse, reset a 20-hour cooldown to zero. Querying the ledger makes restarts
 * invisible.
 *
 * Channels: email first (notify/mailer.js — the wrestling_stats nodemailer pattern), then ntfy push
 * if enabled. An alert is recorded whether or not delivery succeeded; `delivered` and
 * `delivery_note` say which.
 */
const db = require('../../../store/db');
const time = require('../../../time');
const mailer = require('../../../notify/mailer');
const ntfy = require('../../../notify/ntfy');

// Banner colors, matching the send_job_status_email.js palette.
const COLORS = {
  overnight: '#fd7e14',   // orange — suspicious
  continuous: '#dc3545',  // red — almost certainly a leak
  stale: '#dc3545',       // red — we are blind, which is worse than a leak
  summary: '#0d6efd',     // blue — informational
  test: '#28a745',        // green
};

const SUBJECT_PREFIX = {
  overnight: '[WATER] Overnight flow',
  continuous: '[WATER] Continuous flow',
  stale: '[WATER] Receiver silent',
  summary: '[WATER] Daily summary',
  test: '[WATER] Test alert',
};

/**
 * Has `alert_key` fired for THIS METER within the last `cooldown_min` minutes?
 * Only counts rows we actually delivered OR that were suppressed for a real reason — a failed send
 * still counts, otherwise a broken SMTP config would retry every minute forever.
 *
 * `meter_id` is part of the key, and this is the single most important line in the file now that
 * more than one meter can raise an alert. Keyed on alert_key alone, a neighbour whose overnight
 * rule tripped first would take the cooldown slot and SUPPRESS YOURS for the next six hours -- a
 * silent failure of the exact thing this app exists to do. Two houses, one mutex.
 */
async function in_cooldown(alert_key, cooldown_min, meter_id) {
  const since = time.sql_utc(new Date(Date.now() - Number(cooldown_min) * 60000));
  const rows = await db.query(
    'SELECT 1 FROM water_alerts WHERE meter_id = ? AND alert_key = ? AND fired_at_utc >= ? LIMIT 1',
    [Number(meter_id) || 0, alert_key, since]
  );
  return rows.length > 0;
}

async function record(alert, delivered, note, meter_id) {
  const s = time.stamps(new Date());
  await db.query(
    'INSERT INTO water_alerts (meter_id, alert_key, kind, severity, message, detail, delivered, delivery_note, fired_at_utc, fired_at_mtn, created_at_mtn, created_at_utc) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      Number(meter_id) || 0,
      alert.key, alert.kind, alert.severity || 'default', alert.message,
      alert.detail ? JSON.stringify(alert.detail) : null,
      delivered ? 1 : 0, note ? String(note).slice(0, 250) : null,
      s.utc, s.local, s.local, s.utc,
    ]
  );
}

function build_email(alert, cfg, ctx) {
  const now = new Date();
  const rows = [
    ['When', time.sql_local(now) + ' ' + (process.env.WATER_TZ || 'America/Denver')],
    ['Signal', alert.kind],
    ['Meter', String((ctx && ctx.meter_id) || cfg.meter_id)],
  ];
  if (ctx && ctx.last_gallons !== undefined && ctx.last_gallons !== null) {
    rows.push(['Meter reading', Number(ctx.last_gallons).toFixed(0) + ' gal']);
  }
  if (ctx && ctx.today_gallons !== undefined) {
    rows.push(['Today so far', Number(ctx.today_gallons).toFixed(0) + ' gal']);
  }
  if (alert.detail) {
    Object.keys(alert.detail).forEach(function (k) {
      if (k === 'keys') return;  // the raw hour-key list is noise in an email
      const v = alert.detail[k];
      if (v === null || v === undefined || typeof v === 'object') return;
      rows.push([k.replace(/_/g, ' '), String(v)]);
    });
  }

  const footer = alert.kind === 'stale'
    ? 'Leak detection is not running while the receiver is silent. Check that collector_water.js is up and the dongle is seated.'
    : 'Sent by home_assist. Thresholds are editable on the Water > Settings page.';

  return {
    subject: (SUBJECT_PREFIX[alert.kind] || '[WATER] Alert') + ' — ' + time.sql_local(now),
    text: alert.message + '\n\n' + rows.map(function (r) { return r[0] + ': ' + r[1]; }).join('\n'),
    html: mailer.html_alert({
      title: 'Water monitor',
      headline: alert.message,
      color: COLORS[alert.kind] || '#6c757d',
      rows: rows,
      footer: footer,
    }),
  };
}

/**
 * Deliver one alert descriptor, honouring its cooldown. Returns:
 *   { sent: false, reason: 'cooldown' }        already said recently
 *   { sent: true, channels: { email, ntfy } }  recorded (delivery per-channel may still have failed)
 *
 * `ctx.meter_id` says which meter this is about (defaults to yours) and `ctx.notify` says whether
 * it may be DELIVERED. Those are two different questions and separating them is the whole design:
 * an observed meter's alert is recorded and shown, so its history and banner work, but no email and
 * no push. Waking someone at 3am about a stranger's shower is not a feature.
 */
async function dispatch(alert, cfg, ctx) {
  const meter_id = (ctx && ctx.meter_id) || cfg.meter_id;
  // Delivery is opt-IN, and defaults to on only for your own meter. A missing ctx (the daily
  // summary, the test button) is therefore delivered exactly as before.
  const may_deliver = ctx && ctx.notify !== undefined
    ? !!ctx.notify
    : Number(meter_id) === Number(cfg.meter_id);

  if (await in_cooldown(alert.key, alert.cooldown_min || 360, meter_id)) {
    return { sent: false, reason: 'cooldown' };
  }

  if (!may_deliver) {
    // Recorded, never sent. `delivered = 0` with a note that says WHY, so a row with no delivery is
    // never mistaken for a transport failure -- those two look identical in a list and mean
    // completely different things.
    await record(alert, false, 'not delivered — notify is off for meter ' + meter_id, meter_id);
    return { sent: true, delivered: false, channels: {}, note: 'recorded only (notify off)' };
  }

  const channels = {};
  const notes = [];

  if (Number(cfg.alert_email_enabled) === 1) {
    const mail = build_email(alert, cfg, ctx);
    const to = (cfg.alert_email_to || '').trim() || undefined;   // undefined -> mailer's EMAIL_RECIPIENT
    const r = await mailer.send({ to: to, subject: mail.subject, text: mail.text, html: mail.html });
    channels.email = r;
    notes.push('email:' + (r.ok ? 'ok' : r.error));
  }

  if (Number(cfg.alert_ntfy_enabled) === 1 && cfg.ntfy_topic) {
    const r = await ntfy.send({
      topic: cfg.ntfy_topic,
      server: cfg.ntfy_server,
      message: alert.message,
      title: 'Water monitor',
      priority: alert.severity === 'high' ? 'high' : (alert.severity === 'low' ? 'low' : 'default'),
      tags: alert.tags,
    });
    channels.ntfy = r;
    notes.push('ntfy:' + (r.ok ? 'ok' : r.error));
  }

  if (!notes.length) notes.push('no channel enabled — logged only');

  const delivered = Object.keys(channels).some(function (k) { return channels[k].ok; });
  await record(alert, delivered, notes.join('; '), meter_id);

  return { sent: true, delivered: delivered, channels: channels, note: notes.join('; ') };
}

/**
 * A manual test push, so you can prove the whole chain works without waiting for a leak.
 * Bypasses cooldowns on purpose.
 */
async function send_test(cfg, who) {
  const alert = {
    key: 'test:' + Date.now(),
    kind: 'test',
    severity: 'default',
    tags: 'white_check_mark,droplet',
    cooldown_min: 0,
    message: 'Test alert from home_assist — the water monitor can reach you.' + (who ? ' (sent by ' + who + ')' : ''),
    detail: { requested_by: who || null },
  };
  return dispatch(alert, cfg, null);
}

/**
 * The alert history. `meter_id` filters; omit it for everything.
 *
 * Rows written before alerts were per-meter carry meter_id = 0. They are matched to the OWNED meter
 * rather than hidden, because when they were written there was only one meter that could alert --
 * that is a fact about the data, not a guess.
 */
async function recent(limit, meter_id, owned_meter_id) {
  const cap = Math.max(1, Math.min(Number(limit) || 50, 500));
  const cols = 'id, meter_id, alert_key, kind, severity, message, detail, delivered, delivery_note, ' +
    'fired_at_utc, fired_at_mtn';
  const mid = Number(meter_id) || 0;
  if (!mid) {
    return db.query('SELECT ' + cols + ' FROM water_alerts ORDER BY id DESC LIMIT ?', [cap]);
  }
  const owned = Number(owned_meter_id) || 0;
  if (mid === owned) {
    return db.query(
      'SELECT ' + cols + ' FROM water_alerts WHERE meter_id IN (?, 0) ORDER BY id DESC LIMIT ?',
      [mid, cap]
    );
  }
  return db.query(
    'SELECT ' + cols + ' FROM water_alerts WHERE meter_id = ? ORDER BY id DESC LIMIT ?',
    [mid, cap]
  );
}

module.exports = { in_cooldown, record, dispatch, send_test, recent, build_email, COLORS };
