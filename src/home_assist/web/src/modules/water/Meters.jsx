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

// ── one alert, as a disclosure ──────────────────────────────────────────────────────────────────
//
// COLLAPSED it answers "what is this and is it on". EXPANDED it answers "and what exactly will it
// send me", with the message itself rather than a description of it.
//
// A checkbox per alert was the obvious design and the wrong one. "Daily summary ☑" asks you to
// decide about something you have never read; a row you can open and read first is the difference
// between configuring and guessing. That the answer is the REAL email — built by the same
// build_email() the collector calls, at this meter's real settings and this month's real totals —
// is the whole point. A written-out sample would drift from the mail within a release and be
// believed anyway.
//
// Closed by default, all of them. Six alerts opened at once is a wall of text on the page you go to
// when you want to rename a meter.
function AlertRow({ a, meterId, canSend, onToggle, busy }) {
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState(null);

  async function sendOne() {
    setSending(true); setMsg(null);
    const r = await api.waterSendMeterAlert(meterId, a.key);
    setSending(false);
    if (r.status !== 200 || !r.body.ok) { setMsg({ ok: false, text: r.body.error || 'Request failed' }); return; }
    const b = r.body;
    if (!b.sent) { setMsg({ ok: false, text: b.error || 'Not sent' }); return; }
    setMsg({
      ok: !b.rejected.length,
      text: b.rejected.length
        ? 'Sent — REJECTED: ' + b.rejected.join(', ')
        : 'Sent to ' + (b.accepted.join(', ') || b.to),
    });
  }

  const label = { on: 'On', off: 'Off', always: 'Always' }[a.state];

  return (
    <details className="w-alert-row">
      <summary>
        <span className="w-alert-caret" aria-hidden="true">▸</span>
        <span className="w-alert-name">{a.label}</span>
        <span className={'w-alert-state ' + a.state}>{label}</span>
        <span className="w-alert-freq">{frequency(a)}</span>
      </summary>

      <div className="w-alert-body">
        <dl className="w-alert-facts">
          <dt>When</dt>
          <dd>
            {a.when}
            {/* THE NUMBERS, not the setting names. The catalog's `when` is written for the
                Reference page and says things like "No meter reading for stale_minutes" — true,
                and useless for deciding whether the value is right, because the value is the one
                thing it does not contain. Each setting is printed with what it is set to AND what
                it ships as, since "60 minutes" cannot tell you whether anyone ever tuned it. */}
            {a.settings.length ? (
              <ul className="w-alert-sets">
                {a.settings.map((s) => (
                  <li key={s.name} title={s.help || undefined}>
                    {s.label}: <b>{fmtSetting(s)}</b>
                    {String(s.value) === String(s.default)
                      ? <span className="muted"> (the default)</span>
                      : <span className="muted"> (default {fmtSetting(s, s.default)})</span>}
                  </li>
                ))}
              </ul>
            ) : null}
          </dd>

          <dt>Goes to</dt>
          <dd>{canSend ? <b>{a.to}</b> : <span className="muted">nobody — see above</span>}</dd>

          <dt>How often</dt>
          <dd>{frequencyLong(a)}</dd>
        </dl>

        {a.state === 'always' ? (
          <p className="w-alert-note">
            <b>No switch, deliberately.</b> {a.why}
          </p>
        ) : null}

        {a.preview ? (
          <>
            <div className="w-preview-label">
              What it sends — built by the code that sends it, at this meter’s settings
            </div>
            <div className="w-preview">
              <span className="sub">{a.preview.subject}</span>
              {a.preview.text}
            </div>
          </>
        ) : (
          <p className="w-alert-note">
            No preview: this alert cannot be built at the current settings. That usually means the
            rule is switched off in Settings rather than here.
          </p>
        )}

        <div className="w-alert-actions">
          {a.state === 'always' ? (
            <button className="btn" disabled title="The watchdog cannot be switched off">Always on</button>
          ) : (
            <button className={'btn' + (a.state === 'off' ? ' primary' : '')}
                    onClick={() => onToggle(a.key, a.state === 'on')} disabled={busy}>
              {a.state === 'on' ? 'Turn off' : 'Turn on'}
            </button>
          )}
          <button className="btn" onClick={sendOne} disabled={sending || !canSend}
                  title={canSend
                    ? 'Send exactly this message, now, to the address above'
                    : 'Delivery is off for this meter, or email is off for the module'}>
            {sending ? 'Sending…' : 'Send this one to me now'}
          </button>
          {msg ? <span className={msg.ok ? 'w-meter-ok' : 'err'}>{msg.text}</span> : null}
        </div>
      </div>
    </details>
  );
}

// A value with its unit. Hours-of-the-day read as clock times because that is what they are:
// "Overnight window starts: 2 o'clock" beats "2".
function fmtSetting(s, override) {
  const v = override === undefined ? s.value : override;
  if (v === null || v === undefined || v === '') return '—';
  return s.unit ? v + ' ' + s.unit : String(v);
}

function fmtDur(min) {
  const m = Number(min) || 0;
  if (m < 60) return m + ' minutes';
  const h = Math.round(m / 60);
  return h === 24 ? 'a day' : h + ' hours';
}

function frequency(a) {
  if (a.key === 'summary') return 'once a day';
  return 'at most once every ' + fmtDur(a.cooldown_min);
}

function frequencyLong(a) {
  if (a.key === 'summary') {
    return 'Once a day, whether anything happened or not. This is the proof-of-life email: if it '
      + 'stops arriving, the alerting path itself has broken.';
  }
  return 'At most once every ' + fmtDur(a.cooldown_min) + ', however long the condition lasts.';
}

// The alerts block under one meter. Loaded on first open rather than with the page: it runs the
// leak rules and formats six emails per meter, and the common reason to be on this page is to
// rename something.
function MeterAlerts({ m, emailEnabled, notify, to, onChanged }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || data) return;
    let live = true;
    api.waterMeterAlerts(m.meter_id).then((r) => {
      if (!live) return;
      if (r.status === 200 && r.body.ok) setData(r.body);
      else setErr(r.body.error || 'Could not load this meter’s alerts');
    });
    return () => { live = false; };
  }, [open, data, m.meter_id]);

  async function toggle(key, turningOff) {
    setBusy(true);
    const off = (data.alerts.filter((a) => a.state === 'off').map((a) => a.key));
    const next = turningOff ? off.concat([key]) : off.filter((k) => k !== key);
    const r = await api.waterSaveMeter(m.meter_id, { ...meterPatch(m), alerts_off: next });
    setBusy(false);
    if (r.status === 200 && r.body.ok) {
      // Re-read rather than patching state locally. The server is what decides whether a key is
      // suppressible, and a UI that assumes its own write succeeded exactly as sent is how a
      // silently-refused change looks like a working one.
      setData(null);
      onChanged(r.body.meters);
    } else setErr(r.body.error || 'Could not save');
  }

  // Everything the save endpoint needs to leave the OTHER fields alone. update() writes all of
  // them every time, so omitting one would blank it.
  function meterPatch(x) {
    return { meter_name: x.meter_name || '', notify: !!x.notify,
      notify_email: x.notify_email || '', gallons_per_unit: x.gallons_per_unit };
  }

  const canSend = emailEnabled && notify && !!to;

  return (
    <div className="w-alerts">
      <button type="button" className="w-alerts-toggle" onClick={() => setOpen((v) => !v)}
              aria-expanded={open}>
        <span className="w-alert-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        Alerts
        <span className="muted small">
          {open ? 'what each one sends, and whether it is on' : 'show what this meter sends'}
        </span>
      </button>

      {open ? (
        err ? <p className="err">{err}</p>
        : !data ? <p className="muted small">Loading…</p>
        : (
          <>
            <p className="muted small w-alerts-intro">
              Turning one off stops the <b>email</b>. The rule still runs and still records what it
              found, so the history and the Monitor stay honest either way.
              {!canSend ? (
                <b> Nothing here can send right now: {!emailEnabled
                  ? 'email is switched off for the whole module.'
                  : !notify ? 'delivery is off for this meter.' : 'this meter has no address.'}</b>
              ) : null}
            </p>
            {data.alerts.map((a) => (
              <AlertRow key={a.key} a={{ ...a, to: data.to }} meterId={m.meter_id}
                        canSend={canSend} onToggle={toggle} busy={busy} />
            ))}
          </>
        )
      ) : null}
    </div>
  );
}

function Row({ m, yours, ownEmail, emailEnabled, onSaved }) {
  const [name, setName] = useState(m.meter_name || '');
  const [notify, setNotify] = useState(!!m.notify);
  const [email, setEmail] = useState(m.notify_email || '');
  const [scale, setScale] = useState(String(m.gallons_per_unit));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  // Re-seed when the server sends a fresh list, but never while the user is mid-edit — a poll that
  // overwrites a half-typed address is the kind of thing that makes people stop trusting a form.
  useEffect(() => {
    if (busy) return;
    setName(m.meter_name || '');
    setNotify(!!m.notify);
    setEmail(m.notify_email || '');
    setScale(String(m.gallons_per_unit));
  }, [m.meter_id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = (m.meter_name || '') !== name
    || !!m.notify !== notify
    || (m.notify_email || '') !== email
    || String(m.gallons_per_unit) !== scale;

  async function save() {
    setBusy(true); setMsg(null);
    const r = await api.waterSaveMeter(m.meter_id, {
      meter_name: name, notify, notify_email: email, gallons_per_unit: Number(scale),
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
        {m.meter_name ? <span className="w-meter-name">{m.meter_name}</span> : null}
        <span className="w-meter-id">{m.meter_id}</span>
        {/* Ownership badges, NOT the delivery pills used on the Alerts page -- same shape there
            meant green "mine" and green "sent" were the same chip saying different things. */}
        {m.owned
          ? <span className="w-own mine">mine</span>
          : <span className={'w-own ' + (m.notify ? 'alerting' : 'observed')}>
              {m.notify ? 'alerting' : 'observed'}
            </span>}
        {/* Two different facts, so two different words. "mine" is the COLLECTOR's meter — a fact
            about the radio, identical for everyone. "yours" is the meter "This meter" lands on for
            the person reading this — a fact about their access. They coincide unless someone has
            been restricted, which is exactly when saying only "mine" would mislead. */}
        {yours && !m.owned
          ? <span className="w-own yours" title="“This meter” resolves here for you">yours</span>
          : null}
        {m.model ? <span className="muted small">{m.model}</span> : null}
        <span className="muted small">
          {m.packets_seen.toLocaleString()} packets
          {m.last_heard_mtn ? ' · last heard ' + m.last_heard_mtn : ''}
        </span>
      </div>

      <div className="w-meter-grid">
        <label>
          <span className="w-field-label">Meter name</span>
          <input value={name} onChange={(e) => setName(e.target.value)}
                 placeholder="(none — the id is the name)" />
          <span className="w-field-help">
            What you call it: “Front pit”, “Rental at 1214”. Shown beside the id in the picker and
            the page header — never instead of it, because the id is what you search the packet
            table by. Optional; blank is fine.
          </span>
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
            {/* Names the DESTINATION rather than guessing whose inbox it is. This read "would go to
                your inbox", which is written from the owner's chair: a neighbour reading their own
                meter row sees "your inbox" and takes it to mean theirs, so the warning states the
                opposite of what is true for the person most likely to be reading it. */}
            {!m.owned && !email.trim()
              ? <b> Give this meter its own address first — without one its alerts go to the global list.</b>
              : null}
          </span>
        </label>

        <label>
          <span className="w-field-label">Send to</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)}
                 placeholder={ownEmail ? ownEmail + '  (the default list)' : '(no default configured)'} />
          <span className="w-field-help">
            Comma-separate for several. Blank uses the global list in{' '}
            <Link to="/water/settings#alert_email_to">Settings</Link>.
          </span>
          {/* The RULE and the STATE, deliberately on separate lines.
              They used to share one sentence: "Blank falls back to the global list in Settings —
              currently X". X is this meter's OWN address whenever it has one, but the only noun
              near "currently" was "the global list" -- so a meter with its own address read as
              though the global setting had been changed to it. Someone chasing that would go and
              "fix" a Settings value that was never wrong.
              Now the destination is stated on its own line and always names where it came from,
              so "why this address?" is answered beside the address. */}
          {effective ? (
            <span className="w-field-help w-sendto">
              Alerts go to <b>{effective}</b>{' '}
              <span className="muted">({email.trim() ? 'this meter\u2019s own address' : 'the global list'})</span>
            </span>
          ) : (
            <span className="w-field-help w-sendto">
              <b>Nowhere</b> <span className="muted">(no address here and no global list set)</span>
            </span>
          )}
        </label>
      </div>

      <MeterAlerts m={m} emailEnabled={emailEnabled} notify={notify} to={effective}
                   onChanged={onSaved} />

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
        <p className="ha-card-sub">
          <b>Email alerts are switched off</b> for the whole module, so nothing below will send
          regardless of these settings. Turn it on in{' '}
          <Link to="/water/settings#alert_email_enabled">Settings → Alerts</Link>.
        </p>
      ) : null}

      {data.meters.map((m) => (
        <Row
          key={m.meter_id}
          m={m}
          yours={String(m.meter_id) === String(data.own_meter_id)}
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
