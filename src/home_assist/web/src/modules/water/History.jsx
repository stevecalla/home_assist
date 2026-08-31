import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import BarChart from './BarChart.jsx';
import MeterPicker from './MeterPicker.jsx';
import { useMeterSel } from './meterSel.js';
import './water.css';

// History — the longer view. Hourly over a chosen window, plus daily totals.
//
// The table toggle is not decoration: the dataviz relief rule wants a non-color path to the same
// numbers, and in practice "what exactly did 3am read" is a question you ask often enough that
// hovering 720 bars is the wrong answer.
const HOUR_RANGES = [24, 48, 72, 168];
const DAY_RANGES = [14, 30, 90];
// Calendar periods, kept in their OWN group. A row reading "30d | Last month" invites the reading
// that they are the same kind of thing; they are not. A rolling window is always the same length
// and always comparable to itself. A calendar month is 28-31 days and is what the utility bills.
const MONTH_RANGES = [
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
];

export default function History() {
  const [hours, setHours] = useState(48);
  const [days, setDays] = useState(30);
  // null = a rolling `days` window; otherwise the calendar period key.
  const [period, setPeriod] = useState(null);
  const [hourly, setHourly] = useState(null);
  const [daily, setDaily] = useState(null);
  const [table, setTable] = useState(false);
  // The same selection the Monitor is using. Charting is per meter -- 'all' resolves to yours
  // server-side, because two houses' odometers cannot be summed into one line.
  const [sel, setSel] = useMeterSel();
  const selId = /^[0-9]+$/.test(sel) ? Number(sel) : null;

  useEffect(() => {
    api.waterHourly(hours, sel).then((r) => { if (r.status === 200 && r.body.ok) setHourly(r.body); });
  }, [hours, sel]);

  useEffect(() => {
    api.waterDaily(days, sel, period).then((r) => { if (r.status === 200 && r.body.ok) setDaily(r.body); });
  }, [days, sel, period]);

  const win = hourly ? hourly.overnight_window : [2, 5];

  const hourBars = (hourly ? hourly.series : []).map((s) => ({
    key: s.hour_key,
    label: hours > 72 ? s.hour_key.slice(5, 10) : String(s.hour).padStart(2, '0'),
    value: s.gallons,
    observed: s.observed,
    highlight: s.hour >= win[0] && s.hour < win[1],
  }));

  const dayBars = (daily ? daily.series : []).map((s) => ({
    key: s.day_key,
    label: s.day_key.slice(5),
    value: s.gallons,
    observed: s.observed,
    highlight: false,
  }));

  return (
    <div className="page w-root">
      <h2>Water history</h2>
      <p className="muted">
        Everything the collector has recorded, in local time.
        {selId !== null ? <b className="w-viewing"> · viewing {selId}</b> : null}
      </p>
      <div className="w-rangebar">
        <span className="w-range-label">Meter</span>
        <MeterPicker sel={sel} setSel={setSel} ownId={hourly ? hourly.own_meter_id : null} allowAll={false} />
      </div>

      <div className="ha-card">
        <div className="ha-card-head">
          <h3 className="ha-card-title">Gallons per hour</h3>
          {/* Filters in one row above the chart. */}
          <span>
            {HOUR_RANGES.map((h) => (
              <button
                key={h}
                type="button"
                className={'btn' + (h === hours ? ' primary' : '')}
                style={{ marginLeft: 6 }}
                onClick={() => setHours(h)}
              >
                {h < 168 ? h + 'h' : '7d'}
              </button>
            ))}
            <button type="button" className="btn" style={{ marginLeft: 12 }} onClick={() => setTable((t) => !t)}>
              {table ? 'Show chart' : 'Show table'}
            </button>
          </span>
        </div>
        <p className="ha-card-sub">Shaded = the overnight window ({win[0]}:00–{win[1]}:00).</p>

        {table ? (
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            <table className="w-table">
              <thead><tr><th>Hour (local)</th><th style={{ textAlign: 'right' }}>Gallons</th><th style={{ textAlign: 'right' }}>Readings</th><th>Overnight</th></tr></thead>
              <tbody>
                {[...hourBars].reverse().map((d) => (
                  <tr key={d.key}>
                    <td>{d.key.replace('T', '  ')}:00</td>
                    <td className="num">{d.observed ? d.value.toFixed(0) : '—'}</td>
                    <td className="num">{d.observed ? '' : 'no data'}</td>
                    <td>{d.highlight ? 'yes' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            <BarChart
              data={hourBars}
              height={210}
              formatTip={(d) => (d.observed ? `${d.key.replace('T', ' ')}:00 — ${d.value.toFixed(0)} gal` : `${d.key.replace('T', ' ')}:00 — no data`)}
            />
            <div className="w-legend-note">
              <span><span className="w-swatch series" />Gallons used</span>
              <span><span className="w-swatch nodata" />No data</span>
              <span><span className="w-swatch band" />Overnight window</span>
            </div>
          </>
        )}
      </div>

      <div className="ha-card">
        <div className="ha-card-head">
          <h3 className="ha-card-title">Gallons per day</h3>
          <span>
            {DAY_RANGES.map((d) => (
              <button
                key={d}
                type="button"
                className={'btn' + (d === days && !period ? ' primary' : '')}
                style={{ marginLeft: 6 }}
                onClick={() => { setPeriod(null); setDays(d); }}
              >
                {d}d
              </button>
            ))}
            <span className="w-range-sep" aria-hidden="true" />
            {MONTH_RANGES.map((mr) => (
              <button
                key={mr.key}
                type="button"
                className={'btn' + (period === mr.key ? ' primary' : '')}
                style={{ marginLeft: 6 }}
                onClick={() => setPeriod(mr.key)}
              >
                {mr.label}
              </button>
            ))}
          </span>
        </div>
        <p className="ha-card-sub">
          A slow leak is easiest to see here: the daily floor creeps up and never comes back down.
          {/* The RESOLVED range, always spelled out. "Last month" is ambiguous on the 1st, and a
              part-month set beside a whole one is the classic false comparison: 24 days of August
              against all of July reads as a 23% drop that is nothing but the calendar. The Daily
              average tile already excludes today for the same reason, one level down. */}
          {daily && daily.range ? (
            <> <b>{daily.range.label}</b>{' '}
              <span className="muted">
                ({daily.range.from.slice(5)} – {daily.range.to.slice(5)}
                {daily.range.partial ? ', so far' : ''})
              </span>
              {daily.range.partial
                ? <span className="w-partial"> Part month — not comparable to a full one.</span>
                : null}
            </>
          ) : null}
        </p>
        <BarChart
          data={dayBars}
          height={190}
          formatTip={(d) => (d.observed ? `${d.key} — ${d.value.toFixed(0)} gal` : `${d.key} — no data`)}
        />
      </div>
    </div>
  );
}
