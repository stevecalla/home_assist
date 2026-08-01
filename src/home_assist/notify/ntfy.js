'use strict';
/**
 * ntfy.js — optional phone push, kept from the original monitor.mjs.
 *
 * Email is the primary channel (see notify/mailer.js). ntfy stays available because a leak at 3am
 * is exactly the case where a push notification beats an email nobody reads until morning — but
 * it is off unless a topic is set, and nothing depends on it.
 *
 * Anyone who knows the topic can read your alerts, so use something random.
 */

async function send(opts) {
  const topic = opts.topic;
  if (!topic) return { ok: false, error: 'no ntfy topic set' };
  const server = (opts.server || 'https://ntfy.sh').replace(/\/+$/, '');
  const url = server + '/' + encodeURIComponent(topic);

  let lastErr = 'unknown';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: opts.message,
        headers: {
          Title: opts.title || 'Water monitor',
          Priority: opts.priority || 'default',
          Tags: opts.tags || 'droplet',
        },
      });
      if (res.ok) return { ok: true };
      lastErr = 'HTTP ' + res.status;
    } catch (e) {
      lastErr = e.message;
    }
    if (attempt < 3) await new Promise(function (r) { setTimeout(r, 2000 * attempt); });
  }
  return { ok: false, error: lastErr };
}

module.exports = { send };
