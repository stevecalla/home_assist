import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import MeterPicker from './MeterPicker.jsx';
import { useMeterSel } from './meterSel.js';
import './water.css';

// Alert history. Every alert the collector decided to send, and — crucially — whether it actually
// got through. "We fired an alert" and "you received an alert" are different facts, and a monitor
// that conflates them is lying to you.
//
// Since observed meters are watched too, there is now a THIRD state that must not be confused with
// the other two: raised, recorded, and deliberately not delivered. "✕ not sent" beside a failed
// SMTP handshake and "✕ not sent" beside a neighbour's alert look identical and mean opposite
// things — one is a broken channel, the other is the system working as designed. Hence `watched`.
const KIND_LABEL = {
  overnight: 'Overnight flow',
  continuous: 'Continuous flow',
  stale: 'Receiver silent',
  summary: 'Daily summary',
  run: 'Continuous run',
  test: 'Test',
};

function delivery_of(a) {
  if (a.delivered) return { cls: 'sent', text: '✓ sent' };
  // The collector writes this exact phrase when notify is off for the meter. Matching on it beats
  // adding a column: the note is already the authoritative record of what happened.
  if (a.delivery_note && a.delivery_note.indexOf('notify is off') !== -1) {
    return { cls: 'watched', text: '◉ recorded only' };
  }
  return { cls: 'failed', text: '✕ not sent' };
}

export default function Alerts() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [ownId, setOwnId] = useState(null);
  // The same selection the rest of the panel uses. "All meters" is meaningful here — unlike a usage
  // chart, two meters' alerts can sit in one list without being summed into something untrue.
  const [sel, setSel] = useMeterSel();
  const selId = /^[0-9]+$/.test(sel) ? Number(sel) : null;

  useEffect(() => {
    let live = true;
    api.waterAlerts(100, sel).then((r) => {
      if (!live) return;
      if (r.status === 200 && r.body.ok) { setRows(r.body.alerts); setOwnId(r.body.own_meter_id); setErr(''); }
      else setErr(r.body.error || 'Could not load alerts');
    });
    return () => { live = false; };
  }, [sel]);

  if (err) return <div className="page"><p className="err">{err}</p></div>;

  return (
    <div className="page w-root">
      <h2>Alert history</h2>
      <p className="muted">
        Every alert the collector raised. <b>Sent</b> means a channel accepted it — not that you read it.
      </p>

      <div className="w-rangebar">
        <span className="w-range-label">Meter</span>
        <MeterPicker sel={sel} setSel={setSel} ownId={ownId} />
      </div>

      {selId !== null && ownId !== null && selId !== ownId ? (
        <p className="muted small">
          {selId} is an <b>observed</b> meter: the same rules run over its data and the results are
          recorded here, but nothing is emailed or pushed. Detection and delivery are separate on
          purpose — a stranger&apos;s shower should never wake you.
        </p>
      ) : null}

      {!rows ? <div className="loading">Loading…</div> : !rows.length ? (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>No alerts</h3>
          <p className="muted">
            {selId !== null && ownId !== null && selId !== ownId
              ? 'Nothing has tripped a rule for this meter in the stored history.'
              : 'Which is the outcome you want.'}
            {' '}If you have never seen one, send a test from
            {' '}<b>Water → Settings</b> so you know the channel works before it matters.
          </p>
        </div>
      ) : (
        <div className="w-chart-card">
          <table className="w-table stack">
            <thead>
              <tr>
                <th>When (local)</th>
                {/* Only shown on "all meters" — a column repeating the same id on every row of a
                    filtered list is noise, and it is the one place it carries no information. */}
                {sel === 'all' ? <th>Meter</th> : null}
                <th>Signal</th>
                <th>Delivered</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const d = delivery_of(a);
                return (
                  <tr key={a.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{a.fired_at_local}</td>
                    {sel === 'all' ? (
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <span className={a.is_ours ? 'w-id-mine' : 'w-id-other'}>
                          {a.meter_id}{a.is_ours ? <span className="w-pill sent">mine</span> : null}
                        </span>
                      </td>
                    ) : null}
                    <td>{KIND_LABEL[a.kind] || a.kind}</td>
                    <td><span className={'w-pill ' + d.cls}>{d.text}</span></td>
                    <td>
                      {a.message}
                      {a.delivery_note && !a.delivered
                        ? <div className="muted small" style={{ marginTop: 3 }}>{a.delivery_note}</div>
                        : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
