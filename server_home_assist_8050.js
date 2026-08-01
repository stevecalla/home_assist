#!/usr/bin/env node
/**
 * server_home_assist_8050.js — web host for the home_assist platform shell.
 *
 * Mirrors server_usat_apps_8022.js:
 *   - create_app() builds the Express app (cors, no-cache, JSON API, serves the built React SPA)
 *   - start_server() listens with NO host arg -> dual-stack '::' (IPv6 + IPv4), so the dashboard is
 *     reachable from your phone on the LAN.
 *
 * This process is READ-ONLY with respect to the meter: it serves the UI and queries MySQL. The
 * rtl_433 radio, the leak rules, and the alert emails all live in collector_water.js, a SEPARATE
 * process. That separation is deliberate — rebuilding or crashing the web layer must never stop
 * leak detection.
 *
 * Usage:
 *   node server_home_assist_8050.js                # default port 8050 (HOMEASSIST_PORT overrides)
 *   (build the React app first: npm run home_assist_build)
 *
 * Importable: tests can call create_app() and listen on port 0.
 */
'use strict';

// Repo-root .env regardless of cwd (MYSQL_*, HOMEASSIST_* creds, WATER_*, EMAIL_*).
require('./src/home_assist/env');
const path = require('path');
const fs = require('fs');

const express = require('express');
const cors = require('cors');
const mount = require('./src/home_assist/api/routes');
const store = require('./src/home_assist/auth/auth_store');

const DEFAULT_PORT = Number(process.env.HOMEASSIST_PORT) || 8050;
const WEB_DIST = process.env.HOMEASSIST_WEB_DIST || path.join(__dirname, 'src', 'home_assist', 'web', 'dist');

function create_app() {
  const app = express();
  app.use(cors());

  // No-cache so SPA edits show on reload.
  app.use(function (req, res, next) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    next();
  });

  // One log line per call — but NOT for the water panel's 5s status poll, which would otherwise
  // bury everything else in the pm2 log.
  app.use(function (req, res, next) {
    if (req.path !== '/api/water/status') {
      const ts = new Date().toISOString();
      console.log('[' + ts + '] ' + req.method + ' ' + req.originalUrl + '  host=' + (req.headers.host || '?'));
    }
    next();
  });

  // JSON API (status/login/logout public; the rest auth-gated).
  app.use(express.json({ limit: '2mb' }));
  mount(app);

  // Serve the built React app (static) with a SPA fallback for client-side routes.
  if (fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get(/^\/(?!api\/).*/, function (req, res) {
      res.sendFile(path.join(WEB_DIST, 'index.html'));
    });
  } else {
    app.get('/', function (req, res) {
      res.type('html').send(
        '<h1>home_assist</h1>' +
        '<p>The React app is not built yet. Run:</p>' +
        '<pre>npm run home_assist_build</pre>' +
        '<p>The JSON API is live now — try <a href="/api/status">/api/status</a>.</p>'
      );
    });
  }

  return app;
}

function start_server(port) {
  const p = port || DEFAULT_PORT;
  const app = create_app();
  // No host arg -> dual-stack bind (IPv6 + IPv4) so other devices on the LAN can reach it.
  const server = app.listen(p, function () {
    const actual = server.address().port;
    console.log('\nhome_assist — platform server');
    console.log('  -> http://localhost:' + actual + '/                 (web app)');
    console.log('  -> http://localhost:' + actual + '/api/status       (liveness)');
    console.log('  -> http://localhost:' + actual + '/api/health       (liveness + MySQL)');
    console.log('  login configured: ' + store.login_configured());
    if (!store.login_configured()) {
      console.log('  WARNING: no login configured — set HOMEASSIST_ADMIN_USER + HOMEASSIST_ADMIN_PASS in .env');
    }
    if (!fs.existsSync(WEB_DIST)) console.log('  NOTE: React app not built yet — run `npm run home_assist_build`.');
    console.log('  Reminder: the radio + alerts run in collector_water.js, not here.');
    console.log('  Press Ctrl-C to stop.\n');
    // Warm module caches so the first request already has live data. AFTER listen, never in create_app.
    try { require('./src/home_assist/modules/registry').warm_all(); }
    catch (e) { console.warn('  [warm] module warm-up skipped: ' + e.message); }
  });
  server.on('error', function (e) {
    if (e && e.code === 'EADDRINUSE') console.error('PORT ' + p + ' is already in use — stop the other process or set HOMEASSIST_PORT.');
    else console.error(e);
  });
  return server;
}

// Graceful shutdown so Ctrl-C and `pm2 stop` exit cleanly even with an open DB pool.
async function cleanup() {
  console.log('\nGracefully shutting down...');
  try { await require('./src/home_assist/store/db').end(); } catch (e) { /* ignore */ }
  process.exit();
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

if (require.main === module) start_server();

module.exports = { create_app, start_server };
