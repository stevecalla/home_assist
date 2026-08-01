import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { trackNotAuthorized } from '../lib/track.js';

// In-shell 403. Rendered by App.jsx's guard() when a signed-in user opens a panel they lack the
// grant for (distinct from 404 — the page exists, they just can't see it). Records a
// `not_authorized` event so access-gap patterns surface in usat_apps metrics.
export default function NotAuthorized({ panel }) {
  const location = useLocation();
  useEffect(() => { trackNotAuthorized(panel, location.pathname); }, [panel, location.pathname]);

  return (
    <div className="page state-page">
      <div className="state-code danger">403</div>
      <h2>You don’t have access</h2>
      <p className="muted">
        Your account isn’t permitted to view this page{panel ? <> (<code>{panel}</code>)</> : null}.
      </p>
      <p className="muted small">If you think this is a mistake, ask an admin to grant access.</p>
      <p><Link className="btn primary" to="/">Back to Home</Link></p>
    </div>
  );
}
