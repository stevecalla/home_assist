#!/usr/bin/env node
/**
 * collector_water.js — the process that actually watches your water meter.
 *
 * Reads the Badger Orion's 900 MHz broadcast via rtl_433, writes every trustworthy reading to
 * MySQL, and emails you when water is running that shouldn't be. Runs FOREVER, independently of
 * the web server: rebuilding or crashing the dashboard must never stop leak detection.
 *
 *   node collector_water.js                    # live — spawn rtl_433 and read the real meter
 *   node collector_water.js --replay           # synthetic meter, no dongle needed (UI/dev work)
 *   node collector_water.js --replay --leak    # synthetic meter with a running toilet
 *   node collector_water.js --replay --file X  # replay a captured .jsonl
 *   node collector_water.js --check            # preflight only: DB, email, rtl_433 — then exit
 *
 * Under pm2:  npm run pm2_start_water_collector
 */
'use strict';

require('./src/home_assist/env');

const db = require('./src/home_assist/store/db');
const schema = require('./src/home_assist/store/schema');
const data_dir = require('./src/home_assist/data_dir');
const mailer = require('./src/home_assist/notify/mailer');
const settings = require('./src/home_assist/modules/water/store/settings');
const rtl433 = require('./src/home_assist/modules/water/collector/rtl433');
const { create_collector } = require('./src/home_assist/modules/water/collector/run');

function arg(name) { return process.argv.includes('--' + name); }
function arg_value(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
}

/**
 * Preflight — fail loudly and specifically at startup rather than silently at 3am.
 * Every check is non-fatal except the database: without MySQL there is nowhere to put a reading.
 */
async function preflight(mode) {
  const paths = data_dir.describe();
  console.log('home_assist water collector');
  console.log('  platform   : ' + paths.platform + ' (user ' + paths.user + ')');
  console.log('  data dir   : ' + paths.app_data + (paths.overridden ? '  [HOMEASSIST_DATA_DIR]' : ''));
  console.log('  mode       : ' + mode);

  const ping = await db.ping();
  if (!ping.ok) {
    console.error('  database   : UNREACHABLE — ' + ping.error);
    console.error('\nFix MYSQL_* in .env, then run `npm run db_init`. Exiting.');
    return false;
  }
  console.log('  database   : ok (' + (process.env.MYSQL_DATABASE || 'home_assist') + ')');

  const cfg = await settings.all({ force: true }).catch(function () { return settings.defaults(); });
  console.log('  meter id   : ' + cfg.meter_id + '  (' + cfg.gallons_per_unit + ' gal/count)');
  console.log('  overnight  : ' + cfg.overnight_start_hour + ':00–' + cfg.overnight_end_hour +
    ':00 > ' + cfg.overnight_threshold_gal + ' gal');
  console.log('  continuous : water every hour for ' + cfg.continuous_hours + 'h');
  console.log('  watchdog   : silent for ' + cfg.stale_minutes + ' min');

  if (Number(cfg.alert_email_enabled) === 1) {
    const v = await mailer.verify();
    if (v.ok) console.log('  email      : ok (' + mailer.config().sender + ' -> ' + (cfg.alert_email_to || mailer.config().recipient) + ')');
    else console.log('  email      : NOT WORKING — ' + v.error);
  } else {
    console.log('  email      : disabled in settings');
  }

  if (Number(cfg.alert_ntfy_enabled) === 1 && cfg.ntfy_topic) console.log('  ntfy push  : on');

  // The radio. Only meaningful in live mode — replay does not spawn anything.
  if (mode === 'live') {
    const cmd = rtl433.resolve_cmd();
    const src = rtl433.cmd_source();
    const found = rtl433.check_command(cmd);
    if (!found.ok) {
      console.log('  rtl_433    : NOT FOUND — ' + found.reason +
        (src ? '   [' + src + ']' : '   [no WATER_RTL433_CMD* set — using the built-in default]'));
      if (found.how === 'PATH') {
        console.log('               Either add it to PATH, or set the full path in WATER_RTL433_CMD.');
        console.log('               Under pm2/systemd, PATH is often narrower than your shell\'s.');
      }
    } else {
      console.log('  rtl_433    : ok — ' + found.detail + '  (' + found.how +
        (src ? ', from ' + src : ', built-in default') + ')');
      const orion = rtl433.has_orion_decoder(cmd);
      console.log(orion.ok
        ? '  decoder    : ' + orion.detail
        : '  decoder    : PROBLEM — ' + orion.reason);

      // The ARGS matter as much as the command — sample rate and gain decide whether a weak meter
      // is decodable at all — and until now the preflight reported the command but never them. An
      // override that silently is not in effect (an unsuffixed WATER_RTL433_ARGS beats the
      // _LINUX one) looked identical to one that was.
      const args_src = rtl433.args_source();
      console.log('  args       : ' + rtl433.resolve_args() +
        '  (from ' + (args_src || 'built-in default') + ')');
    }
  } else {
    console.log('  rtl_433    : not checked (replay mode)');
  }

  if (Number(cfg.alert_email_enabled) !== 1 && Number(cfg.alert_ntfy_enabled) !== 1) {
    console.log('\n  WARNING: no alert channel is enabled. Leaks will be recorded but nobody told.\n');
  }
  return true;
}

async function main() {
  const mode = arg('replay') ? 'replay' : (process.env.WATER_COLLECTOR_MODE || 'live');

  await schema.ensure_schema(db).catch(function () { /* preflight reports the real error */ });

  const ok = await preflight(mode);
  if (!ok) { await db.end(); process.exit(1); }
  if (arg('check')) { console.log('\npreflight only (--check) — exiting.'); await db.end(); process.exit(0); }

  const collector = await create_collector({
    mode: mode,
    simulate_leak: arg('leak'),
    replay_file: arg_value('file'),
    interval_ms: arg('replay') ? 1000 : undefined,
  });

  console.log('\nwatching. Ctrl-C to stop.\n');
  // Run one check immediately so a restart does not wait a full minute to notice a silent receiver.
  await collector.tick();

  let shutting_down = false;
  async function shutdown() {
    if (shutting_down) return;
    shutting_down = true;
    console.log('\nGracefully shutting down...');
    try { await collector.stop(); } catch (e) { /* ignore */ }
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
