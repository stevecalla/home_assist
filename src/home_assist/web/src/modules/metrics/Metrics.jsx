import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { num } from '../../lib/num.js';
import CollapsibleCard from '../../components/CollapsibleCard.jsx';
import BarChart from '../water/BarChart.jsx';
import './metrics.css';

// Metrics — what happened IN THE APP, as opposed to what happened at the meter.
//
// The order of this page is an argument. usat_apps leads with usage, because there the question is
// "is the team getting value from this". Here there is one household, so usage is trivia and the
// page leads with ISSUES: broken links, refused access, thrown errors. Those are the things you
// cannot reconstruct once the moment has passed, and this app gets opened most urgently at exactly
// the times nobody is writing anything down.
//
// Usage is still here, below, because two things about it do earn their place: the by-hour shape
// tells you when the house actually looks at this, and a sudden silence in by-day is a signal the
// app stopped working for somebody who never mentioned it.

const RANGES = [
  { d: 1, label: 'Today' },
  { d: 7, label: '7 days' },
  { d: 30, label: '30 days' },
  { d: 90, label: '90 days' },
];

export default function Metrics() {
  const [days, setDays] = useState(7);
  const [includeTest, setIncludeTest] = useState(false);
  const [data, setData] = useState(null);
  const [tail, setTail] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    const r = await api.metrics(days, { includeTest });
    if (r.status === 200 && r.body.ok) { setData(r.body); setErr(''); }
    else setErr(r.body.error || 'Could not load metrics');
  }, [days, includeTest]);

  useEffect(() => { load(); }, [load]);

  async function loadTail() {
    const r = await api.metricsEvents(200);
    if (r.status === 200 && r.body.ok) setTail(r.body.rows);
    else setErr(r.body.error || 'Could not load the event tail');
  }

  async function purge(mode) {
    setBusy(true); setMsg(null);
    const r = await api.metricsPurge(mode);
    setBusy(false);
    if (r.status === 200 && r.body.ok) {
      setMsg({ ok: true, text: 'Deleted ' + num(r.body.deleted) + ' row(s)' });
      setTail(null);
      load();
    } else setMsg({ ok: false, text: r.body.error || 'Could not purge' });
  }

  if (err && !data) return <div className="page"><p className="err">{err}</p></div>;
  if (!data) return <div className="loading">Loading…</div>;

  const t = data.totals;
  const quiet = t.events === 0;

  return (
    // `w-root` AND `m-root`. The chart + status palette (--w-series, --w-serious, --w-axis) is
    // declared on `.w-root`, not on :root — so a page without that class gets EMPTY custom
    // properties, and every colour silently falls back to inherited text. That is not a visible
    // error: the bars render, in the foreground colour, and the "alarm" border on a non-zero error
    // count comes out the same shade as everything else. The class is misnamed (it is the app's
    // data-viz palette, not a water thing) but renaming it touches every water page; carrying it
    // here is the honest one-line version, and metrics.test.js pins the pairing.
    <div className="page w-root m-root">
      <h2>Metrics</h2>
      <p className="muted">
        Usage and faults for the app itself — not the water. Counts and page names only: no IP
        addresses, no browser fingerprints, no query values, nothing about the readings.
      </p>

      <div className="m-toolbar">
        {RANGES.map((r) => (
          <button key={r.d} type="button" className={'w-chip' + (days === r.d ? ' on' : '')}
                  onClick={() => setDays(r.d)}>{r.label}</button>
        ))}
        <label className="m-check" title="Rows written while the URL carried ?metrics_test=1. Excluded from these figures by default so a session spent testing does not distort what you are testing.">
          <input type="checkbox" checked={includeTest} onChange={(e) => setIncludeTest(e.target.checked)} />
          <span>include test rows</span>
        </label>
        <span className="m-since muted small">
          since {String(data.since).slice(0, 16)} {data.tz}
        </span>
      </div>

      {/* "Nothing recorded" and "nothing happened" are different claims, and on a page whose whole
          job is to report activity, showing four zeroes for a broken ingest would be the worst
          possible failure -- it looks exactly like a quiet week. */}
      {quiet ? (
        <div className="card m-quiet">
          <h3>No events in this window</h3>
          <p className="muted">
            Either nobody opened the app, or events are not arriving. Open another page and come
            back: a <code>panel_view</code> should appear within seconds. If it does not, check that
            <code> POST /api/event</code> returns 204 and that the browser is not sending
            Do-Not-Track.
          </p>
        </div>
      ) : null}

      {/* ── ISSUES FIRST ───────────────────────────────────────────────────────────────────── */}
      <CollapsibleCard
        title="Issues"
        sub="Broken links, refused access, and errors. The reason this page exists."
      >
        <div className="m-tiles">
          <Tile label="Errors" value={t.errors} alarm={t.errors > 0} />
          <Tile label="Not found (404)" value={t.not_found} alarm={t.not_found > 0} />
          <Tile label="Access denied (403)" value={t.not_authorized} alarm={t.not_authorized > 0} />
        </div>

        <Table
          caption="Errors"
          empty="No errors recorded in this window."
          headers={['Type', 'Message', 'Count', 'Last seen']}
          rows={data.errors.map((e) => [e.type, e.message || '—', num(e.n), e.last_mtn || '—'])}
        />
        <Table
          caption="Links that 404'd"
          // A 404 on an INTERNAL link is a bug in the app, not a typo by the user -- it means a
          // link points somewhere that no longer exists. That is the one thing on this page worth
          // acting on the same day.
          empty="No broken links. Every path requested resolved to a page."
          headers={['Path', 'Times']}
          rows={data.top_not_found.map((r) => [r.path, num(r.n)])}
        />
        <Table
          caption="Access denied"
          empty="Nobody was refused a page in this window."
          headers={['Panel', 'Who', 'Times']}
          rows={data.access_denied.map((r) => [r.panel, r.actor, num(r.n)])}
        />
      </CollapsibleCard>

      {/* ── usage ──────────────────────────────────────────────────────────────────────────── */}
      <CollapsibleCard title="Usage" sub="Who opened what, and when." defaultOpen={false}>
        <div className="m-tiles">
          <Tile label="Panel views" value={t.panel_views} />
          <Tile label="Sessions" value={t.sessions} />
          <Tile label="Browsers" value={t.visitors} help="Distinct browsers, not people — a phone and a laptop are two." />
          <Tile label="Sign-ins" value={t.logins} />
        </div>

        <h4 className="m-h4">By day</h4>
        <BarChart
          data={data.by_day.map((d) => ({
            key: d.day, label: String(d.day).slice(5), value: d.views,
            // Every day in the window is drawn, so a day with no activity is a visible gap rather
            // than an absent bar. Same rule as the water charts: no data and zero are not the same.
            observed: true, highlight: d.errors > 0,
          }))}
          unit="views" height={140}
          formatTip={(d) => `${d.key} — ${num(d.value)} views`}
          emptyMessage="No activity in this window."
        />

        <h4 className="m-h4">By hour of day <span className="muted small">({data.tz})</span></h4>
        <BarChart
          data={data.by_hour.map((h) => ({
            key: String(h.hour), label: String(h.hour).padStart(2, '0'), value: h.n, observed: true,
          }))}
          unit="events" height={120}
          formatTip={(d) => `${d.label}:00 — ${num(d.value)} events`}
          emptyMessage="No activity in this window."
        />

        <Table
          caption="By panel"
          empty="No panel views recorded."
          headers={['Panel', 'Views', 'Events']}
          rows={data.by_panel.map((r) => [r.panel, num(r.views), num(r.events)])}
        />
        <Table
          caption="By event"
          empty="No events."
          headers={['Event', 'Count']}
          rows={data.by_event.map((r) => [r.event, num(r.n)])}
        />
      </CollapsibleCard>

      <CollapsibleCard title="Sessions" sub="The most recent sittings." defaultOpen={false}>
        <Table
          empty="No sessions in this window."
          headers={['Session', 'Who', 'Device', 'Theme', 'Timezone', 'Events', 'Started', 'Last']}
          rows={data.sessions.map((s) => [
            s.session_id, s.actor, s.viewport, s.theme, s.client_tz || '—',
            num(s.events), s.started_mtn || '—', s.last_mtn || '—',
          ])}
        />
      </CollapsibleCard>

      <CollapsibleCard title="Recent events" sub="The raw tail, newest first — for reading one incident." defaultOpen={false}>
        {!tail ? (
          <button className="btn" onClick={loadTail}>Load the last 200 events</button>
        ) : (
          <Table
            empty="Nothing recorded yet."
            headers={['When', 'Event', 'Who', 'Panel', 'View / path', 'Error']}
            rows={tail.map((r) => [
              r.created_at_mtn, r.event_name, r.actor || 'anon', r.panel || '—',
              r.view || r.page_path || '—',
              r.error_type ? r.error_type + (r.error_msg ? ': ' + r.error_msg : '') : '—',
            ])}
          />
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Table health" sub="Size, span, and what can be deleted." defaultOpen={false}>
        <div className="m-tiles">
          <Tile label="Rows" value={data.health.rows} />
          <Tile label="Megabytes" value={data.health.mb} dp={2} />
          <Tile label="Test rows" value={data.health.test_rows} />
        </div>
        <p className="muted small">
          Spans {data.health.first_mtn || '—'} to {data.health.last_mtn || '—'}. Retention keeps the
          current and prior calendar year ({data.health.keep_years} years).
        </p>
        {data.health.by_year && data.health.by_year.length ? (
          <Table headers={['Year', 'Rows']} empty=""
                 rows={data.health.by_year.map((y) => [String(y.year), num(y.rows)])} />
        ) : null}

        {/* Destructive, and admin-only on the server whatever the panel grant says. Three named
            modes rather than one button with a dropdown, because the difference between "delete my
            test rows" and "delete everything" should not be one wrong click. */}
        <div className="m-purge">
          <button className="btn" disabled={busy || !data.health.test_rows}
                  onClick={() => purge('test')}
                  title="Delete only the rows written while ?metrics_test=1 was set">
            Delete {num(data.health.test_rows)} test row(s)
          </button>
          <button className="btn" disabled={busy} onClick={() => purge('old')}
                  title={'Delete anything older than the last ' + data.health.keep_years + ' calendar years'}>
            Delete old years
          </button>
          <button className="btn danger" disabled={busy}
                  onClick={() => { if (window.confirm('Delete EVERY metrics row? This cannot be undone.')) purge('all'); }}>
            Delete everything
          </button>
          {msg ? <span className={msg.ok ? 'w-meter-ok' : 'err'}>{msg.text}</span> : null}
        </div>
      </CollapsibleCard>
    </div>
  );
}

function Tile({ label, value, help, alarm, dp }) {
  return (
    <div className={'m-tile' + (alarm ? ' alarm' : '')}>
      <div className="m-tile-label" title={help || undefined}>
        {label}{help ? <i className="w-q">?</i> : null}
      </div>
      <div className="m-tile-value">{num(value, dp || 0)}</div>
    </div>
  );
}

// An empty table says WHY it is empty, in words that distinguish "nothing went wrong" from "nothing
// was recorded". On this page those two readings are opposite, and a bare "—" chooses neither.
function Table({ caption, headers, rows, empty }) {
  return (
    <div className="m-table-wrap">
      {caption ? <h4 className="m-h4">{caption}</h4> : null}
      {!rows || !rows.length ? (
        empty ? <p className="muted small">{empty}</p> : null
      ) : (
        <div className="m-table-scroll">
          <table className="w-table">
            <thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
