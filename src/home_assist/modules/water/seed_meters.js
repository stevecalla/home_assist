#!/usr/bin/env node
'use strict';
/**
 * seed_meters.js — put fake NEIGHBOUR meters in the dev registry.
 *
 * WHY THIS EXISTS. Meter access is about telling meters apart, and the laptop only ever hears one:
 * the radio lives on the Ubuntu box. So the one feature that cannot be exercised on dev is the one
 * most worth exercising before it reaches production — "restrict this user to that meter" has
 * nothing to restrict them to.
 *
 * WHY NOT SYNC PRODUCTION. Copying the real database over would work, and would also copy the
 * meter ids, volumes and timings of the houses around yours onto a laptop that travels. The grant
 * logic does not care whether a meter is real; it cares that there is more than one. Three obviously
 * fake rows answer the question without moving anyone's data anywhere.
 *
 * These rows are deliberately loud about being fake:
 *   • ids in the 999xxxxx range, which no Badger endpoint uses
 *   • names that start with "TEST —"
 *   • owned = 0, notify = 0, collect_readings = 0 — they can never be alerted on
 *
 * They carry no packets and no readings, so every chart for them is legitimately empty. That is
 * correct, not broken: it is what a meter you have been granted but have not heard looks like.
 *
 *   node src/home_assist/modules/water/seed_meters.js            add them
 *   node src/home_assist/modules/water/seed_meters.js --remove   take them away again
 *   node src/home_assist/modules/water/seed_meters.js --list     show what is in the registry
 */
require('../../env');
const db = require('../../store/db');
const time = require('../../time');

// Fixed ids, so --remove can delete exactly what --add created and nothing else.
const SEED = [
  { meter_id: 99900001, meter_name: 'TEST — neighbour east', model: 'Badger-ORION', packets_seen: 4120 },
  { meter_id: 99900002, meter_name: 'TEST — neighbour west', model: 'Badger-ORION', packets_seen: 1877 },
  { meter_id: 99900003, meter_name: 'TEST — across the street', model: 'Badger-ORION', packets_seen: 342 },
];
const SEED_IDS = SEED.map(function (s) { return s.meter_id; });

async function add() {
  const n = time.stamps(new Date());
  let added = 0;
  for (const s of SEED) {
    // INSERT IGNORE, not REPLACE: running this twice must not wipe a name you edited on the Meters
    // page while testing. Idempotent means "no further effect", not "back to how I left it".
    const r = await db.query(
      'INSERT IGNORE INTO water_meters ' +
      '(meter_id, meter_name, model, owned, collect_readings, notify, gallons_per_unit, ' +
      ' first_heard_utc, first_heard_mtn, last_heard_utc, last_heard_mtn, packets_seen) ' +
      'VALUES (?, ?, ?, 0, 0, 0, 1, ?, ?, ?, ?, ?)',
      [s.meter_id, s.meter_name, s.model, n.utc, n.mtn, n.utc, n.mtn, s.packets_seen]
    );
    if (r && r.affectedRows) added += 1;
  }
  console.log(added ? 'added ' + added + ' test meter(s)' : 'already present — nothing to do');
  await list();
}

async function remove() {
  // Scoped to the seed ids by name AND number. A bare DELETE on this table, run once on the wrong
  // machine, would take the real registry with it.
  const r = await db.query(
    'DELETE FROM water_meters WHERE meter_id IN (?, ?, ?) AND owned = 0',
    SEED_IDS
  );
  console.log('removed ' + ((r && r.affectedRows) || 0) + ' test meter(s)');
  await list();
}

async function list() {
  const rows = await db.query(
    'SELECT meter_id, meter_name, model, owned, packets_seen FROM water_meters ORDER BY owned DESC, meter_id'
  );
  if (!rows.length) { console.log('\nregistry is empty'); return; }
  console.log('\n  meter_id   owned  packets   name');
  rows.forEach(function (r) {
    console.log(
      '  ' + String(r.meter_id).padEnd(10) +
      ' ' + (Number(r.owned) ? 'mine ' : '  -  ') +
      ' ' + String(r.packets_seen).padStart(7) +
      '   ' + (r.meter_name || '')
    );
  });
}

async function main() {
  const arg = (process.argv[2] || '').toLowerCase();
  try {
    if (arg === '--remove' || arg === 'remove') await remove();
    else if (arg === '--list' || arg === 'list') await list();
    else await add();
  } catch (e) {
    console.error('seed_meters failed:', (e && e.message) || e);
    process.exitCode = 1;
  }
  try { await db.end(); } catch (e) { /* pool already closed */ }
}

main();
