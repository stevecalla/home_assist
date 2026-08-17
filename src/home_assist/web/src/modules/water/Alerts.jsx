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

// The numbers behind the sentence.
//
// "Continuous flow: water every hour for 6h (43 gal). Nothing normal does that." is a conclusion.
// Every figure it was computed from is already in water_alerts.detail and was simply never shown,
// so the only way to check the claim was to go and query the hourly table yourself. An alert you
// cannot check is one you either believe blindly or learn to ignore.
//
// Collapsed by default: the sentence is the message, this is the evidence you open when you want it.
const DETAIL_LABEL = {
  total: 'Total in the window',
  threshold: 'Threshold that was crossed',
  hours: 'Hours in a row',
  min_per_hour: 'Counted as "flowing" at or above',
  hours_missing: 'Hours with no reading',
  day: 'Local day',
  minutes: 'Minutes without a break',
  gallons: 'Gallons in the run',
  rate: 'Rate',
  trigger: 'What tripped it',
  alarm_min: 'Alarm after (minutes)',
  alarm_gal: 'Alarm after (gallons)',
  truncated: 'Run may have started earlier than shown',
  quiet_minutes: 'Minutes of silence',
  stale_minutes: 'Silence allowed before alerting',
  never_decoded: 'Never decoded a packet',
  running_minutes: 'Collector had been up (minutes)',
};
const DETAIL_UNIT = {
  total: 'gal', threshold: 'gal', gallons: 'gal', min_per_hour: 'gal/h',
  alarm_gal: 'gal', minutes: 'min', alarm_min: 'min',
  quiet_minutes: 'min', stale_minutes: 'min', running_minutes: 'min', hours: 'h',
};

function fmt_val(k, v) {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  if (typeof v === 'number') {
    const n = Number.isInteger(v) ? String(v) : v.toFixed(1);
    return DETAIL_UNIT[k] ? n + ' ' + DETAIL_UNIT[k] : n;
  }
  return String(v);
}

function AlertDetail({ detail }) {
  if (!detail || typeof detail !== 'object') return null;
  const per_hour = Array.isArray(detail.per_hour) ? detail.per_hour : null;
  // `keys` is the raw hour-key list per_hour supersedes; requested_by is noise on a test push.
  const scalars = Object.keys(detail).filter((k) => {
    if (k === 'per_hour' || k === 'keys') return false;
    const v = detail[k];
    return v !== null && v !== undefined && typeof v !== 'object';
  });
  if (!scalars.length && !per_hour) return null;

  return (
    <details className="w-alert-detail">
      <summary>Show the numbers</summary>
      {scalars.length ? (
        <table className="w-table small">
          <tbody>
            {scalars.map((k) => (
              <tr key={k}>
                <td className="muted">{DETAIL_LABEL[k] || k.replace(/_/g, ' ')}</td>
                <td className="num">{fmt_val(k, detail[k])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {per_hour ? (
        <table className="w-table small" style={{ marginTop: 8 }}>
          <thead><tr><th>Hour (local)</th><th style={{ textAlign: 'right' }}>Gallons</th></tr></thead>
          <tbody>
            {per_hour.map((h) => (
              <tr key={h.hour}>
                <td style={{ whiteSpace: 'nowrap' }}>{String(h.hour).replace('T', '  ')}:00</td>
                {/* An em dash, never a 0. "No reading" and "no water" are opposite conclusions and
                    this is the table where someone decides whether to go and look at the basement. */}
                <td className="num">{h.gallons === null ? '—' : h.gallons.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </details>
  );
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
                      <AlertDetail detail={a.detail} />
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
