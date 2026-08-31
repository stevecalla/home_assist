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

/**
 * SUBJECT LINES.
 *
 * The subject used to be a category and a timestamp: "[WATER] Overnight flow - 2026-08-31 06:00:12".
 * On a phone lock screen at 3am that is a prefix, a category, and a date -- everything except the
 * one thing you need, which is HOW MUCH and WHOSE. The subject is the only part of an email
 * guaranteed to be read, so it now carries the fact and the place, and the timestamp moves into the
 * body where it was always available anyway.
 *
 * Each builder returns the middle of the line; the meter's name is appended by subject_for().
 */
const SUBJECT_FACT = {
  overnight: function (a) {
    const g = a.detail && a.detail.total_gal;
    return g === undefined || g === null ? 'Water ran overnight' : Math.round(g) + ' gal overnight';
  },
  continuous: function (a) {
    const h = a.detail && a.detail.hours;
    return h ? 'Water every hour for ' + h + 'h' : 'Continuous flow';
  },
  run: function (a) {
    const m = a.detail && a.detail.minutes;
    return m ? 'Running ' + fmt_dur(m) + ' without stopping' : 'Running a long time';
  },
  run_clear: function (a) {
    const m = a.detail && a.detail.minutes;
    return m ? 'Stopped after ' + fmt_dur(m) : 'The run has stopped';
  },
  // Just the fact. The body says what it means; a subject carrying both facts and the meter name
  // ended up with two em-dashes and read as a run-on on a lock screen.
  stale: 'Receiver silent',
  // The only subject that gets TWO figures. Every other alert is about an incident and the subject
  // should carry that one thing; the summary is the standing report, so yesterday alone leaves out
  // the number people actually open it for. Month name without the year -- the year is never the
  // ambiguous part in a mail arriving today, and subject space is the scarcest thing here.
  summary: function (a, ctx) {
    const g = a.detail && a.detail.total_gal;
    const yday = g === undefined || g === null ? 'Daily summary' : Math.round(g) + ' gal yesterday';
    const m = ctx && ctx.months && ctx.months.this_month;
    if (!m) return yday;
    return yday + ' \u00b7 ' + Math.round(m.gallons).toLocaleString() + ' gal in '
      + String(m.label).split(' ')[0];
  },
  test: 'Test alert',
};

function fmt_dur(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? h + 'h ' + rest + 'm' : h + 'h';
}

/** What the meter is CALLED, with the id kept beside it -- never instead of it. */
function meter_label(ctx, cfg) {
  const id = (ctx && ctx.meter_id) || (cfg && cfg.meter_id);
  const name = ctx && ctx.meter_name ? String(ctx.meter_name).trim() : '';
  return name ? name + ' (' + id + ')' : String(id);
}

function subject_for(alert, ctx, cfg) {
  const f = SUBJECT_FACT[alert.kind];
  const fact = typeof f === 'function' ? f(alert, ctx) : (f || 'Alert');
  const name = ctx && ctx.meter_name ? String(ctx.meter_name).trim() : '';
  return '[WATER] ' + fact + (name ? ' \u2014 ' + name : '');
}

/**
 * WHAT TO CHECK. The difference between a notification and a useful one.
 *
 * Only the `stale` alert ever told anyone what to do about it. A neighbour who receives "water ran
 * overnight" and has no idea that a toilet flapper is the overwhelmingly likely cause has been
 * informed and not helped -- and is one step from deciding these emails are noise.
 */
const CHECKLIST = {
  overnight: [
    'A toilet that runs after flushing — the most common cause by far. Put a few drops of food colouring in the tank; if colour reaches the bowl without flushing, the flapper is leaking.',
    'An irrigation or sprinkler timer set to run at night.',
    'A water softener regenerating — normal, and usually the same time each week.',
    'An ice maker or humidifier topping up.',
  ],
  continuous: [
    'A running toilet, an outside hose or spigot left open, or an irrigation zone stuck on.',
    'If none of those, and nothing is obviously running, shut the main valve and see whether the meter still advances — if it does, the leak is between the meter and the house.',
  ],
  run: [
    'Something is using water right now and has not stopped. A hose, an irrigation zone, or a filling tub or pool are the usual explanations.',
    'If nothing should be running, this is the alert most worth acting on immediately.',
  ],
  stale: [
    'Check that the collector process is running and that the SDR dongle is seated.',
    'While the receiver is silent nothing is being watched — a leak now would not be detected.',
  ],
};

const SUBJECT_PREFIX = {   // kept: the alerts LIST and tests still read these labels
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
  const owned = !ctx || Number(ctx.meter_id) === Number(cfg.meter_id);

  const rows = [
    ['Meter', meter_label(ctx, cfg)],
    ['When', time.sql_local(now) + ' ' + (process.env.WATER_TZ || 'America/Denver')],
  ];
  // `Signal: overnight` is gone. It was the internal `kind` string, and the headline above it
  // already says what happened in words.
  if (ctx && ctx.last_gallons !== undefined && ctx.last_gallons !== null) {
    rows.push(['Meter reading', Number(ctx.last_gallons).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' gal']);
  }
  if (ctx && ctx.today_gallons !== undefined) {
    rows.push(['Today so far', Number(ctx.today_gallons).toFixed(0) + ' gal']);
  }

  // ── the numbers behind the verdict ────────────────────────────────────────────────────────────
  // Curated per rule, not `Object.keys(alert.detail)`. That dump produced rows like
  // "min gal per hour: 1" -- machine-readable, and it made every email look like a log line.
  const D = alert.detail || {};
  const detail_rows = [];
  const add = (label, v, suffix) => {
    if (v === null || v === undefined || typeof v === 'object') return;
    detail_rows.push([label, String(v) + (suffix || '')]);
  };
  if (alert.kind === 'overnight') {
    add('Used overnight', D.total_gal === undefined ? undefined : Number(D.total_gal).toFixed(0), ' gal');
    add('Alerts above', D.threshold_gal, ' gal');
    if (D.start_hour !== undefined && D.end_hour !== undefined) {
      add('Overnight window', D.start_hour + ':00 to ' + D.end_hour + ':00');
    }
  } else if (alert.kind === 'continuous') {
    add('Hours in a row with water', D.hours);
    add('Counts as flow above', D.min_gal_per_hour, ' gal/hour');
  } else if (alert.kind === 'run' || alert.kind === 'run_clear') {
    if (D.minutes !== undefined) add('Ran for', fmt_dur(D.minutes));
    add('Volume', D.gallons === undefined ? undefined : Number(D.gallons).toFixed(0), ' gal');
  } else if (alert.kind === 'stale') {
    if (D.minutes !== undefined) add('Silent for', fmt_dur(D.minutes));
  } else if (alert.kind === 'summary') {
    add('Yesterday', D.total_gal === undefined ? undefined : Number(D.total_gal).toFixed(0), ' gal');
    add('Of that, overnight', D.overnight_gal === undefined ? undefined : Number(D.overnight_gal).toFixed(0), ' gal');
    if (D.avg_gal !== null && D.avg_gal !== undefined) {
      add('Your ' + D.avg_over_days + '-day average', Number(D.avg_gal).toFixed(0), ' gal/day');
    }
  } else {
    // Anything without a hand-written mapping still shows its numbers rather than hiding them.
    Object.keys(D).forEach(function (k) {
      if (k === 'keys') return;
      add(k.replace(/_/g, ' '), D[k]);
    });
  }
  detail_rows.forEach(function (r) { rows.push(r); });

  // ── month context, on EVERY email ─────────────────────────────────────────────────────────────
  // "12 gal overnight" is alarming if the house usually does 3 and unremarkable if it usually does
  // 40. The months are what turn a number into a judgement, and they are what the utility bills on.
  // Skipped for `stale`: that alert's entire message is "I cannot see this meter", and printing
  // month totals underneath it offers context for data it has just said it is not receiving.
  const M = alert.kind === 'stale' ? null : (ctx && ctx.months);
  const month_value = function (m) {
    let v = Math.round(m.gallons).toLocaleString() + ' gal';
    if (m.partial) v += ' so far (' + m.observed_days + ' days)';
    // A month with gaps has an understated total. Saying so beats presenting it as complete.
    else if (!m.complete) v += ' — ' + (m.days - m.observed_days) + ' day(s) not recorded';
    return v;
  };
  // On the summary the months are stated as a sentence below the headline (see `body`), so they are
  // NOT repeated as rows -- the same two numbers twice on one screen is noise, not emphasis.
  if (M && alert.kind !== 'summary') {
    ['this_month', 'last_month'].forEach(function (slot) {
      const m = M[slot];
      if (m) rows.push([m.label, month_value(m)]);
    });
  }

  // THE SUMMARY gets the months as a sentence as well as a row.
  //
  // Every other email is about something that just happened, and the months are background. The
  // daily summary has no incident at all -- "where do I stand" IS its subject -- so the figure it
  // exists to deliver should not be the eighth row of a table.
  let body = '';
  if (alert.kind === 'summary' && M && M.this_month && M.last_month) {
    // month_value() already carries its own "so far (N days)" qualifier, so the sentence must not
    // add a second one -- "August 2026 so far: 2,480 gal so far (20 days)" was the first draft.
    body = M.this_month.label + ': ' + month_value(M.this_month) + '. '
      + M.last_month.label + ' finished at ' + month_value(M.last_month) + '.';
  }

  // ── who is reading this ───────────────────────────────────────────────────────────────────────
  // The footer pointed everyone at "the Water > Settings page". For a neighbour that is a page they
  // cannot open, in an app they do not administer -- the same operator's-chair mistake the Meters
  // page had. Branch on whose meter it is.
  const footer = alert.kind === 'stale'
    ? 'Leak detection is not running while the receiver is silent. Check that collector_water.js is up and the dongle is seated.'
    : owned
      ? 'Sent by home_assist. Thresholds are editable on the Water > Settings page.'
      : 'Sent by home_assist, which watches this meter. Reply to this email if you would like these alerts changed or stopped.';

  return {
    subject: subject_for(alert, ctx, cfg),
    text: alert.message + (body ? '\n' + body : '') + '\n\n'
      + rows.map(function (r) { return r[0] + ': ' + r[1]; }).join('\n')
      + (CHECKLIST[alert.kind] ? '\n\nWhat to check:\n- ' + CHECKLIST[alert.kind].join('\n- ') : '')
      + '\n\n' + footer,
    html: mailer.html_alert({
      title: 'Water monitor',
      headline: alert.message,
      body: body || '',
      color: COLORS[alert.kind] || '#6c757d',
      rows: rows,
      checklist_title: CHECKLIST[alert.kind] ? 'What to check' : '',
      checklist: CHECKLIST[alert.kind] || null,
      // LAN-only by design, so this is dead weight when they are out of the house — and exactly
      // what you want when they are in it.
      link: cfg.app_url ? { href: cfg.app_url, label: 'Open the water monitor' } : null,
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
    // Per-meter address list if this meter has one, else the global list, else (undefined) the
    // mailer's EMAIL_RECIPIENT. The caller resolves the meter's own list -- alerts.js does not
    // read the registry, so it stays testable without a database.
    const to = (ctx && ctx.email_to ? String(ctx.email_to) : String(cfg.alert_email_to || '')).trim() || undefined;
    const r = await mailer.send({ to: to, subject: mail.subject, text: mail.text, html: mail.html });
    channels.email = r;
    // WHO accepted, not merely whether the send worked. Three good addresses and one typo used to
    // record as a clean success, and the typo stayed invisible until someone mentioned they never
    // get the alerts. A rejected address belongs in the ledger.
    if (r.ok && r.rejected && r.rejected.length) {
      notes.push('email:partial — rejected ' + r.rejected.join(', '));
    } else if (r.ok) {
      notes.push('email:ok' + (r.accepted && r.accepted.length > 1 ? ' (' + r.accepted.length + ' recipients)' : ''));
    } else {
      notes.push('email:' + r.error);
    }
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

module.exports = { in_cooldown, record, dispatch, send_test, recent, build_email, subject_for, CHECKLIST, COLORS };
