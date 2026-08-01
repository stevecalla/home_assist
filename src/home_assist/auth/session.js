'use strict';
// Signed-cookie sessions (HMAC-SHA256 over a small JSON payload). No external session library.
// Ported from src/usat_apps/auth/session.js; own cookie name so home_assist keeps an independent login.
//
// Rolling / sliding expiry: `ts` in the payload is the LAST-ACTIVITY time, not the login time. The
// auth middleware calls refresh() on every authenticated request, which re-issues the cookie (with a
// fresh ts) once the token is older than REFRESH_AFTER_MS. So an actively-used session never expires,
// and an idle session expires MAX_AGE_MS after the last request — "stay logged in while active,
// redirect to login once the session goes idle."
const crypto = require('crypto');
const COOKIE = 'home_assist_session';
const MAX_AGE_MS = 48 * 60 * 60 * 1000;      // idle timeout: expire this long after the LAST request
const REFRESH_AFTER_MS = 5 * 60 * 1000;      // re-issue the cookie at most once per 5 min of activity

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + mac;
}

function verify(token, secret) {
  if (!token || token.indexOf('.') < 0) return null;
  const i = token.indexOf('.'); const body = token.slice(0, i); const mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (mac.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!p || !p.ts || (Date.now() - p.ts) > MAX_AGE_MS) return null;   // idle window measured from ts
  return p;
}

function parse_cookies(header) {
  const out = {};
  String(header || '').split(';').forEach(function (p) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// Build the Set-Cookie value for a session token (shared by login + rolling refresh so the cookie
// attributes never drift between the two paths).
function cookie_string(token) {
  return COOKIE + '=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + Math.floor(MAX_AGE_MS / 1000);
}

// Issue a fresh session cookie (login or rolling refresh). ts = now.
function issue(res, user, role, secret) {
  const token = sign({ user: user, role: role || 'user', ts: Date.now() }, secret);
  res.setHeader('Set-Cookie', cookie_string(token));
  return token;
}

// Clear the session cookie (logout).
function clear(res) {
  res.setHeader('Set-Cookie', COOKIE + '=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

// Rolling refresh: slide the expiry forward on an authenticated request so an active user never
// times out. Only re-issues once the token is older than REFRESH_AFTER_MS, to avoid a Set-Cookie on
// every single request (e.g. the water panel's 5s status poll). No-op if the response already set a
// cookie (login/logout own the cookie on their routes).
function refresh(res, p, secret) {
  if (!p || !p.ts) return;
  if (Date.now() - p.ts < REFRESH_AFTER_MS) return;
  if (res.getHeader && res.getHeader('Set-Cookie')) return;
  issue(res, p.user, p.role || 'user', secret);
}

module.exports = { COOKIE, MAX_AGE_MS, REFRESH_AFTER_MS, sign, verify, parse_cookies, cookie_string, issue, clear, refresh };
