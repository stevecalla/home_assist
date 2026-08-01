import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import './water.css';

// Alert history. Every alert the collector decided to send, and — crucially — whether it actually
// got through. "We fired an alert" and "you received an alert" are different facts, and a monitor
// that conflates them is lying to you.
const KIND_LABEL = {
  overnight: 'Overnight flow',
  continuous: 'Continuous flow',
  stale: 'Receiver silent',
  summary: 'Daily summary',
  test: 'Test',
};

export default function Alerts() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.waterAlerts(100).then((r) => {
      if (r.status === 200 && r.body.ok) setRows(r.body.alerts);
      else setErr(r.body.error || 'Could not load alerts');
    });
  }, []);

  if (err) return <div className="page"><p className="err">{err}</p></div>;
  if (!rows) return <div className="loading">Loading…</div>;

  return (
    <div className="page w-root">
      <h2>Alert history</h2>
      <p className="muted">
        Every alert the collector raised. <b>Sent</b> means a channel accepted it — not that you read it.
      </p>

      {!rows.length ? (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>No alerts</h3>
          <p className="muted">
            Which is the outcome you want. If you have never seen one, send a test from
            {' '}<b>Water → Settings</b> so you know the channel works before it matters.
          </p>
        </div>
      ) : (
        <div className="w-chart-card">
          <table className="w-table stack">
            <thead>
              <tr>
                <th>When (local)</th>
                <th>Signal</th>
                <th>Delivered</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{a.fired_at_local}</td>
                  <td>{KIND_LABEL[a.kind] || a.kind}</td>
                  <td>
                    <span className={'w-pill ' + (a.delivered ? 'sent' : 'failed')}>
                      {a.delivered ? '✓ sent' : '✕ not sent'}
                    </span>
                  </td>
                  <td>
                    {a.message}
                    {a.delivery_note && !a.delivered
                      ? <div className="muted small" style={{ marginTop: 3 }}>{a.delivery_note}</div>
                      : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
