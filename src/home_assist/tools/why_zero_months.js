'use strict';
/**
 * why_zero_months.js — why does the daily summary say "August 2026: 0 gal so far"?
 *
 * Run from the app folder:   node src/home_assist/tools/why_zero_months.js
 *
 * month_totals() reads water_hourly for ONE meter over a date range. The range logic is verified by
 * tests, so a zero total means the rows are not where the query is looking. There are only a few
 * ways that happens, and this prints enough to tell them apart:
 *
 *   1. the rows are under a DIFFERENT meter_id than the one the summary is about
 *   2. water_hourly only goes back a few days (retention, or a recently rebuilt table)
 *   3. hour_key is not in the local 'YYYY-MM-DDTHH' form the range filter assumes
 *
 * Read-only. Touches nothing.
 */
const path = require('path');
require(path.join(__dirname, '..', 'env'));
const db = require(path.join(__dirname, '..', 'store', 'db'));
const time = require(path.join(__dirname, '..', 'time'));
const settings = require(path.join(__dirname, '..', 'modules', 'water', 'store', 'settings'));
const readings = require(path.join(__dirname, '..', 'modules', 'water', 'store', 'readings'));

(async function () {
  try {
    const cfg = await settings.all();
    console.log('WATER_TZ            :', time.zone());
    console.log('cfg.meter_id        :', cfg.meter_id, ' <- the meter the summary is about');
    console.log('hourly_retention_days:', cfg.hourly_retention_days, '(0 = forever)');
    console.log('');

    // 1. WHOSE rows are in the rollup at all.
    const per = await db.query(
      'SELECT meter_id, COUNT(*) AS rows_, MIN(hour_key) AS first_key, MAX(hour_key) AS last_key, ' +
      '       ROUND(SUM(gallons)) AS gallons ' +
      'FROM water_hourly GROUP BY meter_id ORDER BY rows_ DESC');
    console.log('water_hourly, by meter:');
    console.table(per);
    if (!per.some(function (r) { return Number(r.meter_id) === Number(cfg.meter_id); })) {
      console.log('>> cfg.meter_id has NO rows in water_hourly at all. That alone explains a zero');
      console.log('   month total, and means the rollup is being written under a different id.');
    }

    // 2. HOW FAR BACK the rollup goes for that meter.
    const days = await db.query(
      'SELECT LEFT(hour_key, 10) AS day_key, ROUND(SUM(gallons)) AS gallons, COUNT(*) AS hours_ ' +
      'FROM water_hourly WHERE meter_id = ? GROUP BY day_key ORDER BY day_key DESC LIMIT 14',
      [cfg.meter_id]);
    console.log('\nthe newest 14 days for cfg.meter_id:');
    console.table(days);

    // 3. WHAT the keys look like. The range filter is a string compare against 'YYYY-MM-DDTHH'.
    const sample = await db.query(
      'SELECT hour_key FROM water_hourly WHERE meter_id = ? ORDER BY hour_key DESC LIMIT 3',
      [cfg.meter_id]);
    console.log('\nhour_key samples:', sample.map(function (r) { return r.hour_key; }).join('  '));
    const bad = sample.filter(function (r) { return !/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(String(r.hour_key)); });
    if (bad.length) {
      console.log('>> these are NOT in the YYYY-MM-DDTHH form the month range filter assumes.');
    }

    // 4. And the answer the email actually printed.
    for (const back of [0, 1]) {
      const r = time.month_range(new Date(), back);
      console.log('\n' + r.label + '  range ' + r.from + 'T00 .. ' + r.to + 'T23');
    }
    const m = await readings.month_totals(cfg.meter_id);
    console.log('\nmonth_totals(' + cfg.meter_id + '):');
    console.log(JSON.stringify(m, null, 1));
  } catch (e) {
    console.log('ERROR:', e.message);
  }
  process.exit(0);
})();
