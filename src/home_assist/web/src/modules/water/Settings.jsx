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
      // A value can be CHANGED on the way in -- clamp() snaps anything out of range. Reporting a
      // plain "Saved." after storing a different number than the one typed is the worst of both:
      // it reads as success, and the field reloads showing a value nobody chose.
      const adj = r.body.adjusted || [];
      if (adj.length) {
        setMsg('');
        setErr('Saved, but ' + adj.length + (adj.length === 1 ? ' value was' : ' values were')
          + ' adjusted: '
          + adj.map((a) => a.label + ' — you asked for ' + a.asked + ', saved ' + a.saved
              + ' (' + a.reason + ')').join('; '));
      } else {
        setMsg('Saved. The collector picks these up within a minute — no restart needed.');
      }
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
              <div className={'w-field' + (f.type === 'string' ? ' is-text' : '')} key={f.name}>
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
                  /* A TEXTAREA for text values, an input for numbers.
                     Not decoration: these fields hold email lists, ntfy URLs and addresses that are
                     routinely longer than the box. In a 160px input "water-alerts@kidderwise.org"
                     renders as "water-alerts@kidderwi" -- you cannot read what you are about to
                     save, on the page whose whole job is showing what is configured. A textarea
                     wraps AND drags, so a three-address list can be opened up to be read.
                     Numbers keep their input: a 400px box holding "5" is its own kind of wrong. */
                  f.type === 'string' ? (
                    <textarea
                      id={'f-' + f.name}
                      rows={1}
                      spellCheck={false}
                      value={value === null || value === undefined ? '' : value}
                      /* Newlines stripped: this is a one-line value that happens to wrap, and a
                         stray Enter would otherwise be saved into the middle of an address list. */
                      onChange={(e) => setDraft((d) => Object.assign({}, d, { [f.name]: e.target.value.replace(/\n/g, '') }))}
                    />
                  ) : (
                  <input
                    id={'f-' + f.name}
                    type="number"
                    step={f.type === 'float' ? 'any' : 1}
                    min={f.min}
                    max={f.max}
                    value={value === null || value === undefined ? '' : value}
                    onChange={(e) => setDraft((d) => Object.assign({}, d, { [f.name]: e.target.value }))}
                  />
                  )
                )}
                <div className="w-field-help">
                  {f.help}
                  {/* The limits were sent by describe() all along and rendered nowhere, so the only
                      way to discover that a field refuses 0 was to type 0 and watch it come back
                      as 1. A range is cheap to print and answers the question before it is asked. */}
                  {f.type !== 'bool' && f.type !== 'string' && (f.min !== undefined || f.max !== undefined) ? (
                    <div className="w-range-hint">
                      {f.min !== undefined && f.max !== undefined ? 'Range ' + f.min + '\u2013' + f.max
                        : f.min !== undefined ? 'Minimum ' + f.min : 'Maximum ' + f.max}
                      {f.min_nonzero !== undefined ? ', or 0 for unlimited (any other value is raised to ' + f.min_nonzero + ')' : ''}
                      {f.default !== undefined ? ' \u00b7 default ' + f.default : ''}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
