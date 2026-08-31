import { lazy } from 'react';
import Admin from './pages/Admin.jsx';

// Platform navigation — the single source for the rail AND the router. Groups are collapsible rail
// sections; solos are standalone links. Access is enforced per panel key (admins see everything).
//
// TO ADD A FEATURE: create modules/<id>/module.js on the server, add it to modules/registry.js, then
// add a group here. Nothing else changes — the rail, the routes, the home cards, and panel access
// are all derived from this list plus the server registry.
const WaterMonitor = lazy(() => import('./modules/water/Monitor.jsx'));
const WaterHistory = lazy(() => import('./modules/water/History.jsx'));
const WaterAlerts = lazy(() => import('./modules/water/Alerts.jsx'));
const WaterSettings = lazy(() => import('./modules/water/Settings.jsx'));
const WaterMeters = lazy(() => import('./modules/water/Meters.jsx'));
const WaterDiagnostics = lazy(() => import('./modules/water/Diagnostics.jsx'));
const WaterReference = lazy(() => import('./modules/water/Reference.jsx'));
const Metrics = lazy(() => import('./modules/metrics/Metrics.jsx'));

export const NAV = [
  {
    type: 'group', label: 'Water', items: [
      // `section` is a rail HEADING only. Reading pages first, then the ones that change what the
      // collector does. Both kinds are the water module -- moving setup to Admin would make Admin a
      // drawer for every module's config and break the module boundary the whole app derives from.
      // The rail just stops implying that Monitor and Settings are the same kind of page.
      { label: 'Monitor', path: '/water/monitor', panel: 'water-monitor', icon: '💧', Component: WaterMonitor },
      { label: 'History', path: '/water/history', panel: 'water-history', icon: '📈', Component: WaterHistory },
      { label: 'Alerts', path: '/water/alerts', panel: 'water-alerts', icon: '🔔', Component: WaterAlerts },
      { label: 'Reference', path: '/water/reference', panel: 'water-reference', icon: '📖', Component: WaterReference },
      { label: 'Settings', path: '/water/settings', panel: 'water-settings', icon: '⚙', Component: WaterSettings, section: 'Setup' },
      { label: 'Meters', path: '/water/meters', panel: 'water-meters', icon: '🏠', Component: WaterMeters, section: 'Setup' },
      { label: 'Diagnostics', path: '/water/diagnostics', panel: 'water-diagnostics', icon: '📡', Component: WaterDiagnostics, section: 'Setup' },
    ],
  },
  {
    type: 'group', label: 'Admin', defaultCollapsed: true, items: [
      { label: 'Users & access', path: '/admin/users', panel: 'admin', icon: '👤', Component: Admin },
      // A NORMAL panel key, not the role-gated 'admin' one. It shows in the access panel and can be
      // granted deliberately; it is simply excluded from the 'all' default (panel_access.
      // DEFAULT_ALL_EXCLUDE), so it is admin-only until somebody hands it out. Purging the table is
      // admin-only regardless of the grant.
      { label: 'Metrics', path: '/admin/metrics', panel: 'metrics', icon: '📊', Component: Metrics },
    ],
  },
];

// Can this user reach a panel? Admins see all; 'admin' is admin-only; else it needs the grant.
export function canSee(user, panel) {
  if (!panel) return true;
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (panel === 'admin') return false;
  return Array.isArray(user.panels) && user.panels.includes(panel);
}

// Resolve a URL pathname to its nav PANEL key (longest matching path wins).
export function panelForPathname(pathname) {
  const p = pathname || '/';
  let best = null;
  allPanels().forEach(function (it) {
    if (!it.path) return;
    if (p === it.path || p.indexOf(it.path + '/') === 0) {
      if (!best || it.path.length > best.path.length) best = it;
    }
  });
  return best ? best.panel : (p.replace(/^\//, '').split('/')[0] || 'home');
}

// Redirect map: each group's BASE path (/water) -> its first child. Without this, hitting a bare
// group path falls to the 404 even though the group has real pages. Derived from NAV, so a new
// group works automatically.
export function redirects() {
  const out = [];
  const seen = {};
  NAV.forEach(function (n) {
    if (n.type !== 'group' || !n.items || !n.items.length) return;
    const first = n.items.find(function (it) { return it.path; });
    if (!first) return;
    const base = '/' + String(first.path).split('/')[1];
    if (base && base !== '/' && !seen[base]) { seen[base] = 1; out.push({ from: base, to: first.path }); }
  });
  return out;
}

// Every leaf panel flattened — used to build the routes.
export function allPanels() {
  const out = [];
  NAV.forEach(function (n) {
    if (n.type === 'group') n.items.forEach(function (it) { out.push(it); });
    else out.push(n);
  });
  return out;
}
