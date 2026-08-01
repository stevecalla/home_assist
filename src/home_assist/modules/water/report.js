#!/usr/bin/env node
'use strict';
/**
 * report.js — read the water tables from the terminal, without opening the UI.
 *
 *   node src/home_assist/modules/water/report.js readings [n]
 *   node src/home_assist/modules/water/report.js hourly   [n]
 *   node src/home_assist/modules/water/report.js daily    [n]
 *   node src/home_assist/modules/water/report.js alerts   [n]
 *   node src/home_assist/modules/water/report.js settings
 *   node src/home_assist/modules/water/report.js status
 *   node src/home_assist/modules/water/report.js dbsize   (row counts + MB per table + projection)
 *   node src/home_assist/modules/water/report.js reset    (dry run; add --yes to actually wipe)
 *
 * Useful when you are SSH'd into the Ubuntu box and want to know what the collector is seeing
 * without port-forwarding the dashboard.
 */
require('../../env');

const db = require('../../store/db');
const schema = require('../../store/schema');
const time = require('../../time');
const settings = require('./store/settings');
const readings = require('./store/readings');
const alerts = require('./store/alerts');
const rules = require('./rules/leak_rules');

function bar(n, max, width) {
  if (!max) return '';
  const len = Math.round((n / max) * (width || 40));
  return '█'.repeat(Math.max(n > 0 ? 1 : 0, len));
}

async function main() {
  const cmd = process.argv[2] || 'status';
  const n = Number(process.argv[3]) || null;
  const cfg = await settings.all({ force: true });
  const meter = cfg.meter_id;

  if (cmd === 'dbsize') {
    const sizes = await readings.table_sizes();
    const total = sizes.reduce(function (a, r) { return a + Number(r.mb || 0); }, 0);
    console.log('water tables in `' + (process.env.MYSQL_DATABASE || 'home_assist') + '`\n');
    console.log('  ' + 'table'.padEnd(26) + 'rows'.padStart(12) + '     MB');
    sizes.forEach(function (r) {
      console.log('  ' + String(r.name).padEnd(26) + String(r.approx_rows).padStart(12) + '  ' + String(r.mb).padStart(7));
    });
    console.log('  ' + ''.padEnd(26) + ''.padStart(12) + '  ' + total.toFixed(2).padStart(7) + '  total');

    // Projection from what has actually been observed, not from a guess.
    const rows = await db.query(
      'SELECT COUNT(*) AS n, MIN(read_at_utc) AS first, MAX(read_at_utc) AS last FROM water_readings WHERE meter_id = ?',
      [meter]
    );
    const r = rows[0];
    if (r && r.n > 0 && r.first && r.last) {
      const days = Math.max(1 / 24, (new Date(r.last + 'Z') - new Date(r.first + 'Z')) / 86400000);
      const perDay = r.n / days;
      console.log('\n  observed: ' + r.n + ' readings over ' + days.toFixed(1) + ' day(s) = ' +
        perDay.toFixed(0) + '/day');
      console.log('  projected: ' + Math.round(perDay * 365).toLocaleString() + ' rows/year (~' +
        ((perDay * 365 * 60) / 1024 / 1024).toFixed(0) + ' MB/yr at ~60 bytes/row)');
      console.log('  water_hourly grows at a fixed 8,760 rows/yr regardless of usage.');
    } else {
      console.log('\n  (no readings yet — nothing to project from)');
    }
    console.log('\n  Retention is configured on the Settings page (Retention group).');
    return;
  }

  if (cmd === 'reset') {
    // Wipe the measurement history and start over. Deliberately a first-class command rather than a
    // pasted TRUNCATE, because getting the table LIST wrong is the whole risk: dropping
    // `water_settings` silently reverts every tuned threshold back to a built-in guess, and you
    // would not notice until an alert failed to fire.
    // Derived from the schema, not hand-listed: a table added later is cleared automatically
    // instead of being quietly left behind by a stale array in this file.
    const also_settings = process.argv.includes('--settings');
    const TABLES = schema.TABLES
      .map(function (t) { return t.name; })
      .filter(function (n) { return also_settings || n !== 'water_settings'; });

    const before = [];
    for (const t of TABLES) {
      const r = await db.query('SELECT COUNT(*) AS n FROM ' + t);
      before.push({ t: t, n: Number(r[0].n) });
    }

    console.log('reset — the following tables will be EMPTIED:\n');
    before.forEach(function (b) { console.log('  ' + b.t.padEnd(26) + String(b.n).padStart(9) + ' rows'); });
    console.log('\n  kept: water_settings' + (also_settings ? '  <-- NO, --settings was passed; thresholds revert to defaults' :
      ' (your thresholds, meter id, and retention windows)'));

    if (!process.argv.includes('--yes')) {
      console.log('\n  Nothing was changed. Re-run with --yes to confirm.');
      console.log('  Stop the collector first, or its in-memory baseline will immediately re-write');
      console.log('  the odometer it was holding:  npm run pm2_stop_water_collector');
      return;
    }

    for (const t of TABLES) await db.query('TRUNCATE TABLE ' + t);
    console.log('\n  cleared ' + TABLES.length + ' table(s).');
    console.log('  Start the collector and the next packet becomes the new baseline:');
    console.log('    npm run pm2_restart_water_collector');
    return;
  }

  if (cmd === 'settings') {
    console.log('water settings (DB value > .env > built-in default)\n');
    let group = null;
    settings.describe(cfg).forEach(function (s) {
      if (s.group !== group) { group = s.group; console.log('  ' + group); }
      console.log('    ' + s.name.padEnd(28) + String(s.value));
    });
    return;
  }

  if (cmd === 'readings') {
    const rows = await readings.recent_readings(meter, n || 20);
    console.log('last ' + rows.length + ' readings (newest first)\n');
    rows.forEach(function (r) {
      console.log('  ' + r.read_at_mtn + '   ' + String(Number(r.gallons).toFixed(0)).padStart(9) +
        ' gal   +' + Number(r.delta_gallons).toFixed(0));
    });
    return;
  }

  if (cmd === 'hourly') {
    const series = await readings.hourly_series(meter, n || 48);
    const max = series.reduce(function (a, s) { return Math.max(a, s.gallons); }, 0);
    console.log('hourly usage, last ' + series.length + 'h (local ' + time.zone() + ')\n');
    series.forEach(function (s) {
      const overnight = s.hour >= cfg.overnight_start_hour && s.hour < cfg.overnight_end_hour;
      console.log('  ' + s.hour_key + (overnight ? ' *' : '  ') + ' ' +
        String(s.gallons.toFixed(0)).padStart(6) + '  ' + (s.observed ? bar(s.gallons, max, 40) : '(no data)'));
    });
    console.log('\n  * = inside the overnight window (' + cfg.overnight_start_hour + ':00–' + cfg.overnight_end_hour + ':00)');
    return;
  }

  if (cmd === 'daily') {
    const series = await readings.daily_series(meter, n || 30);
    const max = series.reduce(function (a, s) { return Math.max(a, s.gallons); }, 0);
    console.log('daily usage, last ' + series.length + ' days\n');
    series.forEach(function (s) {
      console.log('  ' + s.day_key + ' ' + String(s.gallons.toFixed(0)).padStart(7) + '  ' +
        (s.observed ? bar(s.gallons, max, 40) : '(no data)'));
    });
    return;
  }

  if (cmd === 'alerts') {
    const rows = await alerts.recent(n || 30);
    if (!rows.length) { console.log('no alerts recorded — which is the good outcome.'); return; }
    console.log('last ' + rows.length + ' alerts (newest first)\n');
    rows.forEach(function (r) {
      console.log('  ' + r.fired_at_mtn + '  [' + r.kind.padEnd(10) + '] ' +
        (r.delivered ? 'sent   ' : 'NOTSENT') + '  ' + r.message);
      if (r.delivery_note) console.log('      ' + r.delivery_note);
    });
    return;
  }

  // status
  const state = await readings.get_state(meter);
  const hours = await readings.hour_map(meter, 72);
  const now = new Date();
  const last_read_at = state && state.last_read_at_utc ? new Date(state.last_read_at_utc + 'Z') : null;
  const started_at = state && state.started_at_utc ? new Date(state.started_at_utc + 'Z') : null;
  const s = rules.status({ hours, now, cfg, tz: time.zone(), last_read_at, started_at });

  console.log('\n  ' + s.headline.toUpperCase() + ' — ' + s.detail + '\n');
  console.log('  meter          : ' + meter);
  console.log('  odometer       : ' + (state && state.last_gallons !== null ? Number(state.last_gallons).toFixed(0) + ' gal' : '—'));
  console.log('  last reading   : ' + (state ? state.last_read_at_utc + ' UTC' : '—'));
  console.log('  last heartbeat : ' + (state ? state.last_heartbeat_utc + ' UTC' : '—'));
  console.log('  collector mode : ' + (state ? state.collector_mode : '—'));

  const day = time.day_key(now);
  const todayKeys = [];
  for (let h = 0; h <= time.local_hour(now); h++) todayKeys.push(day + 'T' + String(h).padStart(2, '0'));
  console.log('  today          : ' + rules.sum_hours(hours, todayKeys).total.toFixed(0) + ' gal');
  console.log('  overnight      : ' + rules.sum_hours(hours, rules.overnight_keys(now, cfg, time.zone())).total.toFixed(0) +
    ' gal  (threshold ' + cfg.overnight_threshold_gal + ')');
  console.log('  last 24h       : ' + rules.sum_hours(hours, time.recent_hour_keys(now, 24)).total.toFixed(0) + ' gal');
}

main()
  .catch(function (e) { console.error(e.message); process.exitCode = 1; })
  .finally(function () { db.end(); });
