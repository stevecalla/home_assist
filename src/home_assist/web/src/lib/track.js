// track.js — usage-analytics seam, deliberately a no-op in v1.
//
// usat_apps has a full metrics stack (usat_apps_events + a report + ask-your-data). home_assist is
// a house dashboard with one user, so building that would be ~1500 lines serving nobody.
//
// The seam stays here rather than being deleted, for two reasons: the shell components ported from
// usat_apps call these functions, and if a metrics module ever lands, it wires in HERE — one file,
// no changes anywhere else. Every function is safe to call and returns nothing.
//
// To turn it on later: POST to /api/event and add a metrics module to modules/registry.js.

const ENABLED = false;

export function track(event_name, payload) {
  if (!ENABLED) return;
  try {
    fetch('/api/event', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ event_name }, payload || {})),
    }).catch(() => {});
  } catch (e) { /* analytics must never break the app */ }
}

export function trackPanelView(pathname, panel) { track('panel_view', { view: pathname, panel }); }
export function trackSession(kind) { track('session', { view: kind }); }
export function trackNotFound(pathname) { track('not_found', { view: pathname }); }
export function trackNotAuthorized(panel, pathname) { track('not_authorized', { panel, view: pathname }); }
