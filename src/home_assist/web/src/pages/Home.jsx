import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { NAV, canSee } from '../nav.js';
import { api } from '../lib/api.js';

// Platform landing — a card per panel the signed-in user can reach, grouped like the rail, with a
// live one-line water summary on top. The front door of the house dashboard.
export default function Home({ user }) {
  const [water, setWater] = useState(null);

  useEffect(() => {
    if (!canSee(user, 'water')) return undefined;
    let alive = true;
    api.waterStatus().then((r) => { if (alive && r.status === 200 && r.body.ok) setWater(r.body); }).catch(() => {});
    return () => { alive = false; };
  }, [user]);

  const cards = [];
  NAV.forEach((n) => {
    if (n.type === 'solo') { if (canSee(user, n.panel)) cards.push({ label: n.label, path: n.path, group: null }); }
    else n.items.forEach((it) => { if (canSee(user, it.panel)) cards.push({ label: it.label, path: it.path, group: n.label }); });
  });

  const state = water && water.leak ? water.leak.state : null;
  const tone = state === 'ok' ? 'ok' : state === 'leak' ? 'danger' : state === 'offline' ? 'danger' : 'warn';

  return (
    <div className="page">
      <h2>Home Assist</h2>
      <p className="muted">
        Everything watching the house, in one place.
        {user && user.role === 'admin' ? ' Manage users and access under Admin.' : ''}
      </p>

      {water ? (
        <Link to="/water/monitor" className={'banner banner-' + tone} style={{ textDecoration: 'none', display: 'block', marginTop: 16 }}>
          <strong>{water.leak.headline}</strong>
          <span className="muted" style={{ marginLeft: 10 }}>{water.leak.detail}</span>
          <span style={{ float: 'right' }}>{Number(water.totals.today).toFixed(0)} gal today →</span>
        </Link>
      ) : null}

      <div
        className="ref-grid"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16, marginTop: 20 }}
      >
        {cards.length === 0 ? (
          <div className="card">
            <h3>No panels yet</h3>
            <p className="muted">You don't have access to any panels. Ask an admin to grant access.</p>
          </div>
        ) : cards.map((m) => (
          <Link key={m.path} to={m.path} className="card" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
            {m.group ? (
              <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>{m.group}</div>
            ) : null}
            <h3 style={{ marginBottom: 4 }}>{m.label}</h3>
            <p className="muted">Open →</p>
          </Link>
        ))}
      </div>

      <p className="muted small" style={{ marginTop: 24 }}>
        Signed in as <b>{user.user}</b>{user.role === 'admin' ? ' (admin)' : ''}.
      </p>
    </div>
  );
}
