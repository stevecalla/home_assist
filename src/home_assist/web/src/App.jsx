import { Suspense, useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { api } from './lib/api.js';
import { trackPanelView, trackSession } from './lib/track.js';
import { allPanels, canSee, panelForPathname, redirects } from './nav.js';
import SideRail from './components/SideRail.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import UserMenu from './components/UserMenu.jsx';
import FooterClock from './components/FooterClock.jsx';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import NotFound from './pages/NotFound.jsx';
import NotAuthorized from './pages/NotAuthorized.jsx';

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = loading, null = signed out
  const location = useLocation();

  useEffect(() => {
    api.me().then((r) => setUser(r.status === 200 && r.body.ok ? r.body : null)).catch(() => setUser(null));
  }, []);

  // Auth-expiry redirect: any data call that 401s dispatches 'home_assist:unauthorized' (see
  // lib/api.js). Flip to signed-out so the Login screen renders. 403s do NOT fire this — they stay
  // in-app as the access-denied view.
  useEffect(() => {
    const onUnauth = () => setUser(null);
    window.addEventListener('home_assist:unauthorized', onUnauth);
    return () => window.removeEventListener('home_assist:unauthorized', onUnauth);
  }, []);

  useEffect(() => {
    if (user && user.ok) trackPanelView(location.pathname, panelForPathname(location.pathname));
  }, [location.pathname, user]);

  if (user === undefined) return <div className="loading">Loading…</div>;
  if (!user) return <Login onLogin={setUser} />;

  const guard = (panel, el) => (canSee(user, panel) ? el : <NotAuthorized panel={panel} />);

  return (
    <div className="wrap">
      <header className="app-header">
        <div className="title-row">
          <span className="brandmark" aria-hidden="true">💧</span>
          <h1>Home Assist</h1>
          <span className="header-btns">
            <ThemeToggle />
            <UserMenu
              user={user}
              onLogout={async () => {
                try { trackSession('logout'); } catch (e) { /* best-effort */ }
                await api.logout();
                setUser(null);
              }}
            />
          </span>
        </div>
      </header>

      <div className="admin-shell">
        <SideRail user={user} />
        <main className="admin-main">
          <Suspense fallback={<div className="loading">Loading…</div>}>
            <Routes>
              <Route path="/" element={<Home user={user} />} />
              {/* Bare group paths (/water, /admin) -> that group's first child page. */}
              {redirects().map((r) => (
                <Route key={r.from} path={r.from} element={<Navigate to={r.to} replace />} />
              ))}
              {allPanels().map((p) => (
                <Route
                  key={p.path}
                  path={p.nested ? p.path + '/*' : p.path}
                  element={guard(p.panel, <p.Component title={p.label} user={user} />)}
                />
              ))}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
          <FooterClock />
        </main>
      </div>
    </div>
  );
}
