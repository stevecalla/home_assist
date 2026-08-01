import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { trackNotFound } from '../lib/track.js';

// In-shell 404. Rendered by the router's catch-all (App.jsx) for any URL that matches no route.
// Records a `not_found` event so broken internal links surface in usat_apps metrics.
export default function NotFound() {
  const location = useLocation();
  useEffect(() => { trackNotFound(location.pathname); }, [location.pathname]);

  return (
    <div className="page state-page">
      <div className="state-code">404</div>
      <h2>Page not found</h2>
      <p className="muted">We couldn’t find <code>{location.pathname}</code>.</p>
      <p><Link className="btn primary" to="/">Go to Home</Link></p>
    </div>
  );
}
