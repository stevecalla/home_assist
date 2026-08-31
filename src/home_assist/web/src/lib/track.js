// track.js — usage analytics, browser side.
//
// This was a no-op seam for the whole of v1, with a comment saying "to turn it on later: POST to
// /api/event and add a metrics module". That is exactly what happened, and nothing outside this
// file changed: every call site (App.jsx, NotFound.jsx, NotAuthorized.jsx) already called these
// functions. The seam did its job.
//
// Condensed from usat_apps' utilities/analytics/metrics_client.js. Dropped: the upload_id and
// file_name plumbing (no uploads here) and the cookie mirror of the visitor id (one browser, one
// house — localStorage alone is enough, and one fewer cookie is one fewer thing to explain).
//
// THREE RULES:
//   1. Never throw, never block, never retry. sendBeacon is fire-and-forget by design: the browser
//      queues it and it survives the page being closed, which is exactly when the last event of a
//      session is worth having.
//   2. Send counts and enums, never values. No query text, no meter readings, no addresses. The
//      server's column whitelist is the real boundary, but sending less is better than filtering
//      more.
//   3. Honour Do-Not-Track and skip automation. A headless browser's clicks are not usage.

const ENDPOINT = '/api/event';

// One sitting. sessionStorage so it survives navigation and refresh inside a tab, but a new tab or
// a new login starts a new one -- which is what "a session" means to the person reading the report.
const SESSION_KEY = 'ha_session_id';
// The browser, across time. NOT a person: it is a random string in localStorage, and clearing site
// data mints a new one. It exists to tell "one person opened this eleven times" from "eleven
// people opened it once", which is a real difference even in a house with two phones.
const VISITOR_KEY = 'ha_visitor_id';

let ids = null;
let base = {};

function uuid() {
  try {
    if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  } catch (e) { /* fall through */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Every storage access is wrapped: Safari private mode throws on write, and an analytics helper
// that throws inside a render is a blank page.
function ls(k, v) {
  try {
    if (v === undefined) return window.localStorage.getItem(k);
    window.localStorage.setItem(k, v); return v;
  } catch (e) { return null; }
}
function ss(k, v) {
  try {
    if (v === undefined) return window.sessionStorage.getItem(k);
    window.sessionStorage.setItem(k, v); return v;
  } catch (e) { return null; }
}

function dnt() {
  try {
    const v = navigator.doNotTrack || window.doNotTrack;
    return v === '1' || v === 'yes';
  } catch (e) { return false; }
}
function automated() {
  try { return !!navigator.webdriver; } catch (e) { return false; }
}
// A single global switch, for a page that wants to opt out of instrumenting itself.
function off() {
  try { return !!window.METRICS_OFF || dnt() || automated(); } catch (e) { return true; }
}

// ?metrics_test=1 in the URL marks the whole sitting. Read once and remembered for the session, so
// clicking away from the flagged URL does not silently start writing real rows mid-experiment.
function is_test() {
  const held = ss('ha_metrics_test');
  if (held !== null) return held === '1';
  let flag = '0';
  try {
    if (new URLSearchParams(window.location.search).get('metrics_test') === '1') flag = '1';
  } catch (e) { /* no URL */ }
  ss('ha_metrics_test', flag);
  return flag === '1';
}

function ensure() {
  if (ids) return ids;
  let visitor = ls(VISITOR_KEY);
  const returning = visitor ? 1 : 0;
  if (!visitor) visitor = ls(VISITOR_KEY, uuid());
  let session = ss(SESSION_KEY);
  if (!session) session = ss(SESSION_KEY, uuid());
  ids = { visitor_id: visitor, session_id: session, is_returning: returning };
  return ids;
}

function two(n) { return (n < 10 ? '0' : '') + n; }

function env() {
  const d = new Date();
  let tz = null;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* old browser */ }
  return {
    client_tz: tz,
    local_hour: d.getHours(),
    local_dow: d.getDay(),
    // The BROWSER's clock, which is not necessarily the house's. Kept as its own field rather than
    // reconciled: "opened from another timezone" is information, and the authoritative stamps are
    // created_at_utc / created_at_mtn, written on the server.
    event_at_local: d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' +
      two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()),
    // A bucket, never a pixel size. Which layout was in use is the useful fact; the exact width
    // narrows down a device, and this is a table somebody's neighbour appears in.
    viewport: typeof window !== 'undefined' && window.innerWidth < 768 ? 'mobile' : 'desktop',
    theme: (document.documentElement.getAttribute('data-theme')) || 'auto',
    page_path: String(window.location.pathname || '').slice(0, 255),
  };
}

/**
 * Props merged into every subsequent event. App.jsx calls this once the session is known, so events
 * after sign-in carry the app version — the actor and role are stamped by the SERVER and are never
 * sent from here.
 */
export function setBaseProps(props) { base = props || {}; }

/** A fresh session id. Called on sign-in, so each login is its own sitting inside one tab. */
export function newSession() {
  const s = uuid();
  ss(SESSION_KEY, s);
  if (ids) ids.session_id = s;
  return s;
}

export function track(event_name, payload) {
  if (off()) return;
  try {
    const id = ensure();
    const body = JSON.stringify(Object.assign(
      { event_name },
      env(),
      { visitor_id: id.visitor_id, session_id: id.session_id, is_returning: id.is_returning },
      base,
      payload || {},
      is_test() ? { is_test: 1 } : {}
    ));
    // sendBeacon first: it does not block the page, it is not cancelled by navigation, and it is
    // the only way the last event before a tab closes gets recorded. fetch with keepalive is the
    // fallback for browsers without it.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch(ENDPOINT, {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json' }, body: body,
    }).catch(() => {});
  } catch (e) { /* analytics must never break the app */ }
}

export function trackPanelView(pathname, panel) { track('panel_view', { view: pathname, panel }); }
export function trackSession(kind) { track(kind === 'login' ? 'login' : kind === 'logout' ? 'logout' : 'page_view', {}); }
export function trackNotFound(pathname) { track('not_found', { view: pathname }); }
export function trackNotAuthorized(panel, pathname) { track('not_authorized', { panel, view: pathname }); }
/** An error worth keeping. `type` is an enum you choose; `message` is truncated by the column. */
export function trackError(type, message, extra) {
  track('error', Object.assign({ error_type: String(type || 'error').slice(0, 64),
    error_msg: String(message || '').slice(0, 500) }, extra || {}));
}
