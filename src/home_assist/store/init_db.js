#!/usr/bin/env node
'use strict';
/**
 * init_db.js — create the home_assist database (if missing) and all its tables, then exit.
 *
 *   npm run db_init
 *
 * The server and collector both call ensure_schema() at startup, so this is only needed once on a
 * fresh machine — chiefly to CREATE DATABASE, which ensure_schema deliberately does not do (the
 * app's pool is already bound to a database).
 */
require('../env');

const mysql = require('mysql2/promise');
const db = require('./db');
const schema = require('./schema');

async function main() {
  const cfg = db.config();
  const name = cfg.database;

  // Connect WITHOUT a database to create it.
  const admin = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
  });
  await admin.query('CREATE DATABASE IF NOT EXISTS `' + name.replace(/`/g, '') + '` CHARACTER SET utf8mb4');
  await admin.end();
  console.log('database ok: ' + name + ' @ ' + cfg.host + ':' + cfg.port);

  await schema.ensure_schema(db);
  const rows = await db.query('SHOW TABLES');
  console.log('tables:');
  rows.forEach(function (r) { console.log('  ' + Object.values(r)[0]); });

  await db.end();
  console.log('\ndone.');
}

main().catch(function (e) {
  console.error('db_init failed: ' + e.message);
  if (e.code === 'ER_ACCESS_DENIED_ERROR') console.error('Check MYSQL_USER / MYSQL_PASSWORD in .env');
  if (e.code === 'ECONNREFUSED') console.error('MySQL is not reachable at ' + db.config().host + ':' + db.config().port);
  process.exit(1);
});
