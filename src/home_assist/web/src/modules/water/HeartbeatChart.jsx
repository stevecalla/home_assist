import { useState, useRef, useLayoutEffect } from 'react';

// Measured pixels, never a stretched viewBox — same rule as the other charts. A fixed viewBox with
// preserveAspectRatio="none" squashes the axis text on a phone, which is where this gets read.
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

// Clock labels, in the METER's timezone. Relative labels ("2h ago") were tried and rejected: on a
// 72-hour window you want to say "it started Thursday evening", not do arithmetic.
function fmtTick(ms, spanMs) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (spanMs > 36 * 3600e3) {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + hh + ':' + mm;
  }
  return hh + ':' + mm;
}

const LEVEL_COLOR = { running: 'var(--w-series)', long: 'var(--w-serious)', continuous: 'var(--w-critical)' };

/**
 * HeartbeatChart — the meter reading, plus proof the meter is being read.
 *
 * Two traces sharing one time axis, because neither answers the question alone:
 *
 *   READING (blue)  the odometer. Flat whenever no water moves — which is most of the time, and is
 *                   correct. A flat reading tells you nothing about whether the radio still works.
 *   PULSE (green)   packets heard per minute. Beats continuously while the receiver is alive, so a
 *                   FLATLINE here is the honest signal that the reading above it has gone stale.
 *
 * Flat reading + healthy pulse  = nobody used water.
 * Flat reading + flatline       = you are not being read, and the number on screen is old.
 * Those two look identical on any single-line chart. That is why the pulse exists.
 *
 * RUN BANDS mark where a continuous run happened, coloured by level. Normal use is a step: up, then
 * flat. A run that never flattens is the thing this whole app exists to catch, and at 72 hours you
 * need to see WHEN it happened, not only that it is happening now.
 */
export default function HeartbeatChart({
  series,             // [{ minute_utc, minute_mtn, odometer, packets }]  per-minute, from MySQL
  tail = [],          // [{ t, gallons }]  the LIVE tail, straight off the 5s status poll
  runs = [],          // [{ start, end, minutes, level }]
  overnight,          // [startHour, endHour] or null
  height = 250,
  emptyMessage = 'Waiting for the first reading…',
}) {
  const [hover, setHover] = useState(null);
  const [ref, measured] = useWidth();

  // Two views of the same rows, and the difference matters:
  //   all  every recorded minute — this is what the PULSE draws, including the minutes we heard
  //        nothing. Filtering those out would delete exactly the outage the pulse exists to show.
  //   pts  the minutes that carry an odometer — the scale for the reading line.
  const all = (series || []);
  const pts = all.filter((d) => d.odometer !== null && d.odometer !== undefined);

  // The LIVE TAIL. `series` is a per-minute rollup, so on its own the line can only ever move once
  // a minute — you turn on a tap and stare at a flat line for up to 60 seconds wondering whether
  // anything works. The tail is the same odometer read straight from water_collector_state on the
  // 5-second poll, appended past the last stored minute, so the line moves while you are watching.
  //
  // Only the READING gets sub-minute resolution. The pulse stays per-minute on purpose: it answers
  // "is the radio alive", which is a question about a whole minute, and a per-poll pulse would just
  // be the poll interval drawn back at you.
  const lastMinuteT = pts.length ? new Date(pts[pts.length - 1].minute_utc).getTime() : 0;
  const tailPts = (tail || [])
    .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.gallons) && p.t > lastMinuteT)
    .sort((a, b) => a.t - b.t);

  if (pts.length + tailPts.length < 2) {
    return <div ref={ref}><p className="muted" style={{ padding: '30px 0' }}>{emptyMessage}</p></div>;
  }

  const W = measured || 900;
  const H = height;
  // Right gutter holds a 7-digit odometer; left holds the small "used" numbers.
  const padL = 44, padR = 74, padT = 18, padB = 58;
  const plotW = Math.max(10, W - padL - padR);
  const readingH = Math.max(10, H - padT - padB);      // the blue trace
  const pulseTop = padT + readingH + 22;               // the green trace, below it
  const pulseH = 16;

  const t0 = all.length ? new Date(all[0].minute_utc).getTime() : tailPts[0].t;
  // t1 is the LIVE edge — the tail runs past the last stored minute, and the axis has to follow it
  // or the newest points pile up on top of the last gridline.
  const t1 = Math.max(
    all.length ? new Date(all[all.length - 1].minute_utc).getTime() : 0,
    tailPts.length ? tailPts[tailPts.length - 1].t : 0
  );
  const span = Math.max(60000, t1 - t0);

  // ── downsample to one column per ~2 physical pixels ────────────────────────────────────────
  // At 72 hours that is 4,320 minutes across ~1,100px. Drawn raw, the pulse ticks overlap into a
  // solid green bar — which reads as "everything is fine" no matter what the data says.
  //
  // The aggregate is deliberately asymmetric:
  //   packets -> MIN over the bucket, so a SINGLE dead minute inside a four-minute bucket still
  //              draws a flatline. On a monitor the worst minute is the one worth seeing; an
  //              average would quietly dissolve exactly the outage this trace exists to expose.
  //   odometer -> LAST, because it is a running total, not a sample to be averaged.
  const cols = (() => {
    const target = Math.max(2, Math.min(all.length, Math.floor(plotW / 2)));
    const bucket = new Array(target).fill(null);
    for (const p of all) {
      const t = new Date(p.minute_utc).getTime();
      const i = Math.min(target - 1, Math.max(0, Math.floor(((t - t0) / span) * (target - 1))));
      const pk = p.packets || 0;
      const odo = (p.odometer === null || p.odometer === undefined) ? null : p.odometer;
      const cur = bucket[i];
      if (!cur) bucket[i] = { t, odo, packets: pk, src: p };
      else {
        cur.t = t; cur.src = p;
        if (odo !== null) cur.odo = odo;
        if (pk < cur.packets) cur.packets = pk;
      }
    }
    // Carry the last known odometer forward across minutes that carry none. The meter reading did
    // not change while we were deaf — but we did not SEE that it did not change, which is precisely
    // the claim the flatline underneath is there to qualify.
    let carried = null;
    // Anything still unknown is a stretch BEFORE the first reading — held at the first known value
    // rather than dropped, because dropping it would take the pulse for those minutes with it, and
    // "the collector just started and heard nothing" is a case worth seeing, not hiding.
    const first = pts.length ? pts[0].odometer : tailPts[0].gallons;
    return bucket.filter(Boolean).map((c) => {
      if (c.odo !== null) carried = c.odo;
      return c.odo === null ? { ...c, odo: carried === null ? first : carried } : c;
    });
  })();

  const base = pts.length ? pts[0].odometer : tailPts[0].gallons;
  const peak = Math.max(
    pts.reduce((a, d) => Math.max(a, d.odometer), base),
    tailPts.reduce((a, d) => Math.max(a, d.gallons), base)
  );
  // Headroom so the live tip is not welded to the top gridline, and a floor so a totally flat
  // window still renders a sensible axis instead of dividing by zero.
  const usedMax = Math.max(1, (peak - base) * 1.25);

  const x = (t) => padL + ((t - t0) / span) * plotW;
  const y = (used) => padT + readingH - (used / usedMax) * readingH;

  // Stepped path: the odometer holds its value until it ticks, so a diagonal would imply water
  // flowing smoothly between readings when it did not.
  // The stored minutes and the live tail are ONE path, not two series: it is the same odometer,
  // just read at two resolutions. A separate line would imply a second measurement.
  const linePts = cols.map((c) => ({ t: c.t, odo: c.odo }))
    .concat(tailPts.map((p) => ({ t: p.t, odo: p.gallons })));
  let d = '';
  linePts.forEach((c, i) => {
    const px = x(c.t);
    const py = y(c.odo - base);
    d += i === 0 ? `M${px.toFixed(1)} ${py.toFixed(1)}` : ` L${px.toFixed(1)} ${py.toFixed(1)}`;
  });
  const last = linePts[linePts.length - 1];
  const lastX = x(last.t);
  const lastY = y(last.odo - base);
  const lastOdo = last.odo;

  const ticks = [0, usedMax / 2, usedMax];
  const fmtUsed = (v) => (usedMax < 4 ? v.toFixed(1) : Math.round(v).toString());

  // Overnight bands: one per local night inside the window.
  const bands = [];
  if (overnight && overnight.length === 2 && overnight[1] > overnight[0]) {
    const cur = new Date(t0);
    cur.setHours(0, 0, 0, 0);
    for (let day = 0; day <= Math.ceil(span / 86400e3) + 1; day++) {
      const s = new Date(cur); s.setDate(cur.getDate() + day); s.setHours(overnight[0], 0, 0, 0);
      const e = new Date(s); e.setHours(overnight[1], 0, 0, 0);
      if (e.getTime() < t0 || s.getTime() > t1) continue;
      bands.push([Math.max(s.getTime(), t0), Math.min(e.getTime(), t1)]);
    }
  }

  const pulseMax = Math.max(1, cols.reduce((a, c) => Math.max(a, c.packets), 0));
  const colW = cols.length > 1 ? plotW / (cols.length - 1) : plotW;

  // X ticks on round intervals so labels are distinct and comparable.
  const maxTicks = Math.max(2, Math.min(7, Math.floor(plotW / 88)));
  const STEPS = [5 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3];
  const step = STEPS.find((sM) => span / sM <= maxTicks) || STEPS[STEPS.length - 1];

  function onMove(e) {
    const box = e.currentTarget.getBoundingClientRect();
    const tAt = t0 + ((e.clientX - box.left - padL) / plotW) * span;
    let best = null, bestD = Infinity;
    for (const c of cols) {
      const dist = Math.abs(c.t - tAt);
      // Report the BUCKET's packet count, not the raw minute under the cursor: the tooltip has to
      // agree with the mark it is pointing at, and the mark is the bucket's worst minute.
      if (dist < bestD) { bestD = dist; best = { ...c.src, packets: c.packets }; }
    }
    if (best) setHover(best);
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <svg width={W} height={H} role="img" onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        aria-label={'Meter reading ' + Math.round(lastOdo) + ' gallons'}>

        <text x={padL - 6} y={11} textAnchor="end" fontSize="10" fill="var(--w-axis)">used</text>
        <text x={W - padR + 8} y={11} fontSize="10" fill="var(--w-axis)">reading</text>

        {bands.map(([s, e], i) => (
          <rect key={'b' + i} x={x(s)} y={padT} width={Math.max(1, x(e) - x(s))} height={readingH}
                fill="var(--w-band)" />
        ))}

        {/* Run bands sit above the overnight tint but below the line. */}
        {(() => {
          // Labels are laid out left to right with a minimum gap. Six runs in a 72-hour window
          // otherwise print six captions on top of each other at the right edge, which is how you
          // turn a useful annotation into a smear. The BAND always draws; only the caption is
          // rationed, and a continuous run always wins the slot over a merely long one.
          let lastLabelX = -Infinity;
          const ordered = runs
            .map((r, i) => ({ r, i }))
            .filter(({ r }) => r.level !== 'running')            // short runs are normal; don't shout
            .sort((a, b) => new Date(a.r.start) - new Date(b.r.start));
          return ordered.map(({ r, i }) => {
            const rs = Math.max(new Date(r.start).getTime(), t0);
            const re = Math.min(new Date(r.end).getTime(), t1);
            if (re <= rs) return null;
            const mid = Math.min(Math.max((x(rs) + x(re)) / 2, padL + 52), W - padR - 52);
            const room = mid - lastLabelX >= 104;
            const label = room || r.level === 'continuous';
            if (label) lastLabelX = mid;
            return (
              <g key={'r' + i}>
                <rect x={x(rs)} y={padT} width={Math.max(2, x(re) - x(rs))} height={readingH}
                      fill={LEVEL_COLOR[r.level]} opacity="0.09" />
                {label ? (
                  <text x={mid} y={padT - 5} textAnchor="middle" fontSize="9.5"
                        fontWeight="700" fill={LEVEL_COLOR[r.level]}>
                    {r.level === 'continuous' ? 'CONTINUOUS RUN ' : 'LONG RUN '}
                    {r.minutes >= 60 ? Math.floor(r.minutes / 60) + 'h ' + (r.minutes % 60) + 'm' : r.minutes + 'm'}
                  </text>
                ) : null}
              </g>
            );
          });
        })()}

        {ticks.map((v, i) => (
          <g key={'t' + i}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="var(--w-grid)" strokeWidth="1" />
            <text x={padL - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--w-axis)">{fmtUsed(v)}</text>
            {/* Match the LEFT axis's precision. Rounding to whole gallons on a 1-gallon window
                printed the same number three times, which reads as a broken axis. */}
            <text x={W - padR + 8} y={y(v) + 4} fontSize="11" fill="var(--w-axis)">
              {(usedMax < 4
                ? (base + v).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
                : Math.round(base + v).toLocaleString())}
            </text>
          </g>
        ))}

        <path d={d} fill="none" stroke="var(--w-series)" strokeWidth="2.2" strokeLinejoin="round" />

        <circle cx={lastX} cy={lastY} r="4.5" fill="var(--w-series)" />
        <circle cx={lastX} cy={lastY} r="10" fill="var(--w-series)" opacity="0.18">
          <animate attributeName="r" values="5;12;5" dur="2.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.28;0;0.28" dur="2.4s" repeatCount="indefinite" />
        </circle>
        <text x={W - padR + 8} y={lastY + 4} fontSize="11" fontWeight="700" fill="var(--w-series)">
          {Math.round(lastOdo).toLocaleString()}
        </text>

        {/* ── the pulse ───────────────────────────────────────────────────────────── */}
        <text x={padL - 6} y={pulseTop + 4} textAnchor="end" fontSize="10" fill="var(--w-axis)">pulse</text>
        {cols.map((c, i) => {
          const px = x(c.t);
          const heard = c.packets > 0;
          const h = heard ? Math.max(2, (c.packets / pulseMax) * pulseH) : 0;
          return heard
            ? <line key={'p' + i} x1={px} x2={px} y1={pulseTop} y2={pulseTop - h}
                    stroke="var(--w-good)" strokeWidth="1" />
            // A minute with no packets is drawn as a FLATLINE segment, in the alarm colour, and
            // widened to at least 3px so a one-minute outage inside a 72-hour window is still
            // visible. This is the one mark on the chart that means "the number above is not to be
            // trusted" — it must never be the thing that gets lost to downsampling.
            // Heard nothing. Drawn DOWNWARD from the baseline, not upward: a tall red bar in the
            // same direction as the pulse would read as "lots of packets" at a glance, which is the
            // exact opposite of what it means. Green up = heard; red down = deaf.
            : <rect key={'p' + i} x={px - Math.max(1.5, colW / 2)} width={Math.max(3, colW)}
                    y={pulseTop} height={7} fill="var(--w-critical)" />;
        })}
        <line x1={padL} x2={W - padR} y1={pulseTop} y2={pulseTop} stroke="var(--w-grid)" strokeWidth="0.6" />

        {(() => {
          const out = [];
          const first = Math.ceil(t0 / step) * step;
          for (let t = first; t <= t1 && out.length < 12; t += step) {
            const px = x(t);
            out.push(
              <g key={'x' + t}>
                <line x1={px} x2={px} y1={pulseTop + 4} y2={pulseTop + 8} stroke="var(--w-grid)" />
                <text x={px} y={pulseTop + 21} fontSize="11" fill="var(--w-axis)" textAnchor="middle">
                  {fmtTick(t, span)}
                </text>
              </g>
            );
          }
          return out;
        })()}

        {hover ? (
          <line x1={x(new Date(hover.minute_utc).getTime())} x2={x(new Date(hover.minute_utc).getTime())}
                y1={padT} y2={pulseTop} stroke="var(--w-axis)" strokeWidth="1" strokeDasharray="3 3" />
        ) : null}
      </svg>

      {hover ? (
        <div className="w-tip" style={{
          position: 'absolute', top: 0,
          left: Math.min(Math.max(x(new Date(hover.minute_utc).getTime()) - 90, 0), Math.max(0, W - 200)),
        }}>
          {String(hover.minute_mtn || '').slice(11, 16)} · {Math.round(hover.odometer).toLocaleString()} gal ·{' '}
          {hover.packets > 0 ? hover.packets + ' packets' : <span style={{ color: 'var(--w-critical)' }}>no packets</span>}
        </div>
      ) : null}
    </div>
  );
}
