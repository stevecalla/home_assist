'use strict';
/**
 * schema.js — every table home_assist needs, created (and migrated) idempotently on startup.
 *
 * Safe to run repeatedly. Both the web server and the collector call ensure_schema(), so whichever
 * starts first creates the tables and the other finds them already there.
 *
 * Three things happen, in order:
 *
 *   1. CREATE TABLE IF NOT EXISTS  — the tables, for a fresh machine.
 *   2. ADD COLUMN for anything missing — because step 1 is a NO-OP on a table that already exists.
 *      Without this, adding a column here would silently do nothing on every machine that has
 *      already run the app once, and the failure would surface as "Unknown column" at 2am.
 *   3. Sync the table COMMENT — the one-line purpose, so `SHOW TABLE STATUS`, MySQL Workbench, and
 *      anyone poking at the database a year from now can see what a table is FOR without reading
 *      this file. Only rewritten when it has actually drifted.
 *
 * Timestamp convention (from usat_apps): every row carries BOTH a local and a UTC wall clock,
 * stamped in Node by src/home_assist/time.js — never CONVERT_TZ, which depends on the MySQL server's
 * timezone tables being loaded and therefore differs between the Windows laptop and the Ubuntu box.
 *
 *   *_utc / *_mtn      when the THING happened (a reading, an alert)
 *   created_at_mtn /   when the ROW was written. The same instant as the event column today, but
 *   created_at_utc     they diverge the moment anything is backfilled, replayed, or imported — and
 *                      then "when did we learn this?" is a different question from "when did it
 *                      happen?", and only one of them is answerable after the fact.
 *
 * `created_at_*` is nullable on purpose: rows written before the migration genuinely do not know
 * when they were created, and a fabricated value would be worse than an honest NULL.
 *
 * What this replaces from the original monitor.mjs:
 *   usage.csv            -> water_readings
 *   state.hours          -> water_hourly
 *   state.notified       -> water_alerts   (cooldowns now survive a restart)
 *   state.lastReading    -> water_collector_state
 *   state.radioQuiet     -> water_collector_state.radio_quiet
 *   the CONFIG consts    -> water_settings (editable from the UI)
 */

/**
 * The self-documenting `purpose` column, from usat_apps
 * (modules/salesforce_merge/store/merge_run.js): a NOT NULL VARCHAR(400) with the description as
 * its DEFAULT, sitting right after the key so it shows up in `SELECT *`. Someone who runs a query
 * against this database learns what the table is for without opening a schema browser.
 *
 * It is stored per row, so keep these to ONE crisp line — the full prose lives in the table
 * COMMENT, which costs nothing per row. water_readings alone is ~70k rows a year.
 *
 * Changing the text here updates the DEFAULT and backfills existing rows on the next boot, so the
 * column never disagrees with itself.
 */
const PURPOSE_COL = "VARCHAR(400) NOT NULL DEFAULT ";

function purpose_def(short, after) {
  return PURPOSE_COL + "'" + String(short).replace(/'/g, "''") + "'" + (after ? ' AFTER `' + after + '`' : '');
}

// The two timestamp columns every table gets, in the usat_apps order (mtn, then utc), last before the keys.
const CREATED_MTN = "DATETIME NULL COMMENT 'row written, local wall clock (WATER_TZ) -- app-stamped'";
const CREATED_UTC = "DATETIME NULL COMMENT 'row written, UTC wall clock -- app-stamped'";
const CREATED_AT = `
     created_at_mtn ${CREATED_MTN},
     created_at_utc ${CREATED_UTC}`;

/**
 * The one-line text that lands in each table's `purpose` column (and therefore in every row).
 * Single-quote-free by construction so the DDL interpolation below stays simple; ASCII only, for
 * the same reason the table COMMENTs are -- this text ends up in CSV exports and schema dumps.
 */
const SHORT = {
  water_reception:
    "Per-minute proof the radio is hearing your meter: packets decoded, how many were ours, how strong. Runs forever, unlike water_raw_samples.",
  water_readings:
    "Every accepted meter reading that carried flow: odometer + gallons credited. Detail only -- charts and leak rules read water_hourly.",
  water_hourly:
    "Hourly usage rollup in local time. Source of truth for every chart and leak rule. Row exists = we were listening; no row = we were not.",
  water_alerts:
    "Every alert raised and whether it was delivered. Doubles as the cooldown ledger, so cooldowns survive a collector restart.",
  water_collector_state:
    "One row per meter: the collector live status + heartbeat. Lets the UI tell \"up but hearing nothing\" from \"down\".",
  water_settings:
    "Tunable thresholds, editable from the Settings page. DB row > .env > built-in default. Not cleared by water_reset.",
  water_raw_samples:
    "Rolling buffer of raw rtl_433 lines for decoder field-name forensics. A diagnostic buffer, not an archive -- pruned hourly.",
  water_meters:
    "One row per meter ever heard: label, model, whether it is yours, and when it was first and last seen. The source of truth for the meter selector.",
  water_packets:
    "Every decoded transmission, one row each, every meter in range -- the granular near-real-time view. Neighbours are captured for antenna work and never counted. Bounded by a short prune.",
};

const PURPOSE_RECEPTION =
  'Per-minute reception log: how many packets the radio decoded, how many were OURS, and how strong they were. One row per minute for as long as the collector runs. This is the table to look at to answer "is it hearing my meter right now?" -- water_raw_samples cannot answer it, because that one stops after a fixed number of packets per run on purpose. A gap in this table is the real signal that reception was lost.';

const PURPOSE_PACKETS =
  'Every Badger Orion transmission the decoder resolved -- ours and the neighbours -- one row each, at whole-second precision with the signal figures from -M level. This is the granular, near-real-time view: what the radio actually received, before any aggregation. Rows for other meters are captured for antenna work ONLY; they never advance an odometer, never enter a leak rule and never raise an alert. Bounded by packets_retention_days (default 1), so its size is set by the clock and not by how much water you use.';

const PURPOSE_METERS =
  'The registry of every meter this receiver has ever decoded, added automatically the first time one is heard. It exists so the UI has a stable list to offer -- water_packets is pruned within a day, so a meter that went quiet this morning would otherwise vanish from the dropdown and look like it never existed. `owned` marks the meter the leak rules and alerts run for; everything else is observed, kept for antenna comparison, and bounded by observed_retention_days. `gallons_per_unit` lives here per meter because Badger classic endpoints count 1 gallon and newer ones count 0.1 -- applying the wrong one is a silent 10x error that looks entirely plausible.';

const TABLES = [
  {
    name: 'water_readings',
    short: SHORT.water_readings,
    purpose_after: 'id',
    purpose:
      'One row per ACCEPTED meter reading that carried flow: the odometer value plus the gallons ' +
      'credited since the previous accepted reading. Replaces usage.csv from monitor.mjs. Detail ' +
      'only -- every chart and every leak rule reads water_hourly, so this can be pruned freely.',
    ddl: `CREATE TABLE IF NOT EXISTS water_readings (
     id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     purpose ${PURPOSE_COL}'${SHORT.water_readings}',
     meter_id      BIGINT UNSIGNED NOT NULL,
     read_at_utc   DATETIME        NOT NULL,
     read_at_mtn   DATETIME        NOT NULL,
     gallons       DECIMAL(14,2)   NOT NULL COMMENT 'meter odometer, gallons',
     delta_gallons DECIMAL(10,2)   NOT NULL DEFAULT 0 COMMENT 'gallons since the previous accepted reading',${CREATED_AT},
     PRIMARY KEY (id),
     KEY idx_meter_time (meter_id, read_at_utc),
     KEY idx_time (read_at_utc)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },

  {
    name: 'water_hourly',
    short: SHORT.water_hourly,
    purpose_after: 'hour_key',
    purpose:
      'Hourly usage rollup in LOCAL time; hour_key is YYYY-MM-DDTHH. The source of truth for every ' +
      'chart and every leak rule. A row EXISTING means the collector was hearing the meter that ' +
      'hour; gallons=0 means it heard it and no water moved. A MISSING row means we were not ' +
      'listening. On a leak monitor those mean opposite things -- never zero-fill this table.',
    ddl: `CREATE TABLE IF NOT EXISTS water_hourly (
     meter_id       BIGINT UNSIGNED NOT NULL,
     hour_key       CHAR(13)        NOT NULL COMMENT 'local YYYY-MM-DDTHH',
     purpose ${PURPOSE_COL}'${SHORT.water_hourly}',
     hour_start_mtn DATETIME        NOT NULL,
     gallons        DECIMAL(12,2)   NOT NULL DEFAULT 0,
     reading_count  INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'trusted packets heard this hour (~900), not readings with flow',
     updated_at_utc DATETIME        NOT NULL,
     updated_at_mtn DATETIME        NULL,${CREATED_AT},
     PRIMARY KEY (meter_id, hour_key),
     KEY idx_hour_start (meter_id, hour_start_mtn)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },

  {
    name: 'water_alerts',
    short: SHORT.water_alerts,
    purpose_after: 'id',
    purpose:
      'Every alert raised, and whether it was actually delivered -- those are different facts and ' +
      'both are recorded. Doubles as the cooldown ledger: "have we already sent alert_key?" is a ' +
      'query against this table rather than an in-memory map, so cooldowns survive a restart.',
    ddl: `CREATE TABLE IF NOT EXISTS water_alerts (
     id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     purpose ${PURPOSE_COL}'${SHORT.water_alerts}',
     meter_id      BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'which meter this is about; 0 = written before alerts were per-meter',
     alert_key     VARCHAR(96)     NOT NULL COMMENT 'cooldown key, e.g. overnight:2026-08-01',
     kind          VARCHAR(24)     NOT NULL COMMENT 'overnight | continuous | stale | summary | test',
     severity      VARCHAR(16)     NOT NULL DEFAULT 'default',
     message       TEXT            NOT NULL,
     detail        JSON            NULL,
     delivered     TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '1 = the transport accepted it',
     delivery_note VARCHAR(255)    NULL,
     fired_at_utc  DATETIME        NOT NULL,
     fired_at_mtn  DATETIME        NOT NULL,${CREATED_AT},
     PRIMARY KEY (id),
     KEY idx_key_time (meter_id, alert_key, fired_at_utc),
     KEY idx_time (fired_at_utc),
     KEY idx_meter_time (meter_id, fired_at_utc)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },

  {
    name: 'water_collector_state',
    short: SHORT.water_collector_state,
    purpose_after: 'meter_id',
    purpose:
      'One row per meter: the collector\'s live status. last_heartbeat_utc is written every tick ' +
      'even when no packets arrive, which is what lets the UI tell "collector is up but hearing ' +
      'nothing" apart from "collector is down". A leak monitor that has silently gone deaf must ' +
      'never look like "no leak".',
    ddl: `CREATE TABLE IF NOT EXISTS water_collector_state (
     meter_id           BIGINT UNSIGNED NOT NULL,
     purpose ${PURPOSE_COL}'${SHORT.water_collector_state}',
     last_gallons       DECIMAL(14,2)   NULL,
     last_read_at_utc   DATETIME        NULL,
     last_heartbeat_utc DATETIME        NULL COMMENT 'collector is alive (written even with no packets)',
     radio_quiet        TINYINT(1)      NOT NULL DEFAULT 0,
     collector_mode     VARCHAR(16)     NULL COMMENT 'live | replay',
     started_at_utc     DATETIME        NULL,${CREATED_AT},
     PRIMARY KEY (meter_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },

  {
    name: 'water_settings',
    short: SHORT.water_settings,
    purpose_after: 'name',
    purpose:
      'Every tunable threshold, editable from the Settings page -- what used to be consts at the ' +
      'top of monitor.mjs. Resolution order is DB row > .env > built-in default, so a row here ' +
      'wins. NOT cleared by `npm run water_reset`, because losing a tuned threshold is invisible ' +
      'until the night an alert fails to fire.',
    ddl: `CREATE TABLE IF NOT EXISTS water_settings (
     name           VARCHAR(64)  NOT NULL,
     purpose ${PURPOSE_COL}'${SHORT.water_settings}',
     value          VARCHAR(255) NOT NULL,
     updated_at_utc DATETIME     NULL,
     updated_at_mtn DATETIME     NULL,
     updated_by     VARCHAR(96)  NULL,${CREATED_AT},
     PRIMARY KEY (name)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },

  {
    name: 'water_raw_samples',
    short: SHORT.water_raw_samples,
    purpose_after: 'id',
    purpose:
      'A small rolling buffer of raw rtl_433 lines, so "what are this decoder\'s field names?" is ' +
      'answerable from the Diagnostics page rather than from a terminal you have since closed. A ' +
      'diagnostic buffer, not an archive: trimmed to raw_sample_keep on an hourly sweep, and the ' +
      'writers are rate-limited so a radio producing garbage cannot fill the disk.',
    ddl: `CREATE TABLE IF NOT EXISTS water_raw_samples (
     id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     purpose ${PURPOSE_COL}'${SHORT.water_raw_samples}',
     seen_at_utc  DATETIME        NOT NULL,
     seen_at_mtn  DATETIME        NULL,
     reason       VARCHAR(32)     NOT NULL COMMENT 'sample | other_meter | no_volume | rejected',
     line         TEXT            NOT NULL,${CREATED_AT},
     PRIMARY KEY (id),
     KEY idx_time (seen_at_utc)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    name: 'water_reception',
    short: SHORT.water_reception,
    purpose_after: 'minute_utc',
    purpose: PURPOSE_RECEPTION,
    ddl: `CREATE TABLE IF NOT EXISTS water_reception (
     meter_id      BIGINT UNSIGNED NOT NULL,
     minute_utc    DATETIME        NOT NULL COMMENT 'the minute this row summarises, truncated',
     purpose ${PURPOSE_COL}'${SHORT.water_reception}',
     minute_mtn    DATETIME        NOT NULL,
     packets_total INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'every meter decoded, ours and neighbours',
     packets_ours  INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'from our meter_id only -- legacy, only meaningful on the owned meter row',
     packets       INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'packets from THIS row meter. packets_ours assumed one meter existed; this does not',
     odometer      DECIMAL(14,2)   NULL COMMENT 'meter reading at the end of this minute -- the heartbeat line',
     other_ids     VARCHAR(255)    NULL COMMENT 'other meter ids heard, for antenna work',
     rssi_avg      DECIMAL(6,2)    NULL COMMENT 'needs -M level in WATER_RTL433_ARGS; NULL otherwise',
     rssi_best     DECIMAL(6,2)    NULL,
     snr_avg       DECIMAL(6,2)    NULL,${CREATED_AT},
     PRIMARY KEY (meter_id, minute_utc),
     KEY idx_minute (minute_utc)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    name: 'water_meters',
    short: SHORT.water_meters,
    purpose_after: 'meter_id',
    purpose: PURPOSE_METERS,
    ddl: `CREATE TABLE IF NOT EXISTS water_meters (
     meter_id         BIGINT UNSIGNED NOT NULL,
     purpose ${PURPOSE_COL}'${SHORT.water_meters}',
     label            VARCHAR(64)     NULL COMMENT 'human name for the selector; NULL = show the id',
     model            VARCHAR(32)     NULL COMMENT 'as reported by the decoder, e.g. Badger-ORION',
     owned            TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '1 = the meter leak rules and alerts run for',
     collect_readings TINYINT(1)      NOT NULL DEFAULT 0 COMMENT 'store readings/hourly for it, not just packets',
     notify           TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '1 = DELIVER this meter alerts by email/ntfy. Off for neighbours by design',
     gallons_per_unit DECIMAL(10,4)   NOT NULL DEFAULT 1 COMMENT 'classic Orion counts 1 gal; newer endpoints 0.1. Wrong value = silent 10x error',
     first_heard_utc  DATETIME        NULL,
     first_heard_mtn  DATETIME        NULL,
     last_heard_utc   DATETIME        NULL,
     last_heard_mtn   DATETIME        NULL,
     packets_seen     BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'lifetime count, so the selector can order by how well we hear each one',${CREATED_AT},
     PRIMARY KEY (meter_id),
     KEY idx_last_heard (last_heard_utc)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },

  {
    name: 'water_packets',
    short: SHORT.water_packets,
    purpose_after: 'heard_at_utc',
    purpose: PURPOSE_PACKETS,
    // InnoDB, not ENGINE=MEMORY. MEMORY would save the ~2 MB this table settles at and cost three
    // things: the rows vanish on a MySQL restart, the table is silently capped by the server's
    // max_heap_table_size (16 MB by default, which a longer retention would walk straight into),
    // and it becomes the one table in this schema that behaves differently from all the others.
    // A hard prune already bounds the size; the disk is not the scarce resource here.
    //
    // DATETIME(3) because the point of this table is sub-second ordering. At ~4 seconds between
    // transmissions, whole-second stamps would collide often enough to make "what arrived first"
    // unanswerable -- which is the one question it exists to answer.
    ddl: `CREATE TABLE IF NOT EXISTS water_packets (
     meter_id     BIGINT UNSIGNED NOT NULL,
     heard_at_utc DATETIME(3)     NOT NULL COMMENT 'when the SDR decoded it, to the millisecond',
     purpose ${PURPOSE_COL}'${SHORT.water_packets}',
     heard_at_mtn DATETIME(3)     NOT NULL,
     is_ours      TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '1 = WATER_METER_ID; 0 = a neighbour, captured but never counted',
     volume       DECIMAL(14,2)   NULL COMMENT 'the odometer as transmitted, before gallons_per_unit',
     delta        DECIMAL(14,2)   NULL COMMENT 'change from this meter previous packet; NULL = first seen',
     flags_1      INT             NULL,
     flags_2      INT             NULL,
     integrity    VARCHAR(16)     NULL COMMENT 'CRC / CHECKSUM as reported by the decoder',
     rssi         DECIMAL(6,2)    NULL COMMENT 'needs -M level in WATER_RTL433_ARGS; NULL otherwise',
     snr          DECIMAL(6,2)    NULL,
     noise        DECIMAL(6,2)    NULL,
     freq_mhz     DECIMAL(10,4)   NULL,${CREATED_AT},
     PRIMARY KEY (meter_id, heard_at_utc),
     KEY idx_heard (heard_at_utc)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
];

/**
 * Columns added after a table's first release. CREATE TABLE IF NOT EXISTS will not add them to a
 * database that already exists, so each one needs an explicit ADD COLUMN.
 *
 * Adding a column? Put it in the table's DDL above (for fresh installs) AND here (for the machines
 * that already ran the app). Both — or it works on your laptop and not on the box in the basement.
 */
const ADDED_COLUMNS = [
  ['water_readings', 'purpose', purpose_def(SHORT.water_readings, 'id')],
  ['water_hourly', 'purpose', purpose_def(SHORT.water_hourly, 'hour_key')],
  ['water_alerts', 'purpose', purpose_def(SHORT.water_alerts, 'id')],
  ['water_collector_state', 'purpose', purpose_def(SHORT.water_collector_state, 'meter_id')],
  ['water_settings', 'purpose', purpose_def(SHORT.water_settings, 'name')],
  ['water_packets', 'purpose', purpose_def(SHORT.water_packets, 'heard_at_utc')],
  ['water_packets', 'created_at_mtn', 'DATETIME NULL'],
  ['water_packets', 'created_at_utc', 'DATETIME NULL'],
  ['water_reception', 'packets', 'INT UNSIGNED NOT NULL DEFAULT 0'],
  // 0, not the owned meter id: an existing row was raised before alerts knew about meters, and
  // stamping it with today's owned id would be inventing a fact. The API maps 0 to yours for
  // display, which is honest -- there was only one meter alerting when those rows were written.
  ['water_alerts', 'meter_id', 'BIGINT UNSIGNED NOT NULL DEFAULT 0'],
  ['water_meters', 'notify', "TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = alerts for this meter are DELIVERED, not just recorded'"],
  ['water_meters', 'purpose', purpose_def(SHORT.water_meters, 'meter_id')],
  ['water_meters', 'created_at_mtn', 'DATETIME NULL'],
  ['water_meters', 'created_at_utc', 'DATETIME NULL'],
  ['water_raw_samples', 'purpose', purpose_def(SHORT.water_raw_samples, 'id')],
  ['water_readings', 'created_at_mtn', CREATED_MTN],
  ['water_readings', 'created_at_utc', CREATED_UTC],
  ['water_hourly', 'updated_at_mtn', 'DATETIME NULL'],
  ['water_hourly', 'created_at_mtn', CREATED_MTN],
  ['water_hourly', 'created_at_utc', CREATED_UTC],
  ['water_alerts', 'created_at_mtn', CREATED_MTN],
  ['water_alerts', 'created_at_utc', CREATED_UTC],
  ['water_collector_state', 'created_at_mtn', CREATED_MTN],
  ['water_collector_state', 'created_at_utc', CREATED_UTC],
  ['water_settings', 'updated_at_mtn', 'DATETIME NULL'],
  ['water_settings', 'created_at_mtn', CREATED_MTN],
  ['water_settings', 'created_at_utc', CREATED_UTC],
  ['water_reception', 'purpose', purpose_def(SHORT.water_reception, 'minute_utc')],
  ['water_reception', 'odometer', "DECIMAL(14,2) NULL COMMENT 'meter reading at the end of this minute -- the heartbeat line'"],
  ['water_reception', 'created_at_mtn', CREATED_MTN],
  ['water_reception', 'created_at_utc', CREATED_UTC],
  ['water_raw_samples', 'seen_at_mtn', 'DATETIME NULL'],
  ['water_raw_samples', 'created_at_mtn', CREATED_MTN],
  ['water_raw_samples', 'created_at_utc', CREATED_UTC],
];

// Kept for the tests and for anything that just wants the CREATE statements.
const STATEMENTS = TABLES.map(function (t) { return t.ddl; });

// MySQL truncates a table comment past 2048 bytes, which would make the drift check below think it
// had changed and rewrite it on every single boot. Keep them under, and fail loudly here rather
// than churn silently there.
const MAX_COMMENT = 2000;

/** The set of column names that currently exist on `table` (empty if the table does not). */
async function existing_columns(pool, table) {
  const [rows] = await pool.query(
    'SELECT column_name AS c FROM information_schema.columns ' +
    'WHERE table_schema = DATABASE() AND table_name = ?',
    [table]
  );
  const set = new Set();
  rows.forEach(function (r) { set.add(String(r.c).toLowerCase()); });
  return set;
}

async function add_missing_columns(pool) {
  const by_table = new Map();
  ADDED_COLUMNS.forEach(function (row) {
    if (!by_table.has(row[0])) by_table.set(row[0], []);
    by_table.get(row[0]).push(row);
  });

  const added = [];
  for (const [table, cols] of by_table) {
    const have = await existing_columns(pool, table);
    if (!have.size) continue;                       // table not there yet — the CREATE handles it
    for (const col of cols) {
      const name = col[1];
      if (have.has(name.toLowerCase())) continue;
      await pool.query('ALTER TABLE `' + table + '` ADD COLUMN `' + name + '` ' + col[2]);
      added.push(table + '.' + name);
    }
  }
  return added;
}

async function sync_table_comments(pool) {
  const [rows] = await pool.query(
    'SELECT table_name AS t, table_comment AS c FROM information_schema.tables ' +
    "WHERE table_schema = DATABASE() AND table_name LIKE 'water\\_%'"
  );
  const current = new Map();
  rows.forEach(function (r) { current.set(String(r.t), String(r.c || '')); });

  const changed = [];
  for (const t of TABLES) {
    if (t.purpose.length > MAX_COMMENT) {
      throw new Error('table comment for ' + t.name + ' is ' + t.purpose.length + ' chars; MySQL ' +
        'truncates past ' + MAX_COMMENT + ', which would rewrite it on every boot');
    }
    if (!current.has(t.name)) continue;
    if (current.get(t.name) === t.purpose) continue;   // already correct — no metadata write
    await pool.query('ALTER TABLE `' + t.name + '` COMMENT = ?', [t.purpose]);
    changed.push(t.name);
  }
  return changed;
}

/**
 * Keep the `purpose` column honest after its text is edited.
 *
 * ADD COLUMN only fires once. Change SHORT afterwards and, without this, the DEFAULT still says the
 * old thing and every existing row still holds the old thing — a self-documenting column that
 * documents something that is no longer true is worse than no column at all.
 *
 * Both steps are conditional on the text having actually changed, so the normal boot does nothing.
 */
async function sync_purpose_column(pool) {
  const [rows] = await pool.query(
    'SELECT table_name AS t, column_default AS d FROM information_schema.columns ' +
    "WHERE table_schema = DATABASE() AND column_name = 'purpose' AND table_name LIKE 'water\\_%'"
  );
  const current = new Map();
  rows.forEach(function (r) {
    // MySQL 5.7/MariaDB quote string defaults in information_schema; MySQL 8 does not.
    let d = r.d === null || r.d === undefined ? '' : String(r.d);
    if (d.length >= 2 && d.charAt(0) === "'" && d.charAt(d.length - 1) === "'") {
      d = d.slice(1, -1).replace(/''/g, "'").replace(/\\'/g, "'");
    }
    current.set(String(r.t), d);
  });

  const changed = [];
  for (const t of TABLES) {
    if (!current.has(t.name)) continue;                 // column not there yet — ADD COLUMN handles it
    if (current.get(t.name) === t.short) continue;      // already correct
    await pool.query('ALTER TABLE `' + t.name + '` MODIFY COLUMN `purpose` ' +
      purpose_def(t.short, t.purpose_after));
    // Backfill: rows written under the old text would otherwise keep contradicting the new one.
    await pool.query('UPDATE `' + t.name + '` SET `purpose` = ? WHERE `purpose` <> ?', [t.short, t.short]);
    changed.push(t.name);
  }
  return changed;
}

/**
 * Backfill the wall-clock pairs on rows that predate the columns.
 *
 * Two passes, and the second is the one that matters:
 *
 *   1. Copy from the row's own event column where one exists (read_at_utc -> created_at_utc, etc).
 *   2. Derive any *_mtn still NULL from its *_utc partner, through time.js. This is what covers the
 *      cases pass 1 cannot: water_collector_state has no local column at all, and a table whose
 *      source *_mtn was itself NULL would otherwise just propagate the NULL.
 *
 * Why the app does this rather than a hand-run SQL script: the UPSERT tables never revisit
 * created_at once the row exists — that is the point of "created" — so water_collector_state's
 * single row and every water_settings row would keep their NULLs *forever*, not just until the next
 * write. A migration that only half-lands is the kind of thing you discover a year later.
 *
 * Pass 2 groups by distinct timestamp instead of walking primary keys: the local offset depends on
 * the instant (DST), but rows sharing an instant share an offset, and the distinct count is tiny.
 */
const BACKFILL = [
  // [table, utc column, mtn column, SQL expression for the utc source (null = no source)]
  ['water_readings', 'created_at_utc', 'created_at_mtn', 'read_at_utc', 'read_at_mtn'],
  ['water_hourly', 'created_at_utc', 'created_at_mtn', 'updated_at_utc', 'hour_start_mtn'],
  ['water_hourly', 'updated_at_utc', 'updated_at_mtn', null, null],
  ['water_alerts', 'created_at_utc', 'created_at_mtn', 'fired_at_utc', 'fired_at_mtn'],
  ['water_collector_state', 'created_at_utc', 'created_at_mtn', 'COALESCE(started_at_utc, last_heartbeat_utc)', null],
  ['water_settings', 'created_at_utc', 'created_at_mtn', 'updated_at_utc', 'updated_at_mtn'],
  ['water_settings', 'updated_at_utc', 'updated_at_mtn', null, null],
  ['water_packets', 'created_at_utc', 'created_at_mtn', 'heard_at_utc', 'heard_at_mtn'],
  ['water_raw_samples', 'created_at_utc', 'created_at_mtn', 'seen_at_utc', 'seen_at_mtn'],
  ['water_raw_samples', 'seen_at_utc', 'seen_at_mtn', null, null],
];

async function backfill_timestamps(pool) {
  const time = require('../time');
  const filled = [];

  for (const [table, utc_col, mtn_col, utc_src, mtn_src] of BACKFILL) {
    // Pass 1 — copy from the event columns, when there are any to copy from.
    if (utc_src) {
      const sets = ['`' + utc_col + '` = ' + utc_src];
      if (mtn_src) sets.push('`' + mtn_col + '` = ' + mtn_src);
      const [r] = await pool.query(
        'UPDATE `' + table + '` SET ' + sets.join(', ') + ' WHERE `' + utc_col + '` IS NULL AND ' + utc_src + ' IS NOT NULL'
      );
      if (r.affectedRows) filled.push(table + '.' + utc_col + ' x' + r.affectedRows);
    }

    // Pass 2 — derive the local stamp from the UTC one for anything still missing it.
    const [gaps] = await pool.query(
      'SELECT DISTINCT `' + utc_col + '` AS u FROM `' + table + '` ' +
      'WHERE `' + mtn_col + '` IS NULL AND `' + utc_col + '` IS NOT NULL LIMIT 500'
    );
    let n = 0;
    for (const g of gaps) {
      const local = time.sql_local(new Date(String(g.u).replace(' ', 'T') + 'Z'));
      const [r] = await pool.query(
        'UPDATE `' + table + '` SET `' + mtn_col + '` = ? WHERE `' + utc_col + '` = ? AND `' + mtn_col + '` IS NULL',
        [local, g.u]
      );
      n += r.affectedRows || 0;
    }
    if (n) filled.push(table + '.' + mtn_col + ' x' + n);
  }
  return filled;
}

let _ready = null;

async function ensure_schema(db) {
  if (_ready) return _ready;
  _ready = (async function () {
    const pool = await db.get_pool();
    for (const t of TABLES) await pool.query(t.ddl);
    const added = await add_missing_columns(pool);
    if (added.length) console.log('[schema] added column(s): ' + added.join(', '));
    const repurposed = await sync_purpose_column(pool);
    if (repurposed.length) console.log('[schema] updated purpose column on: ' + repurposed.join(', '));
    const commented = await sync_table_comments(pool);
    if (commented.length) console.log('[schema] set table purpose on: ' + commented.join(', '));
    const filled = await backfill_timestamps(pool);
    if (filled.length) console.log('[schema] backfilled: ' + filled.join(', '));
    return true;
  })();
  return _ready;
}

// Test/CLI hook — forget the memoized promise (e.g. after switching databases).
function _reset() { _ready = null; }

module.exports = { ensure_schema, STATEMENTS, TABLES, ADDED_COLUMNS, _reset };
