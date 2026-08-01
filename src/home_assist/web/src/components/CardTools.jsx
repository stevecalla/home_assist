import { useState } from 'react';

/**
 * CardTools — the Expand / PNG / CSV / Table toolbar from usat_apps' merge panel
 * (web/src/modules/salesforce_merge/components/ChartCard.jsx), adapted for inline-SVG charts.
 *
 * usat's version rasterises a Chart.js <canvas>, which is already a bitmap. Ours are hand-rolled
 * SVG, so PNG export has one extra problem worth knowing about:
 *
 *   The charts colour themselves with CSS custom properties (var(--w-series), var(--w-critical)…).
 *   A serialised SVG carries the *text* "var(--w-series)" and nothing that can resolve it, so a
 *   naive export produces a chart drawn entirely in black — technically a PNG, useless as a record.
 *   resolve_vars() below walks the clone and substitutes the computed value of every var() it finds,
 *   which is why the exported image matches what is on screen in both light and dark themes.
 *
 * Passing `headers`/`rows` enables CSV and the flip-to-table view; omit them for a chart with no
 * meaningful tabular form.
 */

// Resolve against the CHART's own element, not document.documentElement.
//
// The water tokens (--w-series, --w-band, --w-critical…) are declared on `.w-root`, not on :root —
// deliberately, so the module's palette cannot leak into another module. Reading them off <html>
// therefore returns "" for every one of them, and the fallback paints the entire export in #888:
// the overnight annotation band, a 5%-opacity tint on screen, comes out as an opaque grey slab.
function cssvar(name, scope) {
  try {
    const el = scope || document.documentElement;
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    if (v) return v;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  } catch (e) { return '#888'; }
}

function resolve_vars(el, scope) {
  const attrs = ['fill', 'stroke'];
  const walk = (node) => {
    if (node.nodeType !== 1) return;
    attrs.forEach((a) => {
      const v = node.getAttribute && node.getAttribute(a);
      if (v && v.indexOf('var(') === 0) {
        const name = v.slice(4, v.indexOf(')')).trim();
        node.setAttribute(a, cssvar(name, scope));
      }
    });
    Array.prototype.forEach.call(node.childNodes || [], walk);
  };
  walk(el);
  return el;
}

// The ref a card hands us usually points at the WRAPPER div, not the <svg> — the charts measure
// their own width from a wrapper, so that is the element a parent can hold. Accept either.
function find_svg(node) {
  if (!node) return null;
  if (node.tagName && node.tagName.toLowerCase() === 'svg') return node;
  return node.querySelector ? node.querySelector('svg') : null;
}

function download(name, href) {
  const a = document.createElement('a');
  a.href = href; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

// SVG -> PNG at 2x, on the card's own background, with the title burned in so a shared image is
// self-describing rather than an anonymous set of lines.
function svg_png(svgEl, title) {
  return new Promise((resolve) => {
    if (!svgEl) return resolve('');
    const clone = resolve_vars(svgEl.cloneNode(true), svgEl);
    const w = svgEl.clientWidth || Number(svgEl.getAttribute('width')) || 900;
    const h = Number(svgEl.getAttribute('height')) || svgEl.clientHeight || 260;
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const xml = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const pad = title ? 34 : 0;
      const c = document.createElement('canvas');
      c.width = w * scale; c.height = (h + pad) * scale;
      const ctx = c.getContext('2d');
      ctx.scale(scale, scale);
      ctx.fillStyle = cssvar('--panel', svgEl) || '#fff';
      ctx.fillRect(0, 0, w, h + pad);
      if (title) {
        ctx.fillStyle = cssvar('--ink', svgEl) || '#111';
        ctx.font = '700 15px system-ui,Segoe UI,Arial,sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillText(title, 8, 9);
      }
      ctx.drawImage(img, 0, pad);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => resolve('');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  });
}

function to_csv(headers, rows) {
  const esc = (v) => {
    const s = String(v === null || v === undefined ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [headers.map(esc).join(',')]
    .concat((rows || []).map((r) => r.map(esc).join(',')))
    .join('\n');
}

export default function CardTools({ id, title, svgRef, headers, rows, flip, onFlip, image = true }) {
  const [modal, setModal] = useState(null);
  const hasTable = !!(headers && headers.length);
  // A card with no chart (the alerts list) still wants CSV, but offering "PNG" of nothing is a
  // button that appears to do nothing — worse than an absent button.
  const hasImage = image && !!svgRef;

  const doPng = async () => {
    const png = await svg_png(find_svg(svgRef && svgRef.current), title);
    if (png) download((id || 'chart') + '.png', png);
  };
  const doExpand = async () => {
    const png = await svg_png(find_svg(svgRef && svgRef.current), title);
    if (png) setModal(png);
  };
  const doCsv = () => {
    const blob = new Blob([to_csv(headers, rows)], { type: 'text/csv;charset=utf-8' });
    download((id || 'chart') + '.csv', URL.createObjectURL(blob));
  };

  return (
    <>
      <span className="w-tools" onClick={(e) => e.stopPropagation()}>
        {hasImage ? <button type="button" onClick={doExpand} title="Open larger">⤢ Expand</button> : null}
        {hasImage ? <button type="button" onClick={doPng} title="Download as an image">⬇ PNG</button> : null}
        {hasTable ? <button type="button" onClick={doCsv} title="Download the underlying rows">⬇ CSV</button> : null}
        {hasTable && onFlip
          ? <button type="button" onClick={() => onFlip(!flip)}>{flip ? '⇄ Chart' : '⇄ Table'}</button>
          : null}
      </span>

      {modal ? (
        <div className="w-modal" role="dialog" aria-label={title} onClick={() => setModal(null)}>
          <div className="w-modal-inner" onClick={(e) => e.stopPropagation()}>
            <div className="w-modal-bar">
              <strong>{title}</strong>
              <button type="button" onClick={() => download((id || 'chart') + '.png', modal)}>⬇ PNG</button>
              <button type="button" onClick={() => setModal(null)}>✕ Close</button>
            </div>
            <img src={modal} alt={title} />
          </div>
        </div>
      ) : null}
    </>
  );
}
