import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import './water.css';

// Meters — the registry, and the only place a meter's operator-owned fields can be edited.
//
// Everything else in water_meters is written by the collector from what it actually heard, and is
// shown here read-only. first_heard is a fact, not a preference.
//
// The one rule this page exists to make visible: DETECTION and DELIVERY are separate. Every meter
// with stored readings has the leak rules run over it; only a meter with `notify` on will ever
// email anyone. A neighbour's meter defaults to detection-only and needs its own address before it
// can be switched on at all — otherwise its alerts would fall through to the global list and start
// arriving in your inbox at 3am, which nobody would guess had been configured.

function Row({ m, ownEmail, emailEnabled, onSaved }) {
  const [label, setLabel] = useState(m.label || '');
  const [notify, setNotify] = useState(!!m.notify);
  const [email, setEmail] = useState(m.notify_email || '');
  const [scale, setScale] = useState(String(m.gallons_per_unit));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  // Re-seed when the server sends a fresh list, but never while the user is mid-edit — a poll that
  // overwrites a half-typed address is the kind of thing that makes people stop trusting a form.
  useEffect(() => {
    if (busy) return;
    setLabel(m.label || '');
    setNotify(!!m.notify);
    setEmail(m.notify_email || '');
    setScale(String(m.gallons_per_unit));
  }, [m.meter_id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = (m.label || '') !== label
    || !!m.notify !== notify
    || (m.notify_email || '') !== email
    || String(m.gallons_per_unit) !== scale;

  async function save() {
    setBusy(true); setMsg(null);
    const r = await api.waterSaveMeter(m.meter_id, {
      label, notify, notify_email: email, gallons_per_unit: Number(scale),
    });
    setBusy(false);
    if (r.status === 200 && r.body.ok) { setMsg({ ok: true, text: 'Saved' }); onSaved(r.body.meters); }
    else setMsg({ ok: false, text: r.body.error || 'Could not save' });
  }

  async function test() {
    setBusy(true); setMsg(null);
    const r = await api.waterTestMeterEmail(m.meter_id);
    setBusy(false);
    if (r.status !== 200 || !r.body.ok) { setMsg({ ok: false, text: r.body.error || 'Request failed' }); return; }
    const b = r.body;
    if (!b.sent) { setMsg({ ok: false, text: b.error || 'Not sent' }); return; }
    // Name the addresses. "Sent" with a silently rejected recipient is the failure this whole
    // section exists to make impossible to miss.
    setMsg({
      ok: !b.rejected.length,
      text: b.rejected.length
        ? 'Sent to ' + b.accepted.join(', ') + ' — REJECTED: ' + b.rejected.join(', ')
        : 'Sent to ' + (b.accepted.join(', ') || b.to),
    });
  }

  const effective = email.trim() || ownEmail;

  return (
    <div className={'w-meter-row' + (m.owned ? ' owned' : '')}>
      <div className="w-meter-head">
        <span className="w-meter-id">{m.meter_id}</span>
        {m.owned ? <span className="w-pill sent">mine</span> : <span className="w-pill watched">observed</span>}
        {m.model ? <span className="muted small">{m.model}</span> : null}
        <span className="muted small">
          {m.packets_seen.toLocaleString()} packets
          {m.last_heard_mtn ? ' · last heard ' + m.last_heard_mtn : ''}
        </span>
      </div>

      <div className="w-meter-grid">
        <label>
          <span className="w-field-label">Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)}
                 placeholder="(none — the id is the name)" />
          <span className="w-field-help">Optional. Only worth setting if you have a name a person chose.</span>
        </label>

        <label>
          <span className="w-field-label">Gallons per unit</span>
          <input value={scale} onChange={(e) => setScale(e.target.value)} inputMode="decimal" />
          <span className="w-field-help">
            Classic Orion counts 1 gal, newer endpoints 0.1. The wrong value is a silent 10× error
            that looks entirely plausible on a chart.
          </span>
        </label>

        <label className="w-meter-notify">
          <span className="w-field-label">Deliver alerts</span>
          <span className="w-check">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            <span>{notify ? 'Email / push this meter’s alerts' : 'Detect and record only — no email, no push'}</span>
          </span>
          <span className="w-field-help">
            The rules run either way. This decides whether anyone is told.
            {!m.owned && !email.trim()
              ? <b> Give this meter its own address first — without one its alerts would go to your inbox.</b>
              : null}
          </span>
        </label>

        <label>
          <span className="w-field-label">Send to</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)}
                 placeholder={ownEmail ? ownEmail + '  (the default list)' : '(no default configured)'} />
          <span className="w-field-help">
            Comma-separate for several. Blank falls back to the global list in{' '}
            <Link to="/water/settings#alert_email_to">Settings</Link>
            {effective ? <> — currently <b>{effective}</b></> : null}.
          </span>
        </label>
      </div>

      <div className="w-meter-actions">
        <button className="btn primary" onClick={save} disabled={busy || !dirty}>
          {busy ? 'Working…' : dirty ? 'Save' : 'Saved'}
        </button>
        <button className="btn" onClick={test} disabled={busy || !emailEnabled}
                title={emailEnabled
                  ? 'Send a test to exactly the addresses this meter’s alerts would use'
                  : 'Email alerts are switched off in Settings'}>
          Send test email
        </button>
        {msg ? <span className={msg.ok ? 'w-meter-ok' : 'err'}>{msg.text}</span> : null}
      </div>
    </div>
  );
}

export default function Meters() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    api.waterMeters().then((r) => {
      if (!live) return;
      if (r.status === 200 && r.body.ok) setData(r.body);
      else setErr(r.body.error || 'Could not load meters');
    });
    return () => { live = false; };
  }, []);

  if (err) return <div className="page"><p className="err">{err}</p></div>;
  if (!data) return <div className="loading">Loading…</div>;

  return (
    <div className="page w-root">
      <h2>Meters</h2>
      <p className="muted">
        Every endpoint the receiver has decoded. <b>Detection and delivery are separate:</b> the leak
        rules run over every meter with stored readings, but only a meter with delivery switched on
        will ever email anyone.
      </p>

      {!data.email_enabled ? (
        <p className="w-chart-sub">
          <b>Email alerts are switched off</b> for the whole module, so nothing below will send
          regardless of these settings. Turn it on in{' '}
          <Link to="/water/settings#alert_email_enabled">Settings → Alerts</Link>.
        </p>
      ) : null}

      {data.meters.map((m) => (
        <Row
          key={m.meter_id}
          m={m}
          ownEmail={data.default_email_to}
          emailEnabled={data.email_enabled}
          onSaved={(meters) => setData((d) => ({ ...d, meters }))}
        />
      ))}

      {!data.meters.length ? (
        <div className="card"><h3>No meters yet</h3>
          <p className="muted">The registry fills in as the radio decodes. Check Diagnostics if this
            stays empty for more than a minute.</p>
        </div>
      ) : null}
    </div>
  );
}
