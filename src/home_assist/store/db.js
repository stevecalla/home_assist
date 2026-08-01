'use strict';
// MySQL access for home_assist. One lazily-created pool, config from .env (same MYSQL_* names as
// the wrestling_stats project). Ported in shape from src/usat_apps/store/db.js.
const mysql = require('mysql2/promise');

let pool = null;

function config() {
  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'home_assist',
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT) || 8,
    waitForConnections: true,
    // DATETIME columns come back as strings, not JS Dates. We stamp both _utc and _mtn in Node and
    // want them back exactly as written — no driver-side timezone reinterpretation.
    dateStrings: true,
    charset: 'utf8mb4_general_ci',
  };
}

// The pool is created lazily (only on the first DB call) so requiring this module can never block
// server startup or the auth/login/status paths, which don't touch the database.
async function get_pool() {
  if (pool) return pool;
  pool = mysql.createPool(config());
  return pool;
}

async function query(sql, params) {
  const p = await get_pool();
  const [rows] = await p.query(sql, params || []);
  return rows;
}

async function end() {
  if (!pool) return;
  const p = pool; pool = null;
  try { await p.end(); } catch (e) { /* already closing/closed */ }
}

// Is MySQL reachable? Used by /api/status and the collector's preflight so a bad password shows up
// as a clear message instead of a stack trace on the first real query.
async function ping() {
  try { await query('SELECT 1 AS ok'); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { get_pool, query, end, ping, config };
