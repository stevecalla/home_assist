import { useState, useRef, useLayoutEffect } from 'react';

// Measure the container so the SVG is drawn in REAL pixels. Same reasoning as BarChart: a fixed
// viewBox with preserveAspectRatio="none" squashes the axis text on a phone, which is exactly the
// device you check this on.
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

// Time labels have to match the span they describe. A freshly opened tape covers ~90 seconds, and
// at HH:MM every tick on it reads the same minute — six identical labels, which is worse than none
// because it looks like a rendering bug. Below ten minutes, show seconds.
// Absolute wall clock — for the tooltip, where "when did that step happen?" is the question.
function clock(ms, span) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return span !== undefined && span < 10 * 60000 ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
}

// The x-axis is RELATIVE ("2m ago"), not absolute.
//
// Absolute labels fail badly on a live tape at both ends of the range. At a 90-second span, HH:MM
// prints the same minute six times, which reads as a rendering bug. Dropping to MM:SS to fix that
// prints things like "24:26" — a minute-and-second pair that the eye parses as an impossible clock
// time. Relative labels are unambiguous at every span, and they match how the card is framed:
// "the last 30 minutes". The tooltip still gives the wall clock for a specific point.
function agoLabel(t, t1) {
  const d = Math.max(0, t1 - t);
  if (d < 1000) return 'now';
  if (d < 90000) return Math.round(d / 1000) + 's';
  const m = Math.round(d / 60000);
  return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
}

/**
 * LiveChart — the odometer as it moves, right now.
 *
 * Plots gallons used SINCE THE START OF THE WINDOW, not the raw odometer.
 *
 * That distinction is the whole chart. The odometer reads ~794,120 and a shower is maybe 20
 * gallons, so an absolute y-axis renders every real event as a perfectly flat line — the naive
 * version of this chart is indistinguishable from a broken one. Subtracting the window's opening
 * value auto-zooms onto the only part that varies.
 *
 * Reading it:
 *   flat      nobody is using water (the healthy overnight state)
 *   a step    a fixture ran — height is gallons, width is how long
 *   a ramp    something is running continuously. At 3am that is the whole point of this app.
 *
 * Gaps are drawn as gaps, never interpolated across: a missing sample means we did not hear the
 * meter, which is a different fact from "no water moved" and must not look like a flat line.
 */
export default function LiveChart({
  points,             // [{ t: epoch ms, gallons: odometer }]
  height = 160,
  windowMs,           // nominal span, for the x-axis
  gapMs = 30000,      // a hole longer than this is drawn as a gap, not a line
  emptyMessage = 'Waiting for the first reading…',
}) {
  const [hover, setHover] = useState(null);
  const [ref, measured] = useWidth();

  if (!points || points.length < 2) {
    return (
      <div ref={ref}>
        <p className="muted" style={{ padding: '28px 0' }}>{emptyMessage}</p>
      </div>
    );
  }

  const W = measured || 900;
  const H = height;

  // The right-hand axis is the SAME line relabelled, not a second series.
  //
  // A second scale on the right is normally a dataviz sin, because it invites you to compare two
  // unrelated series whose crossings are an artifact of the scaling. That objection does not apply
  // here: odometer = base + used, an exact affine relationship, so this is one line carrying two
  // labels — like °C and °F on the same thermometer. There is no second line and no crossing to
  // misread. It earns its place because the two questions are genuinely different: "how much have
  // we used just now?" (left) and "what does the dial in the pit say?" (right, for cross-checking
  // against the physical meter and against the utility bill).
  //
  // Dropped entirely on narrow screens — seven digits do not fit next to a 320px chart, and a
  // truncated number is worse than an absent one.
  const showRight = W >= 460;
  const padL = 40, padR = showRight ? 74 : 10, padT = 22, padB = 24;
  const plotW = Math.max(10, W - padL - padR);
  const plotH = Math.max(10, H - padT - padB);

  const base = points[0].gallons;
  const used = points.map((p) => ({ t: p.t, v: Math.max(0, p.gallons - base) }));

  // The x-axis spans the DATA, not the nominal window.
  //
  // Scaling to the full 30 minutes from the first sample onwards crams the first minute of the line
  // into 1/30th of the width — a vertical sliver against a vast empty panel, at exactly the moment
  // someone has opened the page to watch it. The buffer is trimmed to the window upstream, so once
  // it fills, this is the same thing; before then it simply zooms out as history accumulates.
  // Domain is [t1 - span, t1]: the newest sample sits on the RIGHT EDGE and time flows toward it.
  //
  // Anchoring on t0 instead left the axis running past the last data point, so every tick beyond it
  // computed as zero-seconds-ago and printed "now" four times in a row. Anchoring on t1 also gives
  // the right behaviour before the buffer has filled: the empty space lands on the left, which
  // honestly reads as "we have not been watching for that long" rather than implying missing data
  // in the recent past.
  const t0raw = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = Math.max(60000, t1 - t0raw);   // one-minute floor, so samples 3s apart stay readable
  const t0 = t1 - span;

  // Headroom so a flat line sits ON the baseline rather than floating mid-panel, and so the first
  // gallon of a new event is visible instead of pinned to the top.
  const peak = used.reduce((a, d) => Math.max(a, d.v), 0);
  const yMax = peak <= 0 ? 1 : peak * 1.25;

  const x = (t) => padL + ((t - t0) / span) * plotW;
  const y = (v) => padT + plotH - (v / yMax) * plotH;

  // Break the path wherever the sample gap says we stopped hearing the meter.
  const segments = [];
  let current = [used[0]];
  for (let i = 1; i < used.length; i++) {
    if (used[i].t - used[i - 1].t > gapMs) { segments.push(current); current = [used[i]]; }
    else current.push(used[i]);
  }
  segments.push(current);

  const toPath = (seg) => seg.map((d, i) => (i ? 'L' : 'M') + x(d.t).toFixed(1) + ' ' + y(d.v).toFixed(1)).join(' ');
  const last = used[used.length - 1];
  const lastSeg = segments[segments.length - 1];

  // Area fill only under the newest continuous run, so a gap does not get shaded as if observed.
  const areaPath = lastSeg.length > 1
    ? toPath(lastSeg) + ' L' + x(lastSeg[lastSeg.length - 1].t).toFixed(1) + ' ' + (padT + plotH).toFixed(1) +
      ' L' + x(lastSeg[0].t).toFixed(1) + ' ' + (padT + plotH).toFixed(1) + ' Z'
    : null;

  const ticks = [0, yMax / 2, yMax];
  const fmt = (v) => (yMax < 2 ? v.toFixed(1) : Math.round(v).toString());

  function onMove(e) {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    const tAt = t0 + ((px - padL) / plotW) * span;
    let best = null, bestD = Infinity;
    for (const d of used) {
      const dist = Math.abs(d.t - tAt);
      if (dist < bestD) { bestD = dist; best = d; }
    }
    if (best) setHover(best);
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <svg
        width={W} height={H} role="img"
        aria-label={'Water used in the last ' + Math.round(span / 60000) + ' minutes: ' + last.v.toFixed(1) + ' gallons'}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}
      >
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="var(--w-grid)" strokeWidth="1" />
            <text x={padL - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--w-axis)">{fmt(v)}</text>
            {showRight ? (
              <text x={W - padR + 8} y={y(v) + 4} fontSize="11" fill="var(--w-axis)">
                {Math.round(base + v).toLocaleString()}
              </text>
            ) : null}
          </g>
        ))}

        {/* Axis captions, so neither column of numbers is a mystery. */}
        <text x={padL - 6} y={9} textAnchor="end" fontSize="10" fill="var(--w-axis)">used</text>
        {showRight ? (
          <text x={W - padR + 8} y={9} fontSize="10" fill="var(--w-axis)">lifetime</text>
        ) : null}

        {areaPath ? <path d={areaPath} fill="var(--w-series-soft)" stroke="none" /> : null}

        {segments.map((seg, i) => (
          seg.length > 1
            ? <path key={i} d={toPath(seg)} fill="none" stroke="var(--w-series)" strokeWidth="2"
                    strokeLinejoin="round" strokeLinecap="round" />
            // A lone sample after a gap still deserves to be shown — as a point, not a line.
            : <circle key={i} cx={x(seg[0].t)} cy={y(seg[0].v)} r="2" fill="var(--w-series)" />
        ))}

        {/* The live end of the line. */}
        <circle cx={x(last.t)} cy={y(last.v)} r="4" fill="var(--w-series)" />
        <circle cx={x(last.t)} cy={y(last.v)} r="8" fill="var(--w-series)" opacity="0.18">
          <animate attributeName="r" values="5;11;5" dur="2.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.28;0;0.28" dur="2.4s" repeatCount="indefinite" />
        </circle>

        {hover ? (
          <line x1={x(hover.t)} x2={x(hover.t)} y1={padT} y2={padT + plotH}
                stroke="var(--w-axis)" strokeWidth="1" strokeDasharray="3 3" />
        ) : null}

        {/* A real time axis. Two end labels tell you nothing about WHEN a step happened — the
            whole point of a step is the moment it occurred. Tick count scales with width so the
            labels never collide; each is ~34px wide, so allow ~70px of breathing room apiece. */}
        {(() => {
          // Ticks land on ROUND intervals, counted back from now.
          //
          // Dividing the span into N equal slices produces labels like "4m 4m 3m 2m 90s 45s": two
          // neighbouring ticks round to the same minute, and the unit changes partway along the
          // axis. Both make the axis look broken. Choosing a round interval first — and one unit
          // for the whole axis — means every label is distinct and comparable.
          const maxTicks = Math.max(2, Math.min(7, Math.floor(plotW / 68)));
          const STEPS = [10e3, 15e3, 30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 60 * 60e3];
          const step = STEPS.find((s) => span / s <= maxTicks) || STEPS[STEPS.length - 1];
          const useSeconds = step < 60e3;                 // one unit for the whole axis
          const out = [];
          for (let t = t1, i = 0; t >= t0 - 1 && i < 40; t -= step, i++) {
            const px = x(t);
            if (px < padL - 1) break;
            const d = t1 - t;
            const label = d < 1000
              ? 'now'
              : useSeconds ? Math.round(d / 1000) + 's' : agoLabel(t, t1);
            out.push(
              <g key={i}>
                <line x1={px} x2={px} y1={padT + plotH} y2={padT + plotH + 3} stroke="var(--w-grid)" strokeWidth="1" />
                <text
                  x={px} y={H - 6} fontSize="11" fill="var(--w-axis)"
                  textAnchor={i === 0 ? 'end' : px < padL + 20 ? 'start' : 'middle'}
                >
                  {label}
                </text>
              </g>
            );
          }
          return out;
        })()}

        {/* The live reading, against the right-hand scale it belongs to. */}
        {showRight ? (
          <text x={W - padR + 8} y={y(last.v) + 4} fontSize="11" fontWeight="600" fill="var(--w-series)">
            {Math.round(base + last.v).toLocaleString()}
          </text>
        ) : null}
      </svg>

      {hover ? (
        <div
          className="w-tip"
          style={{ position: 'absolute', left: Math.min(Math.max(x(hover.t) - 60, 0), Math.max(0, W - 130)), top: 0 }}
        >
          {clock(hover.t, span)} · {hover.v.toFixed(1)} gal used · {Math.round(base + hover.v).toLocaleString()} total
        </div>
      ) : null}
    </div>
  );
}
