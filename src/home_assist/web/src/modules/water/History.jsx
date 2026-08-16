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

export default function History() {
  const [hours, setHours] = useState(48);
  const [days, setDays] = useState(30);
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
    api.waterDaily(days, sel).then((r) => { if (r.status === 200 && r.body.ok) setDaily(r.body); });
  }, [days, sel]);

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

      <div className="w-chart-card">
        <div className="w-chart-head">
          <h3 className="w-chart-title">Gallons per hour</h3>
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
        <p className="w-chart-sub">Shaded = the overnight window ({win[0]}:00–{win[1]}:00).</p>

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

      <div className="w-chart-card">
        <div className="w-chart-head">
          <h3 className="w-chart-title">Gallons per day</h3>
          <span>
            {DAY_RANGES.map((d) => (
              <button
                key={d}
                type="button"
                className={'btn' + (d === days ? ' primary' : '')}
                style={{ marginLeft: 6 }}
                onClick={() => setDays(d)}
              >
                {d}d
              </button>
            ))}
          </span>
        </div>
        <p className="w-chart-sub">
          A slow leak is easiest to see here: the daily floor creeps up and never comes back down.
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
