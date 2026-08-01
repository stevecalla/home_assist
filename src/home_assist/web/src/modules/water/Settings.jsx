import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import './water.css';

// Every value that used to be a `const` at the top of monitor.mjs, editable without a redeploy.
//
// The one that matters is the overnight threshold: you cannot know the right number in advance,
// because an ice maker, a water-softener regen, and a recirculation pump all draw water at 3am and
// none of them is a leak. You watch a week of clean nights, then set it just above the noise.
// Making that a text field instead of a code edit is the difference between tuning it and not.
export default function Settings() {
  const [fields, setFields] = useState(null);
  const [email, setEmail] = useState(null);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    const r = await api.waterSettings();
    if (r.status === 200 && r.body.ok) { setFields(r.body.settings); setEmail(r.body.email); setDraft({}); }
    else setErr(r.body.error || 'Could not load settings');
  }

  async function save() {
    setBusy(true); setMsg(''); setErr('');
    const r = await api.waterSaveSettings(draft);
    setBusy(false);
    if (r.status === 200 && r.body.ok) {
      setFields(r.body.settings); setDraft({});
      setMsg('Saved. The collector picks these up within a minute — no restart needed.');
    } else setErr(r.body.error || 'Save failed');
  }

  async function test() {
    setBusy(true); setMsg(''); setErr('');
    const r = await api.waterTestAlert();
    setBusy(false);
    if (r.status === 200 && r.body.ok) {
      const ch = r.body.result.channels || {};
      const parts = Object.keys(ch).map((k) => k + ': ' + (ch[k].ok ? 'ok' : ch[k].error));
      if (!parts.length) setErr('No alert channel is enabled — nothing was sent.');
      else if (r.body.result.delivered) setMsg('Test sent — ' + parts.join(', '));
      else setErr('Nothing got through — ' + parts.join(', '));
    } else setErr(r.body.error || 'Test failed');
  }

  if (err && !fields) return <div className="page"><p className="err">{err}</p></div>;
  if (!fields) return <div className="loading">Loading…</div>;

  const groups = [];
  fields.forEach((f) => {
    let g = groups.find((x) => x.name === f.group);
    if (!g) { g = { name: f.group, items: [] }; groups.push(g); }
    g.items.push(f);
  });

  const dirty = Object.keys(draft).length;

  return (
    <div className="page w-root">
      <h2>Water settings</h2>
      <p className="muted">
        Stored in <code>water_settings</code>. Blank falls back to <code>.env</code>, then to the built-in default.
      </p>

      {msg ? <p className="ok" style={{ color: 'var(--w-good)', fontWeight: 600 }}>{msg}</p> : null}
      {err ? <p className="err">{err}</p> : null}

      {email && !email.configured ? (
        <div className="w-banner unknown" style={{ marginTop: 14 }}>
          <span className="w-banner-icon" aria-hidden="true">✉</span>
          <span className="w-banner-text">
            <p className="w-banner-head">Email is not configured</p>
            <p className="w-banner-sub">
              Set <code>EMAIL_SENDER</code>, <code>EMAIL_PASSWORD</code> (a Gmail <b>app</b> password, not your
              account password) and <code>EMAIL_RECIPIENT</code> in <code>.env</code>, then restart the collector.
              Until then leaks are recorded but nobody is told.
            </p>
          </span>
        </div>
      ) : null}

      <div style={{ margin: '18px 0' }}>
        <button className="btn primary" onClick={save} disabled={busy || !dirty}>
          {busy ? 'Working…' : dirty ? `Save ${dirty} change${dirty > 1 ? 's' : ''}` : 'No changes'}
        </button>
        <button className="btn" style={{ marginLeft: 10 }} onClick={test} disabled={busy}>Send a test alert</button>
        {dirty ? <button className="btn" style={{ marginLeft: 10 }} onClick={() => setDraft({})}>Discard</button> : null}
      </div>

      {groups.map((g) => (
        <div className="w-settings-group" key={g.name}>
          <h3>{g.name}</h3>
          {g.items.map((f) => {
            const changed = Object.prototype.hasOwnProperty.call(draft, f.name);
            const value = changed ? draft[f.name] : f.value;
            return (
              <div className="w-field" key={f.name}>
                <label className="w-field-label" htmlFor={'f-' + f.name}>
                  {f.label}{changed ? <span className="w-dirty"> •</span> : null}
                  <div className="muted small" style={{ fontWeight: 400 }}><code>{f.name}</code></div>
                </label>
                {/* A yes/no gets a SWITCH, not a number box. Typing 3 into an on/off setting is
                    not a user error — it is the control admitting it never said what it wanted.
                    The value stays 1/0 on the wire; only the affordance changes. */}
                {f.type === 'bool' ? (
                  <span className="w-toggle-wrap">
                    <button
                      type="button"
                      id={'f-' + f.name}
                      role="switch"
                      aria-checked={Number(value) ? 'true' : 'false'}
                      className={'w-toggle' + (Number(value) ? ' on' : '')}
                      onClick={() => setDraft((d) => Object.assign({}, d, { [f.name]: Number(value) ? 0 : 1 }))}
                    >
                      <span className="w-toggle-knob" aria-hidden="true" />
                    </button>
                    <span className="w-toggle-word">{Number(value) ? 'On' : 'Off'}</span>
                  </span>
                ) : (
                  <input
                    id={'f-' + f.name}
                    type={f.type === 'string' ? 'text' : 'number'}
                    step={f.type === 'float' ? 'any' : 1}
                    min={f.min}
                    max={f.max}
                    value={value === null || value === undefined ? '' : value}
                    onChange={(e) => setDraft((d) => Object.assign({}, d, { [f.name]: e.target.value }))}
                  />
                )}
                <div className="w-field-help">{f.help}</div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
