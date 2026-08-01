import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { NAV, canSee } from '../nav.js';

// Left rail: a fixed HOME link, then the NAV entries (each with an icon). Groups are collapsible
// (open/closed persisted in localStorage) and only show panels the user can reach. A LINKS section at
// the bottom (external, new-tab) mirrors the proxy console — shown to users who can reach Ops.
const LSKEY = 'home_assist_rail_collapsed';
function loadCollapsed() { try { return JSON.parse(localStorage.getItem(LSKEY)) || {}; } catch (e) { return {}; } }

const LINKS = [
  ['/api/status', '/api/status'],
  ['/api/ops/health', '/api/ops/health'],
];

export default function SideRail({ user }) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggle = (g) => setCollapsed((c) => {
    const n = Object.assign({}, c, { [g]: !c[g] });
    try { localStorage.setItem(LSKEY, JSON.stringify(n)); } catch (e) { /* ignore */ }
    return n;
  });
  const linkClass = ({ isActive }) => 'rail-link' + (isActive ? ' on' : '');
  const ico = (g) => <span className="rail-ico" aria-hidden="true">{g}</span>;
  const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');

  return (
    <nav className="siderail" aria-label="Primary">
      <div className="rail-section">
        <NavLink to="/" end className={linkClass}>{ico('⌂')}Home</NavLink>
      </div>

      {NAV.map(function (n) {
        if (n.type === 'solo') {
          if (!canSee(user, n.panel)) return null;
          return (
            <div className="rail-section" key={n.path}>
              <NavLink to={n.path} className={linkClass}>{ico(n.icon)}{n.label}</NavLink>
            </div>
          );
        }
        const items = n.items.filter(function (it) { return canSee(user, it.panel); });
        if (!items.length) return null;
        const isCollapsed = !!collapsed[n.label];
        return (
          <div className="rail-section" key={n.label}>
            <button type="button" className="rail-group" onClick={() => toggle(n.label)} aria-expanded={!isCollapsed}>
              <span className="rail-caret" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>{n.label}
            </button>
            {!isCollapsed && items.map(function (it) {
              return <NavLink key={it.path} to={it.path} className={({ isActive }) => 'rail-link rail-sub' + (isActive ? ' on' : '')}>{ico(it.icon)}{it.label}</NavLink>;
            })}
          </div>
        );
      })}

    </nav>
  );
}
