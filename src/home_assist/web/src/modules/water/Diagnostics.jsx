import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import './water.css';

// Diagnostics — the page you open when the numbers look wrong.
//
// Two questions it answers, both of which otherwise require SSH-ing into the Ubuntu box:
//   1. Is the decoder emitting the field names ingest.js expects? (the raw lines)
//   2. Are individual readings landing, and with what deltas? (the recent readings table)
//
// Both live behind water-admin rather than water, because raw packets are noise for a normal look.

// The stored `reason` values are terse database enums. `sample` in particular reads as "sample
// DATA" — i.e. fake — when it means "a sample OF the live feed", which is the opposite of what a
// worried person wants to conclude at 2am. Render plain English and never show the raw enum.
const REASON = {
  sample: { label: 'heard it', good: true, help: 'A real packet from your meter, captured so you can see the field names.' },
  other_meter: { label: 'other meter', good: null, help: "A neighbour's endpoint. Ignored on purpose." },
  no_volume: { label: 'could not read', good: false, help: 'Decoded, but no volume field we recognise. This is a bug — the decoder renamed a field.' },
  rejected: { label: 'rejected', good: false, help: 'Failed a plausibility check (went backwards, or jumped further than plumbing allows).' },
};
function reason_of(r) { return REASON[r] || { label: r, good: null, help: '' }; }
export default function Diagnostics() {
  const [raw, setRaw] = useState(null);
  const [readings, setReadings] = useState(null);
  const [emailCheck, setEmailCheck] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.waterRaw(20).then((r) => { if (r.status === 200 && r.body.ok) setRaw(r.body.samples); });
    api.waterReadings(40).then((r) => { if (r.status === 200 && r.body.ok) setReadings(r.body.readings); });
  }, []);

  async function checkEmail() {
    setBusy(true);
    const r = await api.waterEmailCheck();
    setBusy(false);
    setEmailCheck(r.status === 200 && r.body.ok ? r.body : { email: { ok: false, error: 'request failed' } });
  }

  return (
    <div className="page w-root">
      <h2>Diagnostics</h2>
      <p className="muted">For when the numbers look wrong and you need to see the plumbing.</p>

      <div className="w-chart-card">
        <div className="w-chart-head"><h3 className="w-chart-title">Email channel</h3></div>
        <p className="w-chart-sub">
          Verifies the SMTP credentials without sending anything. A leak alert that cannot be
          delivered is not an alert.
        </p>
        <button className="btn" onClick={checkEmail} disabled={busy}>{busy ? 'Checking…' : 'Verify SMTP'}</button>
        {emailCheck ? (
          <p style={{ marginTop: 12 }}>
            {emailCheck.email.ok
              ? <span style={{ color: 'var(--w-good)', fontWeight: 600 }}>✓ SMTP connected</span>
              : <span className="err">✕ {emailCheck.email.error}</span>}
            {emailCheck.config ? (
              <span className="muted small" style={{ marginLeft: 12 }}>
                {emailCheck.config.sender || '(no EMAIL_SENDER)'} via {emailCheck.config.host}:{emailCheck.config.port}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>

      <div className="w-chart-card">
        <div className="w-chart-head"><h3 className="w-chart-title">Raw decoder output</h3></div>
        <p className="w-chart-sub">
          The actual packets your meter broadcast, exactly as the radio decoded them — <strong>real
          data, not test data</strong>. The collector keeps the first 20 of each run so you can check
          one thing: does every line contain <code>volume_gal</code>? That is the field
          {' '}<code>collector/ingest.js</code> reads. If it is missing or renamed, every packet gets
          discarded and the dashboard looks dead while the radio works perfectly. That exact bug cost
          us a night.
        </p>
        {raw && raw.length ? (
          <p className="w-chart-sub small">
            {Object.entries(REASON)
              .filter(([k]) => raw.some((s) => s.reason === k))
              .map(([k, v]) => (
                <span key={k} style={{ marginRight: 16, whiteSpace: 'nowrap' }}>
                  <span style={{ color: v.good === true ? 'var(--w-good)' : v.good === false ? 'var(--w-critical)' : 'inherit', fontWeight: 600 }}>
                    {v.good === true ? '✓' : v.good === false ? '✕' : '·'} {v.label}
                  </span>
                  <span className="muted"> — {v.help}</span>
                </span>
              ))}
          </p>
        ) : null}
        {!raw ? <p className="muted">Loading…</p> : !raw.length ? (
          <p className="muted">
            Nothing captured yet. The collector logs its first 20 lines on each start —
            restart it, or run <code>node src/home_assist/modules/water/capture.js</code>.
          </p>
        ) : (
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            <table className="w-table">
              <thead><tr><th>Seen (UTC)</th><th>What happened</th><th>Line</th></tr></thead>
              <tbody>
                {raw.map((s) => {
                  const r = reason_of(s.reason);
                  return (
                    <tr key={s.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{s.seen_at_utc}</td>
                      <td style={{ whiteSpace: 'nowrap', color: r.good === false ? 'var(--w-critical)' : 'inherit', fontWeight: r.good === false ? 600 : 400 }}>
                        {r.good === true ? '✓ ' : r.good === false ? '✕ ' : ''}{r.label}
                      </td>
                      <td><code style={{ fontSize: 11, wordBreak: 'break-all' }}>{s.line}</code></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="w-chart-card">
        <div className="w-chart-head"><h3 className="w-chart-title">Recent accepted readings</h3></div>
        <p className="w-chart-sub">
          A row here means <strong>water was actually used</strong>. The meter broadcasts constantly,
          but it only reports a bigger number when gallons have gone through it — so this table stays
          empty during a quiet night and that is the correct, healthy result.
        </p>
        {!readings ? <p className="muted">Loading…</p> : !readings.length ? (
          // An empty table is ambiguous on its own — it means "nobody ran a tap" or "we are deaf".
          // The card above already knows which, so say it here rather than making them cross-check.
          <p className="muted">
            <strong>No water used yet.</strong>{' '}
            {raw && raw.length
              ? 'The card above shows packets arriving, so the radio is fine — the meter\'s odometer simply has not moved since the collector started. Run a tap for a minute and a row will appear here.'
              : 'No packets above either, so the radio is not hearing the meter — start there, not here.'}
          </p>
        ) : (
          <div style={{ maxHeight: 380, overflow: 'auto' }}>
            <table className="w-table">
              <thead><tr><th>When (local)</th><th style={{ textAlign: 'right' }}>Odometer</th><th style={{ textAlign: 'right' }}>Delta</th></tr></thead>
              <tbody>
                {readings.map((r, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.read_at_mtn}</td>
                    <td className="num">{Number(r.gallons).toLocaleString()}</td>
                    <td className="num">+{Number(r.delta_gallons).toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
