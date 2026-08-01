import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import BarChart from './BarChart.jsx';
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
  const [rx, setRx] = useState(null);
  // Ticks every second purely so "3s ago" counts up smoothly between polls. Without it the number
  // freezes for 5 seconds at a time and looks stuck — which on THIS card is the exact wrong message.
  const [, setNowTick] = useState(0);

  useEffect(() => {
    api.waterRaw(20).then((r) => { if (r.status === 200 && r.body.ok) setRaw(r.body.samples); });
    api.waterReadings(40).then((r) => { if (r.status === 200 && r.body.ok) setReadings(r.body.readings); });

    const loadRx = () => api.waterReception(60).then((r) => {
      if (r.status === 200 && r.body.ok) setRx(r.body);
    });
    loadRx();
    const poll = setInterval(loadRx, 5000);
    const clock = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => { clearInterval(poll); clearInterval(clock); };
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


      {/* ── the live one ─────────────────────────────────────────────────────────── */}
      <div className="w-chart-card">
        <div className="w-chart-head">
          <h3 className="w-chart-title">Reception — is the radio hearing your meter?</h3>
          {rx ? <RxBadge seconds={rx.seconds_since_last} /> : null}
        </div>
        <p className="w-chart-sub">
          One bar per minute, counting packets from <strong>your</strong> meter. This is written to{' '}
          <code>water_reception</code> continuously and kept for weeks — unlike the raw lines below,
          which stop after the first 20 of each run by design. <strong>A gap here is real:</strong>{' '}
          it means the radio genuinely heard nothing that minute.
        </p>

        {!rx ? <p className="muted">Loading…</p> : !rx.series.length ? (
          <p className="muted">
            No reception rows yet. The collector writes one a minute — the first appears within 60
            seconds of it starting.
          </p>
        ) : (
          <>
            <BarChart
              data={rx.series.map((m) => ({
                key: m.minute_utc,
                label: String(m.minute_mtn || '').slice(11, 16),
                value: m.packets_ours,
                observed: true,
              }))}
              height={140}
              unit="packets"
              formatTip={(d) => d.label + ' · ' + d.value + ' packets'}
              emptyMessage="No reception rows yet."
            />
            <RxStats series={rx.series} />
          </>
        )}
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

// "Heard 3s ago" — the number you watch while moving an antenna. Green under a minute, because the
// meter broadcasts every ~4s and anything past 60s means something changed.
function RxBadge({ seconds }) {
  if (seconds === null || seconds === undefined) {
    return <span className="w-live-badge idle"><span className="w-dot-live" />Never heard</span>;
  }
  const good = seconds <= 60;
  return (
    <span className={'w-live-badge ' + (good ? 'flowing' : 'idle')}>
      <span className="w-dot-live" aria-hidden="true" />
      {good ? 'Heard ' + seconds + 's ago' : 'Silent ' + Math.round(seconds / 60) + 'm'}
    </span>
  );
}

// The numbers you actually tune an antenna against. rssi/snr are only present when -M level is in
// WATER_RTL433_ARGS; say so rather than showing an empty column nobody can explain.
function RxStats({ series }) {
  const mins = series.length;
  const ours = series.reduce((a, m) => a + m.packets_ours, 0);
  const total = series.reduce((a, m) => a + m.packets_total, 0);
  const dead = series.filter((m) => m.packets_ours === 0).length;
  const withRssi = series.filter((m) => m.rssi_avg !== null);
  const rssi = withRssi.length ? withRssi.reduce((a, m) => a + m.rssi_avg, 0) / withRssi.length : null;
  const withSnr = series.filter((m) => m.snr_avg !== null);
  const snr = withSnr.length ? withSnr.reduce((a, m) => a + m.snr_avg, 0) / withSnr.length : null;
  const others = [...new Set(series.map((m) => m.other_ids).filter(Boolean))].join(' ');

  return (
    <div className="w-rx-stats">
      <span><b>{(ours / Math.max(1, mins)).toFixed(1)}</b> packets/min from your meter</span>
      <span><b>{ours}</b> of {total} heard were yours</span>
      <span className={dead ? 'bad' : ''}><b>{dead}</b> minute{dead === 1 ? '' : 's'} with none</span>
      {snr !== null
        ? <span>SNR <b>{snr.toFixed(1)} dB</b>{rssi !== null ? ' · RSSI ' + rssi.toFixed(1) : ''}</span>
        : <span className="muted">signal strength needs <code>-M level</code> in the rtl_433 args</span>}
      {others ? <span className="muted">also hearing {others}</span> : null}
    </div>
  );
}
