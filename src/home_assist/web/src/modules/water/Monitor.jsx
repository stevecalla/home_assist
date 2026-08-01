import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import BarChart from './BarChart.jsx';
import LiveChart from './LiveChart.jsx';
import './water.css';

// The Monitor — the page you actually open when you wonder "is water running right now?"
//
// Ordered by what matters: the verdict first (a leak monitor whose answer you have to hunt for has
// failed), then whether the receiver is even alive, then the numbers, then the shape of the day.
//
// Polls every 5s. A poll rather than SSE because on a LAN this is free and the failure mode is
// obvious; the meter only broadcasts every few seconds anyway.
const POLL_MS = 5000;

const BANNER = {
  ok:      { icon: '✓', cls: 'ok' },
  leak:    { icon: '⚠', cls: 'leak' },
  offline: { icon: '📵', cls: 'offline' },
  unknown: { icon: '…', cls: 'unknown' },
};

// The continuous-run states. Icon AND word always travel together — color never carries the
// meaning on its own, which is the same rule the charts follow.
const RUN = {
  idle:       { icon: '○', word: 'Idle',       note: () => '' },
  running:    { icon: '💧', word: 'Running',    note: (r) => `normal so far — flagged past ${fmtDur(r.warn_min)}` },
  long:       { icon: '⏱', word: 'Running a long time', note: (r) => `longer than a shower or a dishwasher cycle — worth a look` },
  continuous: { icon: '⚠', word: 'CONTINUOUS FLOW', note: (r) => `over ${fmtDur(r.alarm_min)} unbroken — that is not a fixture` },
};

function fmtDur(min) {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

// How much of the live tape to keep, and therefore how far back the live chart looks.
const LIVE_WINDOW_MS = 30 * 60 * 1000;          // 30 minutes
const LIVE_MAX_POINTS = Math.ceil(LIVE_WINDOW_MS / POLL_MS) + 10;

export default function Monitor() {
  const [status, setStatus] = useState(null);
  const [hourly, setHourly] = useState(null);
  const [alerts, setAlerts] = useState(null);
  const [live, setLive] = useState([]);
  const [err, setErr] = useState('');

  const load = useCallback(async (withCharts) => {
    const s = await api.waterStatus();
    if (s.status === 200 && s.body.ok) {
      setStatus(s.body);
      setErr('');
      // The live tape. Built client-side from the poll we already make, rather than from a new
      // table: the collector writes a reading only when gallons MOVE, so a server-side series
      // would be empty exactly when you are staring at it wondering whether anything is alive.
      const odo = s.body.meter && s.body.meter.odometer_gallons;
      const readAt = s.body.receiver && s.body.receiver.last_read_at;
      if (typeof odo === 'number' && Number.isFinite(odo)) {
        // Stamp with the meter's own last-heard time, not the browser clock — if the collector
        // goes deaf the tape must stop advancing, not keep drawing a confident flat line.
        const t = readAt ? new Date(readAt).getTime() : Date.now();
        setLive((prev) => {
          const lastPt = prev[prev.length - 1];
          if (lastPt && lastPt.t === t && lastPt.gallons === odo) return prev;   // nothing new
          // A meter rollover (or a reset) would otherwise render as one enormous negative cliff.
          const next = lastPt && odo < lastPt.gallons ? [] : prev;
          const out = next.concat({ t, gallons: odo });
          const cutoff = t - LIVE_WINDOW_MS;
          const trimmed = out.filter((p) => p.t >= cutoff);
          return trimmed.length > LIVE_MAX_POINTS ? trimmed.slice(-LIVE_MAX_POINTS) : trimmed;
        });
      }
    } else setErr(s.body.error || 'Could not load status');
    if (withCharts) {
      const h = await api.waterHourly(48);
      if (h.status === 200 && h.body.ok) setHourly(h.body);
      const a = await api.waterAlerts(5);
      if (a.status === 200 && a.body.ok) setAlerts(a.body.alerts);
    }
  }, []);

  useEffect(() => {
    load(true);
    const id = setInterval(() => load(false), POLL_MS);
    const idCharts = setInterval(() => load(true), 60000);
    return () => { clearInterval(id); clearInterval(idCharts); };
  }, [load]);

  if (err && !status) return <div className="page"><p className="err">{err}</p></div>;
  if (!status) return <div className="loading">Loading…</div>;

  const b = BANNER[status.leak.state] || BANNER.unknown;
  const r = status.receiver;
  const t = status.totals;
  const overnightHigh = t.overnight > t.overnight_threshold;
  // Tolerate an older server that predates /api/water/status returning `run`.
  const run = status.run || { flowing: false, level: 'idle', minutes: 0, gallons: 0, rate: 0, idle_minutes: null };

  // Live-tape summary. All derived from the same buffer the chart draws, so the headline number and
  // the line can never disagree.
  const liveFirst = live.length ? live[0] : null;
  const liveLast = live.length ? live[live.length - 1] : null;
  const liveUsed = liveFirst && liveLast ? Math.max(0, liveLast.gallons - liveFirst.gallons) : 0;

  // NOTE: "is water running" is answered ONCE, by the server (`run`), and both the header badge and
  // the run card read from it. An earlier version recomputed it here from the client tape; the two
  // then disagreed whenever a packet was rejected or the tape had just been reset, and a monitor
  // that contradicts itself in two adjacent elements teaches you to trust neither.

  // The meter has stopped reporting. The chart stops rather than extending a flat line, because a
  // flat line here would assert "no water is being used" when the honest answer is "we cannot see".
  const liveStale = !!(liveLast && Date.now() - liveLast.t > POLL_MS * 6);

  const bars = (hourly ? hourly.series : []).map((s) => ({
    key: s.hour_key,
    label: String(s.hour).padStart(2, '0'),
    value: s.gallons,
    observed: s.observed,
    highlight: s.hour >= t.overnight_window[0] && s.hour < t.overnight_window[1],
  }));

  return (
    <div className="page w-root">
      <h2>Water monitor</h2>
      <p className="muted">{status.meter_name ? status.meter_name + ' · ' : ''}ID {status.meter_id} · {status.tz}</p>

      {/* Verdict and receiver health in ONE row.
          They were two stacked cards, which pushed the live chart below the fold on a laptop — and
          the chart is what you open this page to see. They also belong together: "all clear" is
          only meaningful if the receiver is actually hearing the meter, so reading one without the
          other is the mistake, not the shortcut. Icon + word still carry the state; color only
          reinforces it. */}
      <div className={'w-banner ' + b.cls} role="status">
        <span className="w-banner-icon" aria-hidden="true">{b.icon}</span>
        <span className="w-banner-text">
          <p className="w-banner-head">{status.leak.headline}</p>
          <p className="w-banner-sub">{status.leak.detail}</p>
        </span>
        <span className="w-banner-meta">
          <span className="w-strip-item">
            <span className={'w-dot ' + (r.collector_up ? 'up' : 'down')} aria-hidden="true" />
            <span className="w-strip-value">{r.collector_up ? 'Collector up' : 'Collector DOWN'}</span>
          </span>
          <span className="w-strip-item">
            <span className="w-strip-label">Reading</span>
            <span className="w-strip-value">
              {status.meter.odometer_gallons === null ? '—' : Number(status.meter.odometer_gallons).toLocaleString()}
            </span>
          </span>
          {r.mode === 'replay' ? (
            <span className="w-strip-item"><span className="w-strip-value">REPLAY — not the real meter</span></span>
          ) : null}
          {/* Last packet, in full and right-justified. The relative age ("3 min ago") is the faster
              read, but only the absolute stamp survives a screenshot or a phone call — and it is
              the one you compare against a pm2 log line when something looks wrong. Rendered in the
              METER's timezone, not the browser's, so a laptop on the road still shows house time. */}
          <span className="w-banner-stamp">
            <span className="w-strip-label">Last packet</span>
            <span className="w-strip-value">{fullStamp(r.last_read_at, status.tz)}</span>
            <span className="w-strip-label">{r.quiet_minutes === null ? '' : '(' + ago(r.quiet_minutes) + ')'}</span>
          </span>
        </span>
      </div>

      <div className="w-tiles">
        <Tile label="Today" value={t.today} note={'since midnight ' + status.tz.split('/')[1].replace('_', ' ')} />
        <Tile
          label={`Overnight (${t.overnight_window[0]}–${t.overnight_window[1]})`}
          value={t.overnight}
          note={overnightHigh ? `over the ${t.overnight_threshold} gal threshold` : `threshold ${t.overnight_threshold} gal`}
          alarm={overnightHigh}
        />
        <Tile label="Last 24 hours" value={t.last_24h} />
        <Tile label="Daily average" value={t.avg_day_7d} note="previous 7 full days" />
      </div>

      {/* The live tape. Sits above the hourly bars because "is water running RIGHT NOW" is the
          question people open this page to answer; the bars are the shape of the day. */}
      <div className="w-chart-card">
        <div className="w-chart-head">
          <h3 className="w-chart-title">Live — water used in the last 30 minutes</h3>
          <span className={'w-live-badge ' + (run.flowing ? 'flowing' : 'idle')}>
            <span className="w-dot-live" aria-hidden="true" />
            {run.flowing ? `Running · ${run.rate.toFixed(1)} gal/min` : 'Idle'}
          </span>
        </div>

        {/* Continuous-run meter. THE measurement: every fixture in a house stops on its own, so
            duration without a break is what separates "someone showered" from "something broke".
            Server-computed, so it survives a page reload and is not capped by the 30-minute tape. */}
        <div className={'w-run w-run-' + run.level} role="status">
          <span className="w-run-icon" aria-hidden="true">{RUN[run.level].icon}</span>
          <span className="w-run-body">
            <span className="w-run-head">
              {run.flowing
                ? `${RUN[run.level].word} — ${run.truncated ? 'at least ' : ''}${fmtDur(run.minutes)} without stopping`
                : run.idle_minutes === null ? 'No flow recorded yet' : `Nothing running — quiet for ${fmtDur(run.idle_minutes)}`}
            </span>
            <span className="w-run-sub">
              {run.flowing
                ? `${run.gallons.toFixed(0)} gal this run · ${run.rate.toFixed(1)} gal/min · ${RUN[run.level].note(run)}`
                : 'Every fixture stops on its own. Something that never stops is what this watches for.'}
            </span>
          </span>
        </div>
        {/* One line, not three paragraphs. The explanation was pushing the chart it explains off
            the screen; the details live in <details> for the first read and stay closed after. */}
        <p className="w-chart-sub">
          <strong>Flat = nothing running.</strong> A step is a fixture; a steady climb is what you
          are watching for. Left axis gallons used, right axis lifetime total.{' '}
          <details className="w-inline-note">
            <summary>Why two axes?</summary>
            The odometer reads{' '}
            {status.meter.odometer_gallons === null ? 'six figures' : Number(status.meter.odometer_gallons).toLocaleString()}
            {' '}gal, so on that scale a shower is invisible. The chart is drawn against gallons used
            since this window opened; the right axis relabels the same line as the meter&apos;s
            lifetime total, for cross-checking the dial in the pit against your utility bill. One
            line, two labels — not two series.
          </details>
        </p>
        <LiveChart
          points={live}
          windowMs={LIVE_WINDOW_MS}
          gapMs={POLL_MS * 4}
          emptyMessage={
            r.collector_up
              ? 'Listening… the first points appear within a few seconds.'
              : 'The collector is not running, so there is nothing live to show.'
          }
        />
        {live.length >= 2 ? (
          <p className="muted small" style={{ marginTop: 8 }}>
            {liveUsed.toFixed(1)} gal over the last {Math.max(1, Math.round((live[live.length - 1].t - live[0].t) / 60000))} min
            {liveStale ? ' · the meter has gone quiet — the line stops rather than pretending' : ''}
          </p>
        ) : null}
      </div>

      <div className="w-chart-card">
        <div className="w-chart-head">
          <h3 className="w-chart-title">Gallons per hour, last 48 hours</h3>
          <Link className="muted small" to="/water/history">Longer view →</Link>
        </div>
        <p className="w-chart-sub">
          The overnight window is shaded. A running toilet shows up as a flat, unbroken row of bars
          across the shaded band — which is exactly what normal use never looks like.
        </p>
        <BarChart
          data={bars}
          height={190}
          formatTip={(d) => (d.observed
            ? `${d.label}:00 — ${d.value.toFixed(0)} gal`
            : `${d.label}:00 — no data (receiver was not listening)`)}
          emptyMessage="No readings yet. Start the collector: npm run water_collector"
        />
        <div className="w-legend-note">
          <span><span className="w-swatch series" />Gallons used</span>
          <span><span className="w-swatch nodata" />No data (not the same as zero)</span>
          <span><span className="w-swatch band" />Overnight window</span>
        </div>
      </div>

      {/* Recent alerts, with delivery status. An alert that was raised but never delivered is the
          failure this panel exists to make impossible to miss. */}
      <div className="w-chart-card">
        <div className="w-chart-head">
          <h3 className="w-chart-title">Recent alerts</h3>
          <Link className="muted small" to="/water/alerts">All alerts →</Link>
        </div>
        {!alerts ? <p className="muted">Loading…</p> : !alerts.length ? (
          <p className="muted">
            Nothing yet — the quiet outcome. Send a test from <b>Settings</b> so you know the
            channel works before it matters.
          </p>
        ) : (
          <table className="w-table stack">
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td style={{ whiteSpace: 'nowrap', width: 160 }}>{a.fired_at_local}</td>
                  <td style={{ width: 110 }}>
                    <span className={'w-pill ' + (a.delivered ? 'sent' : 'failed')}>
                      {a.delivered ? '✓ sent' : '✕ not sent'}
                    </span>
                  </td>
                  <td>{a.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, note, alarm }) {
  return (
    <div className="w-tile">
      <div className="w-tile-label">{label}</div>
      <div className="w-tile-value">
        {Number(value).toFixed(value < 10 ? 1 : 0)}<span className="w-tile-unit">gal</span>
      </div>
      {note ? <div className={'w-tile-note' + (alarm ? ' alarm' : '')}>{note}</div> : null}
    </div>
  );
}

// The last packet, spelled out. Formatted in the METER's timezone rather than the browser's: this
// dashboard gets opened from a laptop in another state, and "1:44 AM" has to mean 1:44 AM at the
// house or it is worse than useless for comparing against a log line.
function fullStamp(iso, tz) {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  const opts = { timeZone: tz || undefined };
  try {
    const date = new Intl.DateTimeFormat('en-US', { ...opts, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(d);
    const time = new Intl.DateTimeFormat('en-US', { ...opts, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).format(d);
    return date + ' \u00b7 ' + time;
  } catch (e) {
    return d.toISOString();          // an unknown tz must not blank the whole header
  }
}

function ago(min) {
  if (min < 1) return 'just now';
  if (min < 60) return min + ' min ago';
  const h = Math.floor(min / 60);
  if (h < 24) return h + 'h ' + (min % 60) + 'm ago';
  return Math.floor(h / 24) + 'd ago';
}
