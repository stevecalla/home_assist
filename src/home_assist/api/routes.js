'use strict';
// JSON API for the home_assist platform. Platform-level routes (auth, current user, admin/access)
// live here; feature routes are mounted by each module via the registry.
//   GET  /api/status              public health check
//   POST /api/login               { username, password } -> sets signed-cookie session
//   POST /api/logout              clears the session
//   GET  /api/me                  current user + role + panels (401 if not signed in)
//   GET  /api/modules             signed-in; the module catalog the front-end builds its nav from
//   GET/POST /api/admin/*         admin; users + panel access
//   (module routes: /api/<id>/*   mounted by modules/registry.mount_all)
const session = require('../auth/session');
const store = require('../auth/auth_store');
const panel_access = require('../access/panel_access');
const { require_auth, require_admin } = require('../auth/require_auth');
const registry = require('../modules/registry');
const db = require('../store/db');

module.exports = function mount(app) {
  app.get('/api/status', function (req, res) {
    res.json({
      ok: true,
      app: 'home_assist',
      login_configured: store.login_configured(),
      time: new Date().toISOString(),
    });
  });

  // Deeper health check — includes MySQL reachability. Separate from /api/status so the cheap
  // liveness probe never opens a DB connection.
  app.get('/api/health', async function (req, res) {
    const dbState = await db.ping();
    res.status(dbState.ok ? 200 : 503).json({ ok: dbState.ok, app: 'home_assist', db: dbState });
  });

  app.post('/api/login', function (req, res) {
    const body = req.body || {};
    const v = store.valid_user(body.username, body.password);
    if (!v) return res.status(401).json({ ok: false, error: 'invalid credentials' });
    session.issue(res, v.user, v.role, store.session_secret());
    res.json({ ok: true, user: v.user, role: v.role, panels: panel_access.effective_panels(v.user, v.role) });
  });

  app.post('/api/logout', function (req, res) {
    session.clear(res);
    res.json({ ok: true });
  });

  app.get('/api/me', function (req, res) {
    const cookies = session.parse_cookies(req.headers.cookie);
    const p = session.verify(cookies[session.COOKIE], store.session_secret());
    if (!p) return res.status(401).json({ ok: false });
    const role = p.role || 'user';
    res.json({ ok: true, user: p.user, role: role, panels: panel_access.effective_panels(p.user, role) });
  });

  // The module catalog for the signed-in user: every module + the panels they can see. The front-end
  // builds its nav from this, so adding a module surfaces it automatically.
  app.get('/api/modules', require_auth, function (req, res) {
    const allowed = panel_access.effective_panels(req.user, req.role);
    const mods = registry.list().map(function (m) {
      return {
        id: m.id,
        label: m.label,
        group: m.group || m.label,
        panels: (m.panels || []).map(function (p) { return { key: p.key, label: p.label }; }),
        // visible if admin or the user has at least one of the module's panels
        visible: req.role === 'admin' || (m.panels || []).some(function (p) { return allowed.indexOf(p.key) >= 0; }),
      };
    });
    res.json({ ok: true, modules: mods, role: req.role });
  });

  // ---- Admin: user management + panel access (admin-gated) ----
  app.get('/api/admin/users', require_admin, function (req, res) {
    try {
      const env = store.env_accounts().map(function (u) { return { user: u.user, role: u.role, source: 'env', removable: false }; });
      const stored = store.list_users().map(function (u) { return { user: u.user, role: u.role || 'user', source: 'stored', removable: true }; });
      res.json({ ok: true, users: env.concat(stored) });
    } catch (e) { res.status(500).json({ ok: false, error: (e && e.message) || String(e) }); }
  });

  app.post('/api/admin/users', require_admin, function (req, res) {
    try {
      const b = req.body || {};
      const user = String(b.user || '').trim();
      const pass = String(b.pass || '');
      if (!user) return res.status(400).json({ ok: false, error: 'username required' });
      if (pass.length < 4) return res.status(400).json({ ok: false, error: 'password must be at least 4 characters' });
      const role = b.role === 'admin' ? 'admin' : 'user';
      const r = store.add_user(user, pass, role);
      res.json({ ok: true, user: r.user, role: r.role });
    } catch (e) { res.status(400).json({ ok: false, error: (e && e.message) || String(e) }); }
  });

  app.post('/api/admin/users/remove', require_admin, function (req, res) {
    try {
      const user = String((req.body && req.body.user) || '').trim();
      if (!user) return res.status(400).json({ ok: false, error: 'username required' });
      if (store.env_accounts().some(function (u) { return u.user === user; })) {
        return res.status(400).json({ ok: false, error: 'cannot remove a .env recovery account' });
      }
      const removed = store.remove_user(user);
      try { panel_access.clear_user(user); } catch (e) { /* drop any orphaned override */ }
      res.json({ ok: removed, error: removed ? null : 'no such user' });
    } catch (e) { res.status(400).json({ ok: false, error: (e && e.message) || String(e) }); }
  });

  app.get('/api/admin/panel-access', require_admin, function (req, res) {
    try {
      const users = store.env_accounts().map(function (u) { return u.user; })
        .concat(store.list_users().map(function (u) { return u.user; }));
      res.json({ ok: true, panels: panel_access.catalog(), access: panel_access.get(), users: users });
    } catch (e) { res.status(500).json({ ok: false, error: (e && e.message) || String(e) }); }
  });

  app.post('/api/admin/panel-access', require_admin, function (req, res) {
    try {
      const b = req.body || {};
      if (b.default !== undefined) panel_access.set_default(b.default);
      if (b.user && b.clear) panel_access.clear_user(b.user);
      else if (b.user && b.panels !== undefined) panel_access.set_user(b.user, b.panels);
      res.json({ ok: true, access: panel_access.get() });
    } catch (e) { res.status(400).json({ ok: false, error: (e && e.message) || String(e) }); }
  });

  // ---- Feature modules mount their own /api/<id>/* routes ----
  registry.mount_all(app);
};
