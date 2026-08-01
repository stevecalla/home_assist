import { useEffect, useState } from 'react';

/**
 * CollapsibleCard — ported from usat_apps
 * (web/src/modules/salesforce_merge/components/CollapsibleCard.jsx), same props and same behaviour:
 *
 *   title       header text
 *   actions     rendered right-aligned in the header; clicks there must NOT toggle the card
 *   defaultOpen initial state
 *   forceOpen   + forceKey — how a parent drives "expand all" / "collapse all". The key is what
 *               makes a repeat of the same command work: setting forceOpen=false twice in a row is
 *               a no-op to an effect that only watches the value, so the second "Collapse all"
 *               click would do nothing after the user had manually reopened a card.
 *
 * Kept deliberately identical rather than improved, because the point is that a card here behaves
 * exactly like a card in usat_apps. The one change: the caret AND the title share one button, so
 * the hit target is the whole title rather than a 14px glyph — same behaviour, easier to hit.
 */
export default function CollapsibleCard({
  title, actions, defaultOpen = true, forceOpen, forceKey, children, style, sub,
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (typeof forceOpen === 'boolean') setOpen(forceOpen);
  }, [forceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={'w-chart-card' + (open ? '' : ' is-collapsed')} style={style}>
      <div className="w-chart-head">
        <button
          type="button"
          className="w-card-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={open ? 'Collapse' : 'Expand'}
        >
          <span className="w-card-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="w-chart-title">{title}</span>
        </button>
        {actions ? (
          <span className="w-card-actions" onClick={(e) => e.stopPropagation()}>{actions}</span>
        ) : null}
      </div>
      {open && sub ? <p className="w-chart-sub">{sub}</p> : null}
      {open ? children : null}
    </div>
  );
}
