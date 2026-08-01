// Tiny fetch helper for the home_assist platform API. All calls are same-origin (the Express server
// serves this SPA and the /api/* routes), so cookies ride along. Base-aware via
// import.meta.env.BASE_URL, so it works at '/' or any sub-path if built with a different --base.
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
const url = (p) => BASE + p;

// Central auth-expiry signal: when any DATA call returns 401 (session expired / missing), tell the
// app to show the login screen. 403 (panel access denied) is intentionally NOT handled here — those
// stay in-app and render the access-denied view. login/me/logout are exempt so a signed-out user
// landing on the app doesn't loop.
const AUTH_PATHS = ['/api/login', '/api/me', '/api/logout'];
function noteStatus(path, status) {
  if (status === 401 && !AUTH_PATHS.some((a) => String(path).indexOf(a) === 0)) {
    try { window.dispatchEvent(new CustomEvent('home_assist:unauthorized')); } catch (e) { /* non-browser */ }
  }
}

async function jget(path) {
  const r = await fetch(url(path), { credentials: 'same-origin' });
  const body = await r.json().catch(() => ({}));
  noteStatus(path, r.status);
  return { status: r.status, body };
}

async function jpost(path, data) {
  const r = await fetch(url(path), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data || {}),
  });
  const body = await r.json().catch(() => ({}));
  noteStatus(path, r.status);
  return { status: r.status, body };
}

export const api = {
  // platform
  status: () => jget('/api/status'),
  health: () => jget('/api/health'),
  me: () => jget('/api/me'),
  login: (username, password) => jpost('/api/login', { username, password }),
  logout: () => jpost('/api/logout', {}),
  modules: () => jget('/api/modules'),

  // admin
  adminUsers: () => jget('/api/admin/users'),
  adminAddUser: (user, pass, role) => jpost('/api/admin/users', { user, pass, role }),
  adminRemoveUser: (user) => jpost('/api/admin/users/remove', { user }),
  adminPanelAccess: () => jget('/api/admin/panel-access'),
  adminSetPanelAccess: (body) => jpost('/api/admin/panel-access', body),

  // water module — /api/water/*
  waterStatus: () => jget('/api/water/status'),
  waterHourly: (hours) => jget('/api/water/hourly?hours=' + (hours || 48)),
  waterDaily: (days) => jget('/api/water/daily?days=' + (days || 30)),
  waterReadings: (limit) => jget('/api/water/readings?limit=' + (limit || 25)),
  waterAlerts: (limit) => jget('/api/water/alerts?limit=' + (limit || 50)),
  waterSettings: () => jget('/api/water/settings'),
  waterSaveSettings: (patch) => jpost('/api/water/settings', patch),
  waterTestAlert: () => jpost('/api/water/test-alert', {}),
  waterEmailCheck: () => jget('/api/water/email-check'),
  waterRaw: (limit) => jget('/api/water/raw?limit=' + (limit || 20)),
  waterReference: () => jget('/api/water/reference'),
  waterReception: (minutes) => jget('/api/water/reception?minutes=' + (minutes || 60)),
};
