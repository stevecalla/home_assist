import { useState, useRef, useLayoutEffect } from 'react';

// Measure the container so the SVG is drawn in REAL pixels.
//
// The obvious shortcut — a fixed viewBox scaled to fit with preserveAspectRatio="none" — looks fine
// on a desktop and falls apart on a phone: everything including the text is squashed horizontally
// by the scale factor, so the axis labels become unreadable at exactly the width where you most
// need them. Measuring costs a ResizeObserver and makes the chart honest at every size.
function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => setW(el.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * BarChart — one series, magnitude over time, drawn as inline SVG.
 *
 * Hand-rolled rather than pulling in a chart library: it is ~120 lines, it inherits the app's
 * theme tokens for free, and it adds nothing to the bundle on a box that also has to run a radio.
 *
 * Follows the dataviz method:
 *  - ONE series -> one categorical slot (blue), so no legend box is needed; the title names it.
 *  - The overnight window is an ANNOTATION BAND (a recessive surface tint), not a second series —
 *    a second hue there would imply a second measure.
 *  - "No data" is drawn distinctly from "zero", because on a leak monitor those mean opposite
 *    things: zero means no water moved, no-data means we were not listening.
 *  - 4px rounded data-ends anchored to the baseline, 2px gap between adjacent bars.
 *  - Per-mark hover tooltip, with a hit target wider than the bar.
 */
export default function BarChart({
  data,               // [{ key, label, value, observed, highlight }]
  height = 180,
  unit = 'gal',
  formatTip,          // (d) => string
  emptyMessage = 'No data yet.',
}) {
  const [hover, setHover] = useState(null);
  const [ref, measured] = useWidth();

  if (!data || !data.length) {
    return <p className="muted" style={{ padding: '24px 0' }}>{emptyMessage}</p>;
  }

  // Real pixels, measured from the container — never a stretched viewBox (see useWidth).
  const W = measured || 900;
  const H = height;
  const padL = 34, padR = 6, padT = 10, padB = 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const max = Math.max(1, ...data.map((d) => d.value));
  const niceMax = niceCeil(max);
  const slot = plotW / data.length;
  const gap = 2;                                  // 2px surface gap between adjacent bars
  const barW = Math.max(1, slot - gap);
  const y = (v) => padT + plotH - (v / niceMax) * plotH;

  const ticks = [0, niceMax / 2, niceMax];

  return (
    <div className="w-chart" ref={ref}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img">
        {/* annotation bands (e.g. the overnight window) — drawn first, behind everything */}
        {contiguous(data, (d) => d.highlight).map((seg, i) => (
          <rect
            key={'band' + i}
            className="w-band-rect"
            x={padL + seg.start * slot}
            y={padT}
            width={(seg.end - seg.start + 1) * slot}
            height={plotH}
          />
        ))}

        {/* recessive gridlines + value axis */}
        {ticks.map((t, i) => (
          <g key={'t' + i}>
            <line className={t === 0 ? 'w-baseline' : 'w-gridline'} x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} />
            <text className="w-axis-label" x={padL - 6} y={y(t) + 3} textAnchor="end">{fmt(t)}</text>
          </g>
        ))}

        {/* bars */}
        {data.map((d, i) => {
          const bx = padL + i * slot + gap / 2;
          const h = d.value > 0 ? Math.max(2, plotH - (y(d.value) - padT)) : 0;
          return (
            <g key={d.key}>
              {/* hit target spans the full slot height so a 1px bar is still hoverable */}
              <rect
                className="w-bar-hit"
                x={padL + i * slot}
                y={padT}
                width={slot}
                height={plotH}
                onMouseEnter={() => setHover({ i, d })}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover({ i, d })}
                onBlur={() => setHover(null)}
                tabIndex={0}
                role="button"
                aria-label={`${d.label}: ${d.observed ? d.value.toFixed(0) + ' ' + unit : 'no data'}`}
              />
              {!d.observed ? (
                // no data: a thin recessive stub on the baseline — visibly different from a zero
                <rect className="w-bar-nodata" x={bx} y={padT + plotH - 3} width={barW} height={3} />
              ) : h > 0 ? (
                <rect className="w-bar" x={bx} y={y(d.value)} width={barW} height={h} rx={Math.min(4, barW / 2)} />
              ) : (
                <rect className="w-bar" x={bx} y={padT + plotH - 1} width={barW} height={1} />
              )}
            </g>
          );
        })}

        {/* time axis: labels spaced so they never collide, based on the ACTUAL pixel width
            available — a phone gets fewer labels than a desktop rather than overlapping ones */}
        {data.map((d, i) => {
          const perLabel = 46;                                   // px a label needs, incl. breathing room
          const maxLabels = Math.max(2, Math.floor(plotW / perLabel));
          const every = Math.max(1, Math.ceil(data.length / maxLabels));
          if (i % every !== 0) return null;
          return (
            <text key={'x' + d.key} className="w-axis-label" x={padL + i * slot + slot / 2} y={H - 6} textAnchor="middle">
              {d.label}
            </text>
          );
        })}
      </svg>

      {hover ? (
        <div
          className="w-tooltip"
          style={{ left: ((padL + hover.i * slot + slot / 2) / W) * 100 + '%', top: -6 }}
        >
          {formatTip ? formatTip(hover.d) : (
            <>
              {hover.d.label} — <b>{hover.d.observed ? hover.d.value.toFixed(0) + ' ' + unit : 'no data'}</b>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function fmt(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(Math.round(n));
}

// Round the axis maximum up to something a human would pick.
function niceCeil(v) {
  if (v <= 5) return 5;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

// Collapse a per-item boolean into contiguous [start,end] index ranges, so the overnight band is
// one rectangle per night rather than one per hour.
function contiguous(items, pred) {
  const out = [];
  let start = null;
  items.forEach((d, i) => {
    if (pred(d)) { if (start === null) start = i; }
    else if (start !== null) { out.push({ start, end: i - 1 }); start = null; }
  });
  if (start !== null) out.push({ start, end: items.length - 1 });
  return out;
}
