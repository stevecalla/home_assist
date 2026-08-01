'use strict';
/**
 * schema.test.js — the shape rules, checkable without a database.
 *
 * These exist because the two ways this file goes wrong are both silent:
 *
 *   1. A column added to a CREATE TABLE but not to ADDED_COLUMNS works perfectly on a fresh
 *      machine and does nothing at all on one that has already run the app — because
 *      CREATE TABLE IF NOT EXISTS is a no-op there. You find out when a write fails at 2am.
 *   2. A table added without a `purpose` leaves someone reading the database a year from now
 *      with no idea what it is for, and nothing ever fails to tell them.
 */
const test = require('node:test');
const assert = require('node:assert');

const schema = require('../store/schema');

const TIMESTAMP_COLUMNS = ['created_at_mtn', 'created_at_utc'];

test('every table declares a purpose, and it is a real sentence', function () {
  for (const t of schema.TABLES) {
    assert.ok(t.purpose, t.name + ' has no purpose — say what the table is FOR');
    assert.ok(t.purpose.length >= 60, t.name + ': purpose is too short to be useful');
    // MySQL truncates past 2048 bytes, which would make the drift check rewrite it every boot.
    assert.ok(t.purpose.length <= 2000, t.name + ': purpose will be truncated by MySQL');
    assert.match(t.purpose, /\.$/, t.name + ': purpose should read as prose and end with a period');
  }
});

test('table purposes are ASCII — they get read by tools we do not control', function () {
  // Workbench, mysqldump, ERD exporters and CSV pipelines all handle charset differently. The
  // comment is stored as utf8mb4 correctly, but it is rendered by whatever the reader is using,
  // and a mojibake'd em dash in a schema export is a bad first impression of the schema.
  for (const t of schema.TABLES) {
    const bad = t.purpose.match(/[^\x20-\x7E]/g);
    assert.strictEqual(bad, null, t.name + ': non-ASCII in table comment -> ' + JSON.stringify(bad));
  }
});

test('every table carries created_at_mtn and created_at_utc', function () {
  for (const t of schema.TABLES) {
    for (const col of TIMESTAMP_COLUMNS) {
      assert.match(t.ddl, new RegExp('\\b' + col + '\\b'), t.name + ' is missing ' + col);
    }
  }
});

test('every column in a CREATE is also in ADDED_COLUMNS, or predates the migration', function () {
  // The whole point: a column that exists only in the CREATE never reaches an existing database.
  const migrated = new Set(schema.ADDED_COLUMNS.map(function (r) { return r[0] + '.' + r[1]; }));
  for (const t of schema.TABLES) {
    for (const col of TIMESTAMP_COLUMNS) {
      assert.ok(migrated.has(t.name + '.' + col),
        t.name + '.' + col + ' is in the CREATE but not in ADDED_COLUMNS — it will silently ' +
        'never appear on a machine that has already run the app');
    }
  }
});

test('ADDED_COLUMNS only references tables that exist, with a real definition', function () {
  const names = new Set(schema.TABLES.map(function (t) { return t.name; }));
  for (const row of schema.ADDED_COLUMNS) {
    assert.strictEqual(row.length, 3, 'ADDED_COLUMNS rows are [table, column, definition]');
    assert.ok(names.has(row[0]), 'ADDED_COLUMNS references unknown table ' + row[0]);
    assert.match(row[2], /^DATETIME|^VARCHAR|^INT|^BIGINT|^DECIMAL|^TINYINT|^TEXT|^JSON|^CHAR/,
      row[0] + '.' + row[1] + ': definition does not start with a type');
  }
});

test('ADDED_COLUMNS has no duplicates', function () {
  const seen = new Set();
  for (const row of schema.ADDED_COLUMNS) {
    const key = row[0] + '.' + row[1];
    assert.ok(!seen.has(key), 'duplicate migration entry: ' + key);
    seen.add(key);
  }
});

test('every table that has an updated_at_utc also has an updated_at_mtn', function () {
  // House rule: both wall clocks, always. A single-timezone timestamp is the thing that breaks
  // when the repo moves between the Windows laptop and the Ubuntu box.
  for (const t of schema.TABLES) {
    if (!/\bupdated_at_utc\b/.test(t.ddl)) continue;
    assert.match(t.ddl, /\bupdated_at_mtn\b/, t.name + ' has updated_at_utc but no updated_at_mtn');
  }
});

test('STATEMENTS still exposes one CREATE per table', function () {
  assert.strictEqual(schema.STATEMENTS.length, schema.TABLES.length);
  schema.STATEMENTS.forEach(function (s) { assert.match(s, /^CREATE TABLE IF NOT EXISTS/); });
});

test('every table has a one-line `purpose` column, anchored after a real column', function () {
  for (const t of schema.TABLES) {
    assert.ok(t.short, t.name + ' has no short purpose for the column');
    // It is stored on every row. water_readings is ~70k rows a year.
    assert.ok(t.short.length <= 400, t.name + ': short purpose exceeds VARCHAR(400)');
    assert.ok(t.short.length <= 200, t.name + ': keep the COLUMN text to one line — the long prose belongs in the table COMMENT');
    assert.strictEqual(t.short.indexOf("'"), -1, t.name + ': no single quotes — the text is inlined into DDL');
    assert.strictEqual(t.short.match(/[^\x20-\x7E]/g), null, t.name + ': purpose column text must be ASCII');
    assert.match(t.ddl, /\bpurpose VARCHAR\(400\) NOT NULL DEFAULT\b/, t.name + ': CREATE is missing the purpose column');
    assert.ok(t.ddl.includes("'" + t.short + "'"), t.name + ': CREATE default does not match SHORT');
    assert.match(t.ddl, new RegExp('\\b' + t.purpose_after + '\\b'), t.name + ': purpose_after names a column that is not in the CREATE');
  }
});

test('the purpose column is in ADDED_COLUMNS for every table', function () {
  // Same trap as the timestamps: present in the CREATE, absent from an existing database forever.
  const migrated = new Set(schema.ADDED_COLUMNS.map(function (r) { return r[0] + '.' + r[1]; }));
  for (const t of schema.TABLES) {
    assert.ok(migrated.has(t.name + '.purpose'), t.name + '.purpose is missing from ADDED_COLUMNS');
  }
});

test('the column purpose and the table purpose tell the same story', function () {
  // They are different lengths on purpose, but they must not contradict each other. A cheap proxy:
  // the first few significant words should overlap.
  for (const t of schema.TABLES) {
    const words = function (s) { return s.toLowerCase().match(/[a-z]{4,}/g).slice(0, 12); };
    const a = new Set(words(t.short));
    const overlap = words(t.purpose).filter(function (w) { return a.has(w); });
    assert.ok(overlap.length >= 3,
      t.name + ': the purpose COLUMN and the table COMMENT share almost no vocabulary — one of them is stale');
  }
});
