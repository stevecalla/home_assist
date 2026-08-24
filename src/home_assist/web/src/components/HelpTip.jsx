import { useEffect, useState } from 'react';

/**
 * HelpTip — makes the `?` glyphs work on a touch screen.
 *
 * THE PROBLEM. Every metric on the water pages explains itself through a `title` attribute, shown by
 * the browser on hover. A phone has no hover. So on the device where this dashboard is most likely
 * to be read — in bed, at 3am, deciding whether the number on screen is bad — every explanation was
 * silently unavailable. Not hard to find: absent.
 *
 * THE APPROACH. One capture-phase listener at the document, rather than a component swapped in at
 * every call site. There are dozens of `?` glyphs across Monitor, History, Diagnostics and the
 * tiles; converting each would be a large diff through files this change has no other business in,
 * and every future `?` would have to remember to use the new thing. A listener covers the ones that
 * exist and the ones nobody has written yet.
 *
 * CAPTURE phase specifically: the `?` inside a chip sits within a <button> that has its own click
 * handler, so the listener has to intercept before the button acts. Otherwise tapping "what does
 * this mean?" would also change your row limit.
 *
 * POINTER-GATED, not width-gated. `(hover: none)` asks the question that actually matters — is
 * there a cursor? A mouse user keeps the native tooltip and notices no difference; a tablet at
 * 1024px gets the sheet, because it has the same thumbs as a phone.
 */
export default function HelpTip() {
  const [tip, setTip] = useState(null);   // { label, text }

  useEffect(() => {
    // No touch, no interception. Desktop keeps the browser's own tooltip.
    let coarse = false;
    try { coarse = window.matchMedia('(hover: none)').matches; } catch (e) { coarse = false; }
    if (!coarse) return undefined;

    const onClick = (e) => {
      const q = e.target && e.target.closest ? e.target.closest('.w-q') : null;
      if (!q) return;
      // The text lives on an ANCESTOR (the label carries the title, the glyph sits inside it), so
      // walk up for the nearest one that has it.
      const holder = q.closest('[title]');
      const text = holder && holder.getAttribute('title');
      if (!text) return;              // nothing to say — let the click through untouched
      e.preventDefault();
      e.stopPropagation();
      // The label without the glyph's own "?" text, so the sheet is headed by what you tapped.
      const label = (holder.textContent || '').replace(/\?\s*$/, '').trim();
      setTip({ label: label.slice(0, 80), text: text });
    };

    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // Escape closes it, same as any dialog.
  useEffect(() => {
    if (!tip) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setTip(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [tip]);

  if (!tip) return null;
  return (
    <>
      <div className="w-help-backdrop" onClick={() => setTip(null)} />
      <div className="w-help-sheet" role="dialog" aria-label={tip.label || 'Explanation'}>
        <button type="button" className="w-help-close" aria-label="Close" onClick={() => setTip(null)}>×</button>
        {tip.label ? <p className="w-help-title">{tip.label}</p> : null}
        <p className="w-help-body">{tip.text}</p>
      </div>
    </>
  );
}
