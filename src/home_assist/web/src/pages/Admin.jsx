import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
// The SHARED collapsible card — the same component every water page uses. Its styles moved from
// water.css to styles.css so a platform page can use it without importing a module's stylesheet.
import CollapsibleCard from '../components/CollapsibleCard.jsx';

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
  // What "All panels" resolves to server-side. Held back panels need an explicit grant, so "all"
  // and "every panel" are not the same list — the UI must show the real one.
  const [allExclude, setAllExclude] = useState([]);
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
    setAllExclude(r.body.default_all_exclude || []);
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

  /**
   * The set a mode RESOLVES to, for display. "All panels" is the interesting one: it is not every
   * panel, it is every panel minus the held-back ones, and rendering the words instead of the list
   * is how someone comes away believing they granted Diagnostics when they did not.
   */
  const allSet = () => {
    const o = {};
    panels.forEach((p) => { if (allExclude.indexOf(p.key) < 0) o[p.key] = true; });
    return o;
  };
  const defaultSet = () => {
    if (access.default === 'all') return allSet();
    const o = {};
    (Array.isArray(access.default) ? access.default : []).forEach((k) => { o[k] = true; });
    return o;
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
  // `admin` is governed by the ROLE, not by panel access, and is_allowed() hard-refuses it for a
  // non-admin whatever any list says. Offering it as a tickable box was a control that silently did
  // nothing — you ticked it, it saved, the summary said the user could see it, and they could not.
  // Shown disabled rather than hidden, so the reason is visible where the question gets asked.
  const NOT_GRANTABLE = ['admin'];
  const grantable = (items) => items.filter((p) => NOT_GRANTABLE.indexOf(p.key) < 0);

  /**
   * The panel grid, ALWAYS rendered.
   *
   * It used to appear only in "Only selected" mode, which meant the two modes people actually leave
   * things on -- "All panels" and "Use default" -- showed no list at all. So the one question this
   * page exists to answer, "what can this person actually see?", had no visible answer unless you
   * switched to a mode you did not want and then remembered to switch back.
   *
   * In the other modes it renders read-only, showing the RESOLVED set. That is where "All panels"
   * gets caught being untrue: it excludes the held-back panels, and now you can see which.
   */
  const qlist = (set, setSet, readOnly) => (
    <div style={{ margin: '8px 0', opacity: readOnly ? 0.75 : 1 }}>
      {grouped().map(({ group, items }) => {
        const can = grantable(items);
        // A group of only role-governed panels has nothing to toggle.
        const allOn = can.length > 0 && can.every((p) => set[p.key]);
        const toggleAll = (on) => { const n = { ...set }; can.forEach((p) => { n[p.key] = on; }); setSet(n); };
        return (
          <div key={group} style={{ marginBottom: 10 }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)' }}>
              <input type="checkbox" checked={allOn} disabled={readOnly || !can.length}
                     onChange={(e) => toggleAll(e.target.checked)} /> {group}
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '4px 16px', margin: '4px 0 0 18px' }}>
              {items.map((p) => {
                const locked = readOnly || NOT_GRANTABLE.indexOf(p.key) >= 0;
                const roleGoverned = NOT_GRANTABLE.indexOf(p.key) >= 0;
                return (
                  <label key={p.key}
                         title={roleGoverned
                           ? 'Governed by the admin role, not by panel access. Change the user\u2019s role instead.'
                           : (readOnly ? 'Read-only — switch to “Only selected” to change this' : undefined)}
                         style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13,
                                  opacity: locked ? 0.55 : 1 }}>
                    <input type="checkbox" disabled={locked}
                           checked={roleGoverned ? false : !!set[p.key]}
                           onChange={(e) => setSet({ ...set, [p.key]: e.target.checked })} />
                    {p.label || p.key}
                    {roleGoverned ? <span className="muted" style={{ fontSize: 11 }}>(role, not a panel)</span> : null}
                  </label>
                );
              })}
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

      <CollapsibleCard
        defaultOpen
        title="Users"
        sub={<>App logins. <code>.env</code> recovery accounts (<code>USATAPPS_ADMIN_*</code>, <code>USATAPPS_TEST_*</code>) are
          always valid and can’t be removed; add app-specific users below. Role <b>admin</b> can reach this page —
          and that is the ONLY way to grant it; “Users &amp; access” is not a tickable panel.</>}
      >
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
      </CollapsibleCard>

      <CollapsibleCard
        defaultOpen
        title="Panel access — general default"
        sub="Which panels non-admin users see by default. Admins always see every panel."
      >
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <label style={rlab}><input type="radio" name="defmode" checked={defMode === 'all'} onChange={() => setDefMode('all')} /> All panels</label>
          <label style={rlab}><input type="radio" name="defmode" checked={defMode === 'some'} onChange={() => setDefMode('some')} /> Only selected</label>
        </div>
        {defMode === 'some'
          ? qlist(defSet, setDefSet, false)
          : (<>
              <p className="muted small" style={{ margin: '10px 0 0' }}>
                “All panels” means everything <b>except</b> the held-back ones below — those always
                need an explicit grant. This is what it resolves to:
              </p>
              {qlist(allSet(), () => {}, true)}
            </>)}
        <button className="btn primary" style={{ marginTop: 12 }} onClick={saveDefault}>Save default</button>{msg(defMsg)}
      </CollapsibleCard>

      <CollapsibleCard
        defaultOpen
        title="Panel access — per user"
        sub="Override the default for one user. “Use default” removes the override."
      >
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
          // Filter through the same rule the server enforces. Listing a panel the authorization
          // check will refuse is how "I granted it and it did nothing" happens.
          else if (e.keys.filter((k) => NOT_GRANTABLE.indexOf(k) < 0).length) {
            body = (
              <span>{e.keys.filter((k) => NOT_GRANTABLE.indexOf(k) < 0).map(panelLabel).join(', ')}
                {' '}<span className="muted">({e.src})</span></span>
            );
          } else body = <span><em>no panels</em> <span className="muted">({e.src})</span></span>;
          return (
            <div className="small" style={{ margin: '10px 0', padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)' }}>
              <strong>{selUser}</strong> currently sees: {body}
            </div>
          );
        })()}
        {uMode === 'some' ? qlist(uSet, setUSet, false) : (
          <>
            <p className="muted small" style={{ margin: '10px 0 0' }}>
              {uMode === 'default'
                ? 'Inherited from the general default above. Shown read-only:'
                : '“All panels” minus the held-back ones. Shown read-only:'}
            </p>
            {qlist(uMode === 'default' ? defaultSet() : allSet(), () => {}, true)}
          </>
        )}
        <button className="btn primary" style={{ marginTop: 12 }} onClick={saveUserAccess} disabled={!selUser}>Save user</button>{msg(accMsg)}
        <p className="muted small" style={{ marginTop: 12 }}>
          The <b>Admin</b> page itself is governed by the <b>admin</b> role, not by panel access — a non-admin can
          never reach user management even if granted other panels. That is why <b>Users &amp; access</b> is
          shown greyed out above: to make someone an admin, re-add them with the <b>admin</b> role
          (Users section, or <code>node src/home_assist/admin.js add &lt;user&gt;</code>).
        </p>
      </CollapsibleCard>
    </div>
  );
}
