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

/**
 * Axis labels, in the METER's timezone.
 *
 * This used to call getHours()/getDay(), which are the BROWSER's timezone. On the machine in the
 * house those agree, so it looked correct and was not: opened from a laptop an hour east, every
 * label on the axis shifted while the banner above it — which has always used Intl with the meter's
 * zone — did not. Two clocks on one screen disagreeing about the same instant.
 *
 * Intl.DateTimeFormat with an explicit timeZone is the only way to be sure, and it is what every
 * other timestamp in this app already uses.
 */
function fmtTick(ms, spanMs, tz) {
  try {
    const opts = { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hour12: false };
    // Past 36 hours the hour alone is ambiguous — "08:00" appears three times on a 72h axis.
    if (spanMs > 36 * 3600e3) opts.weekday = 'short';
    return new Intl.DateTimeFormat('en-US', opts).format(new Date(ms)).replace(',', '');
  } catch (e) {
    return '';
  }
}

/** The hour-of-day, in the meter's zone. Needed to place the overnight band, not the browser's. */
function hourIn(ms, tz) {
  try {
    return Number(new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined, hour: '2-digit', hour12: false,
    }).format(new Date(ms))) % 24;
  } catch (e) { return new Date(ms).getHours(); }
}

// Wall clock in the METER's timezone. The tooltip has to agree with the "Last packet" stamp in the
// banner, and that one is explicitly house time — a laptop opened from another state must not show
// two different clocks for the same instant.
function fmtClock(ms, tz, seconds) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined, hour: '2-digit', minute: '2-digit',
      ...(seconds ? { second: '2-digit' } : {}), hour12: false,
    }).format(new Date(ms));
  } catch (e) { return ''; }
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
  tz,                 // the METER's timezone, so the tooltip clock matches the banner
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
  // Overnight bands, placed by the METER's hour-of-day.
  //
  // The old version walked calendar days with setHours(), which is the browser's zone — so on a
  // laptop in another state the shaded window drifted away from the 2-5am the alert rule actually
  // uses. Scanning the minute grid and asking "what hour is this THERE" cannot drift, and it costs
  // one Intl call per column rather than per row.
  const bands = [];
  if (overnight && overnight.length === 2 && overnight[1] > overnight[0]) {
    let open = null;
    const stepMs = Math.max(60000, span / 800);
    for (let t = t0; t <= t1 + stepMs; t += stepMs) {
      const h = hourIn(Math.min(t, t1), tz);
      const inside = h >= overnight[0] && h < overnight[1] && t <= t1;
      if (inside && open === null) open = t;
      if (!inside && open !== null) { bands.push([open, Math.min(t, t1)]); open = null; }
    }
    if (open !== null) bands.push([open, t1]);
  }

  const pulseMax = Math.max(1, cols.reduce((a, c) => Math.max(a, c.packets), 0));
  const colW = cols.length > 1 ? plotW / (cols.length - 1) : plotW;

  // X ticks on round intervals so labels are distinct and comparable.
  const maxTicks = Math.max(2, Math.min(7, Math.floor(plotW / 88)));
  const STEPS = [5 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3];
  const step = STEPS.find((sM) => span / sM <= maxTicks) || STEPS[STEPS.length - 1];

  // Everything hoverable, in one list. The live tail is included so you can rest the cursor on the
  // right-hand edge and read the packets as they land.
  const hoverPts = cols
    .map((c) => ({ t: c.t, odo: c.odo, packets: c.packets, live: false }))
    .concat(tailPts.map((p) => ({ t: p.t, odo: p.gallons, packets: null, live: true })));

  // Hover stores a TIMESTAMP, not the row under the cursor. Storing the row froze the tooltip at
  // the values it had when the mouse stopped moving — so resting on the live edge showed a number
  // that quietly went stale while new packets arrived behind it. Resolving the nearest point at
  // render time means the tooltip refreshes itself on every poll, which is the whole point of
  // hovering the live end.
  const hoverPt = hover === null ? null : hoverPts.reduce(
    (best, p) => (best === null || Math.abs(p.t - hover) < Math.abs(best.t - hover) ? p : best), null
  );

  function onMove(e) {
    const box = e.currentTarget.getBoundingClientRect();
    setHover(t0 + ((e.clientX - box.left - padL) / plotW) * span);
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
        {/* Where the stored rollup ends and the live tail begins. Without this the two are one
            continuous trace and it is not obvious which part of the chart is moving — the question
            "is this updating?" has to be answerable by looking, not by waiting a minute. */}
        {tailPts.length && cols.length ? (
          <g>
            <line x1={x(lastMinuteT)} x2={x(lastMinuteT)} y1={padT} y2={pulseTop + 4}
                  stroke="var(--w-good)" strokeWidth="1" strokeDasharray="2 3" opacity="0.55" />
            <text x={Math.min(x(lastMinuteT) + 5, W - padR - 26)} y={padT + 9}
                  fontSize="9" fontWeight="700" fill="var(--w-good)" opacity="0.85">LIVE</text>
          </g>
        ) : null}

        {/* The LIVE end of the pulse: one tick per packet actually observed by this page, not a
            per-minute count. This is the part that moves while you are looking at it — a new tick
            appears every few seconds when the radio is healthy. The stored minutes to its left are
            a summary; this is the raw thing happening now. */}
        {tailPts.map((p, i) => {
          const newest = i === tailPts.length - 1;
          return (
            <line key={'lt' + p.t} x1={x(p.t)} x2={x(p.t)} y1={pulseTop} y2={pulseTop - pulseH}
                  stroke="var(--w-good)" strokeWidth={newest ? 2 : 1.4}>
              {/* Keyed on the timestamp, so React mounts a NEW element for each arrival and the
                  animation actually replays. Keyed on the index it would reuse the node and the
                  tick would simply appear, which is exactly the "did anything happen?" problem. */}
              {newest ? <animate attributeName="y2" from={pulseTop} to={pulseTop - pulseH} dur="0.35s" /> : null}
              {newest ? <animate attributeName="stroke-width" values="3.5;2" dur="0.6s" /> : null}
            </line>
          );
        })}
        {tailPts.length ? (
          <circle cx={x(tailPts[tailPts.length - 1].t)} cy={pulseTop - pulseH / 2} r="3"
                  fill="var(--w-good)">
            <animate attributeName="opacity" values="1;0.15;1" dur="1.6s" repeatCount="indefinite" />
          </circle>
        ) : null}

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
                  {fmtTick(t, span, tz)}
                </text>
              </g>
            );
          }
          return out;
        })()}

        {hoverPt ? (
          <line x1={x(hoverPt.t)} x2={x(hoverPt.t)}
                y1={padT} y2={pulseTop} stroke="var(--w-axis)" strokeWidth="1" strokeDasharray="3 3" />
        ) : null}
        {hoverPt ? <circle cx={x(hoverPt.t)} cy={y(hoverPt.odo - base)} r="3.5" fill="var(--w-series)" /> : null}
      </svg>

      {hoverPt ? (
        <div className={'w-tip' + (hoverPt.live ? ' is-live' : '')} style={{
          position: 'absolute', top: 0,
          left: Math.min(Math.max(x(hoverPt.t) - 90, 0), Math.max(0, W - 220)),
        }}>
          <b>{fmtClock(hoverPt.t, tz, hoverPt.live)}</b>{' · '}
          {hoverPt.odo.toLocaleString(undefined, { maximumFractionDigits: 2 })} gal{' · '}
          {hoverPt.live
            ? <span className="w-tip-live">live packet</span>
            : hoverPt.packets > 0
              ? hoverPt.packets + ' packets/min'
              : <span style={{ color: 'var(--w-critical)' }}>no packets</span>}
        </div>
      ) : null}
    </div>
  );
}
