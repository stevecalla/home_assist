import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

// Footer at the bottom of the main content: the source DB table(s) feeding the current page on the
// left, running date + clock on the right. Ported from usat_apps' FooterClock (per-route source).
// Knowing which table you are looking at matters here — when a number looks wrong, the first
// question is always "wrong data, or wrong query?"
const SOURCES = {
  '/water/monitor': ['water_hourly', 'water_collector_state', 'water_alerts'],
  '/water/history': ['water_hourly', 'water_readings'],
  '/water/alerts': ['water_alerts'],
  '/water/settings': ['water_settings'],
  '/water/diagnostics': ['water_raw_samples', 'water_readings'],
  '/admin/users': ['auth.json + panel_access.json (outside the repo, not the DB)'],
};

export default function FooterClock() {
  const [now, setNow] = useState(new Date());
  const { pathname } = useLocation();
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const tables = SOURCES[pathname];
  const date = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  return (
    <div className="footer-clock">
      <span className="footer-src">
        {tables && tables.length
          ? <>Source {tables.length > 1 ? 'tables' : 'table'}: <code>{tables.join(', ')}</code></>
          : 'Home Assist'}
      </span>
      <span className="fc-when" aria-label="current date and time">
        <span className="fc-day">{date}</span> · <span className="fc-time">{time}</span>
      </span>
    </div>
  );
}
