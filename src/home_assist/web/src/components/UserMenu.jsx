import { useEffect, useRef, useState } from 'react';

// Person icon → dropdown with the signed-in user and Sign out. Rightmost in the header.
function PersonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
    </svg>
  );
}

export default function UserMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <span className="usermenu" ref={ref}>
      <button type="button" className="usermenu-btn" aria-label="Account menu" aria-haspopup="true" aria-expanded={open} title={user.user} onClick={() => setOpen((o) => !o)}>
        <PersonIcon />
      </button>
      {open && (
        <div className="usermenu-menu" role="menu">
          <div className="usermenu-user">{user.user}{user.role ? ` · ${user.role}` : ''}</div>
          <button type="button" className="usermenu-item" role="menuitem" onClick={() => { setOpen(false); onLogout(); }}>Sign out</button>
        </div>
      )}
    </span>
  );
}
