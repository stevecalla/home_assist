import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// Admin · Access — user management + panel access, over the admin-gated /api/admin/* endpoints.
//   • Users: .env recovery accounts (always valid, not removable) + stored scrypt-hashed users.
//   • Panel access — general default: which panels non-admins see by default (admins always see all).
//   • Panel access — per user: override the default for one user ("Use default" removes the override).
// The panel catalog is built server-side from the module registry, so new modules' panels appear here.
//
// NOTE (deferred): once Microsoft SSO lands, "add user" becomes "add USAT email" and the password field
// goes away — the identity comes from Microsoft; this page still governs role + panel access.

const sbtn = { padding: '3px 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--ink)', cursor: 'pointer', fontSize: 12 };
const rlab = { display: 'inline-flex', gap: 6, alignItems: 'center' };
const pill = (bg, fg) => ({ display: 'inline-block', padding: '1px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: bg, color: fg, textTransform: 'capitalize' });
const rolePill = (r) => (r === 'admin' ? pill('rgba(194,14,47,.15)', '#c20e2f') : pill('rgba(59,130,246,.16)', '#2563eb'));
const srcPill = (s) => (s === 'env' ? pill('rgba(212,146,10,.20)', '#b45309') : pill('rgba(100,116,139,.20)', 'var(--muted, #64748b)'));

export default function Admin() {
  const [users, setUsers] = useState(null);
  const [panels, setPanels] = useState([]);
  const [access, setAccess] = useState({ default: [], users: {} });
  const [err, setErr] = useState('');

  const [nu, setNu] = useState(''); const [np, setNp] = useState(''); const [nr, setNr] = useState('user'); const [showPw, setShowPw] = useState(false);
  const [uMsg, setUMsg] = useState(null);

  const [defMode, setDefMode] = useState('some'); const [defSet, setDefSet] = useState({}); const [defMsg, setDefMsg] = useState(null);

  const [selUser, setSelUser] = useState(''); const [uMode, setUMode] = useState('default'); const [uSet, setUSet] = useState({}); const [accMsg, setAccMsg] = useState(null);

  const loadUsers = async () => {
    const r = await api.adminUsers();
    if (r.status === 200) setUsers(r.body.users || []); else setErr(r.body.error || ('HTTP ' + r.status));
  };
  const loadAccess = async () => {
    const r = await api.adminPanelAccess();
    if (r.status !== 200) { setErr(r.body.error || ('HTTP ' + r.status)); return; }
    setPanels(r.body.panels || []);
    const a = r.body.access || { default: [], users: {} };
    setAccess(a);
    const defAll = a.default === 'all';
    setDefMode(defAll ? 'all' : 'some');
    const ds = {}; if (!defAll) (a.default || []).forEach((k) => { ds[k] = true; }); setDefSet(ds);
  };
  useEffect(() => { loadUsers(); loadAccess(); }, []);

  useEffect(() => {
    const ov = access.users ? access.users[selUser] : undefined;
    setUMode(ov === undefined ? 'default' : (ov === 'all' ? 'all' : 'some'));
    const s = {}; if (Array.isArray(ov)) ov.forEach((k) => { s[k] = true; }); setUSet(s);
  }, [selUser, access]);

  const knownUsers = users ? users.map((u) => u.user) : [];

  // What a selected user EFFECTIVELY sees: their per-user override if set, else the general default
  // (admins always see everything, regardless of panel access).
  const panelLabel = (k) => { const p = panels.find((x) => x.key === k); return p ? (p.label || p.key) : k; };
  const effectiveAccess = () => {
    if (!selUser) return null;
    const u = users && users.find((x) => x.user === selUser);
    if (u && u.role === 'admin') return { kind: 'admin' };
    const ov = access.users ? access.users[selUser] : undefined;
    const src = ov === undefined ? 'from the general default' : 'per-user override';
    const eff = ov === undefined ? access.default : ov;
    if (eff === 'all') return { kind: 'all', src };
    return { kind: 'some', src, keys: Array.isArray(eff) ? eff : [] };
  };

  const saveUser = async () => {
    const user = nu.trim();
    if (!user) { setUMsg({ text: 'username required', kind: 'err' }); return; }
    if (np.length < 4) { setUMsg({ text: 'password must be at least 4 characters', kind: 'err' }); return; }
    const r = await api.adminAddUser(user, np, nr);
    if (r.status === 200 && r.body.ok) {
      setUMsg({ text: 'Saved “' + r.body.user + '” (' + r.body.role + ').', kind: 'ok' });
      setNu(''); setNp(''); loadUsers(); loadAccess();
    } else setUMsg({ text: r.body.error || 'error', kind: 'err' });
  };
  const resetPw = (u) => { setNu(u); setNp(''); setUMsg({ text: 'Enter a new password for “' + u + '” and click Add / update user.', kind: '' }); };
  const removeUser = async (u) => {
    if (!window.confirm('Remove user “' + u + '”?')) return;
    const r = await api.adminRemoveUser(u);
    if (r.status === 200 && r.body.ok) { loadUsers(); loadAccess(); } else setUMsg({ text: r.body.error || 'error', kind: 'err' });
  };

  const saveDefault = async () => {
    setDefMsg({ text: 'Saving…', kind: '' });
    const payload = { default: defMode === 'all' ? 'all' : Object.keys(defSet).filter((k) => defSet[k]) };
    const r = await api.adminSetPanelAccess(payload);
    if (r.status === 200 && r.body.ok) { setAccess(r.body.access); setDefMsg({ text: 'Saved.', kind: 'ok' }); }
    else setDefMsg({ text: r.body.error || 'error', kind: 'err' });
  };
  const saveUserAccess = async () => {
    if (!selUser) { setAccMsg({ text: 'pick a user', kind: 'err' }); return; }
    setAccMsg({ text: 'Saving…', kind: '' });
    const payload = uMode === 'default'
      ? { user: selUser, clear: true }
      : { user: selUser, panels: uMode === 'all' ? 'all' : Object.keys(uSet).filter((k) => uSet[k]) };
    const r = await api.adminSetPanelAccess(payload);
    if (r.status === 200 && r.body.ok) { setAccess(r.body.access); setAccMsg({ text: 'Saved.', kind: 'ok' }); }
    else setAccMsg({ text: r.body.error || 'error', kind: 'err' });
  };

  const msg = (m) => (m && m.text
    ? <span className="small" style={{ marginLeft: 8, color: m.kind === 'err' ? 'var(--red)' : (m.kind === 'ok' ? '#16794a' : 'var(--muted)') }}>{m.text}</span>
    : null);

  // Bucket the catalog by group (group:null -> "General"), preserving catalog order.
  const grouped = () => {
    const g = {}; const order = [];
    panels.forEach((p) => { const k = p.group || 'General'; if (!g[k]) { g[k] = []; order.push(k); } g[k].push(p); });
    return order.map((k) => ({ group: k, items: g[k] }));
  };
  const qlist = (set, setSet) => (
    <div style={{ margin: '8px 0' }}>
      {grouped().map(({ group, items }) => {
        const allOn = items.every((p) => set[p.key]);
        const toggleAll = (on) => { const n = { ...set }; items.forEach((p) => { n[p.key] = on; }); setSet(n); };
        return (
          <div key={group} style={{ marginBottom: 10 }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)' }}>
              <input type="checkbox" checked={allOn} onChange={(e) => toggleAll(e.target.checked)} /> {group}
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '4px 16px', margin: '4px 0 0 18px' }}>
              {items.map((p) => (
                <label key={p.key} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                  <input type="checkbox" checked={!!set[p.key]} onChange={(e) => setSet({ ...set, [p.key]: e.target.checked })} />
                  {p.label || p.key}
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );

  if (err) return (<div className="page"><h2>Users &amp; access</h2><p className="err">{err}</p></div>);

  return (
    <div className="page">
      <h2>Users &amp; access</h2>

      <div className="card">
        <h3>Users</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          App logins. <code>.env</code> recovery accounts (<code>USATAPPS_ADMIN_*</code>, <code>USATAPPS_TEST_*</code>) are
          always valid and can’t be removed; add app-specific users below. Role <b>admin</b> can reach this page.
        </p>
        <table className="grid">
          <thead><tr><th>User</th><th>Role</th><th>Source</th><th /></tr></thead>
          <tbody>
            {!users && <tr><td className="muted">Loading…</td></tr>}
            {users && users.map((u) => (
              <tr key={u.user + u.source}>
                <td>{u.user}</td>
                <td><span style={rolePill(u.role)}>{u.role}</span></td>
                <td><span style={srcPill(u.source)}>{u.source === 'env' ? 'recovery' : 'stored'}</span></td>
                <td>{u.removable
                  ? (<><button style={sbtn} onClick={() => resetPw(u.user)}>reset pw</button>{' '}
                     <button style={{ ...sbtn, color: 'var(--red)', borderColor: 'var(--red)' }} onClick={() => removeUser(u.user)}>remove</button></>)
                  : <span className="muted small">recovery</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="rowform" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <input placeholder="username / email" value={nu} onChange={(e) => setNu(e.target.value)} autoComplete="off" />
          <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
            <input placeholder="password" type={showPw ? 'text' : 'password'} value={np} onChange={(e) => setNp(e.target.value)} autoComplete="new-password" style={{ paddingRight: 30 }} />
            <button type="button" onClick={() => setShowPw((v) => !v)} title={showPw ? 'Hide password' : 'Show password'} aria-label={showPw ? 'Hide password' : 'Show password'}
              style={{ position: 'absolute', right: 4, border: 0, background: 'transparent', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 2, color: 'var(--muted)' }}>{showPw ? '🙈' : '👁'}</button>
          </span>
          <select value={nr} onChange={(e) => setNr(e.target.value)}>
            <option value="user">user</option><option value="admin">admin</option>
          </select>
          <button className="btn primary" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} onClick={saveUser}>Add / update user</button>
          {msg(uMsg)}
        </div>
        <p className="muted small" style={{ margin: '10px 0 0', borderLeft: '3px solid var(--line)', paddingLeft: 8 }}>
          📁 <strong>Where this data lives:</strong> stored users in <code>auth.json</code> (scrypt‑hashed) and panel access in <code>panel_access.json</code> — in the platform data folder <em>outside the repo, not in the database</em>. Recovery accounts come from <code>.env</code> (<code>USATAPPS_ADMIN_*</code> / <code>USATAPPS_TEST_*</code>).
        </p>
      </div>

      <div className="card">
        <h3>Panel access — general default</h3>
        <p className="muted small" style={{ marginTop: 0 }}>Which panels non-admin users see by default. Admins always see every panel.</p>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <label style={rlab}><input type="radio" name="defmode" checked={defMode === 'all'} onChange={() => setDefMode('all')} /> All panels</label>
          <label style={rlab}><input type="radio" name="defmode" checked={defMode === 'some'} onChange={() => setDefMode('some')} /> Only selected</label>
        </div>
        {defMode === 'some' && qlist(defSet, setDefSet)}
        <button className="btn primary" style={{ marginTop: 12 }} onClick={saveDefault}>Save default</button>{msg(defMsg)}
      </div>

      <div className="card">
        <h3>Panel access — per user</h3>
        <p className="muted small" style={{ marginTop: 0 }}>Override the default for one user. “Use default” removes the override.</p>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="small">User&nbsp;
            <select value={selUser} onChange={(e) => setSelUser(e.target.value)}>
              <option value="">—</option>
              {knownUsers.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </label>
          <label style={rlab}><input type="radio" name="usermode" checked={uMode === 'default'} onChange={() => setUMode('default')} /> Use default</label>
          <label style={rlab}><input type="radio" name="usermode" checked={uMode === 'all'} onChange={() => setUMode('all')} /> All panels</label>
          <label style={rlab}><input type="radio" name="usermode" checked={uMode === 'some'} onChange={() => setUMode('some')} /> Only selected</label>
        </div>
        {selUser && (() => {
          const e = effectiveAccess();
          let body;
          if (e.kind === 'admin') body = <em>all panels — admin role (panel access doesn’t apply)</em>;
          else if (e.kind === 'all') body = <span>all panels <span className="muted">({e.src})</span></span>;
          else if (e.keys.length) body = <span>{e.keys.map(panelLabel).join(', ')} <span className="muted">({e.src})</span></span>;
          else body = <span><em>no panels</em> <span className="muted">({e.src})</span></span>;
          return (
            <div className="small" style={{ margin: '10px 0', padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)' }}>
              <strong>{selUser}</strong> currently sees: {body}
            </div>
          );
        })()}
        {uMode === 'some' && qlist(uSet, setUSet)}
        <button className="btn primary" style={{ marginTop: 12 }} onClick={saveUserAccess} disabled={!selUser}>Save user</button>{msg(accMsg)}
        <p className="muted small" style={{ marginTop: 12 }}>
          The <b>Admin</b> page itself is governed by the <b>admin</b> role, not by panel access — a non-admin can
          never reach user management even if granted other panels.
        </p>
      </div>
    </div>
  );
}
