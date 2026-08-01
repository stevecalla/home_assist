// Light/dark theming for the home_assist platform: a localStorage choice ('dark' | 'light' | absent =
// follow the OS), applied as data-theme on <html>. Mirrors the reporting/merge scheme.
const KEY = 'home_assist_theme';

function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }

export function effective_dark() {
  const t = stored();
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

export function apply_theme() {
  // Always write an explicit data-theme matching the effective choice, so the DOM never disagrees
  // with the toggle button. (The CSS only darkens on [data-theme="dark"] — there's no
  // prefers-color-scheme rule — so removing the attribute would render light even when the OS is dark,
  // which made the first click appear to do nothing.)
  document.documentElement.setAttribute('data-theme', effective_dark() ? 'dark' : 'light');
}

export function toggle_theme() {
  const d = effective_dark();
  try { localStorage.setItem(KEY, d ? 'light' : 'dark'); } catch (e) { /* ignore */ }
  apply_theme();
}

export function watch_system(cb) {
  if (window.matchMedia) {
    try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', cb); } catch (e) { /* ignore */ }
  }
}
