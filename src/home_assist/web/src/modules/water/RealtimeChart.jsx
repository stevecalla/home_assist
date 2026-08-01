import { useState, useRef, useLayoutEffect } from 'react';

// Measured pixels, never a stretched viewBox — same rule as every other chart here.
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

function fmtClock(ms, tz, seconds) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined, hour: '2-digit', minute: '2-digit',
      ...(seconds ? { second: '2-digit' } : {}), hour12: false,
    }).format(new Date(ms));
  } catch (e) { return ''; }
}

/**
 * RealtimeChart — every transmission, as it arrived.
 *
 * Three lanes on one time axis, because the granular question has three parts:
 *
 *   READING   the odometer, stepping at the exact second the meter ticked. Flat between steps is
 *             correct: the endpoint re-broadcasts the same total every few seconds and only moves
 *             when a whole gallon has passed. No amount of resolution changes that — the meter is
 *             the limit, not the sampling.
 *   SIGNAL    SNR per packet. This is the lane that earns the table its keep: a dip immediately
 *             before a gap says the RF path failed, a flat trace across a gap says something else
 *             did. One number cannot distinguish those; the shape can.
 *   PACKETS   one tick per decoded transmission, with silences marked in the alarm colour.
 *
 * Unlike the Heartbeat, nothing here is aggregated. What is drawn is what was received.
 */
export default function RealtimeChart({
  packets = [],       // [{ heard_at_utc, volume, snr, rssi, is_ours }] oldest first, OUR meter
  gaps = [],          // [{ start, end, seconds, missed, snr_before, snr_after }]
  secondsSince = null,// seconds since the last packet, aged by the parent's 1s tick
  tz,
  height = 260,
  emptyMessage = 'Waiting for the first transmission…',
}) {
  const [hover, setHover] = useState(null);
  const [ref, measured] = useWidth();

  const pts = (packets || []).filter((p) => p.volume !== null && p.volume !== undefined);
  if (pts.length < 2) {
    return <div ref={ref}><p className="muted" style={{ padding: '30px 0' }}>{emptyMessage}</p></div>;
  }

  const W = measured || 900;
  const H = height;
  const padL = 46, padR = 78, padT = 16, padB = 60;
  const plotW = Math.max(10, W - padL - padR);
  const readH = Math.max(10, H - padT - padB - 46);
  const snrTop = padT + readH + 14;
  const snrH = 22;
  const pkTop = snrTop + snrH + 16;

  const t0 = new Date(pts[0].heard_at_utc).getTime();
  const t1 = new Date(pts[pts.length - 1].heard_at_utc).getTime();
  const span = Math.max(1000, t1 - t0);
  const x = (t) => padL + ((t - t0) / span) * plotW;

  const base = pts[0].volume;
  const peak = pts.reduce((a, p) => Math.max(a, p.volume), base);
  const usedMax = Math.max(1, (peak - base) * 1.25);
  const y = (used) => padT + readH - (used / usedMax) * readH;

  // Stepped: the odometer holds its value until it ticks. A diagonal would claim water flowed
  // smoothly between two packets that reported the identical total.
  let d = '';
  pts.forEach((p, i) => {
    const px = x(new Date(p.heard_at_utc).getTime());
    const py = y(p.volume - base);
    if (i === 0) { d += `M${px.toFixed(1)} ${py.toFixed(1)}`; return; }
    const prevY = y(pts[i - 1].volume - base);
    d += ` L${px.toFixed(1)} ${prevY.toFixed(1)} L${px.toFixed(1)} ${py.toFixed(1)}`;
  });
  const last = pts[pts.length - 1];
  const lastX = x(new Date(last.heard_at_utc).getTime());
  const lastY = y(last.volume - base);

  const snrPts = pts.filter((p) => p.snr !== null && p.snr !== undefined);
  const snrLo = 5, snrHi = 30;
  const ys = (v) => snrTop + snrH - ((Math.max(snrLo, Math.min(v, snrHi)) - snrLo) / (snrHi - snrLo)) * snrH;
  let sd = '';
  snrPts.forEach((p, i) => {
    const px = x(new Date(p.heard_at_utc).getTime());
    sd += (i === 0 ? 'M' : ' L') + px.toFixed(1) + ' ' + ys(p.snr).toFixed(1);
  });

  const ticks = [0, usedMax / 2, usedMax];
  const fmtUsed = (v) => (usedMax < 4 ? v.toFixed(1) : Math.round(v).toString());

  const maxTicks = Math.max(2, Math.min(7, Math.floor(plotW / 92)));
  const STEPS = [10e3, 30e3, 60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3];
  const step = STEPS.find((sM) => span / sM <= maxTicks) || STEPS[STEPS.length - 1];

  function onMove(e) {
    const box = e.currentTarget.getBoundingClientRect();
    setHover(t0 + ((e.clientX - box.left - padL) / plotW) * span);
  }
  const hoverPt = hover === null ? null : pts.reduce(
    (best, p) => {
      const t = new Date(p.heard_at_utc).getTime();
      return best === null || Math.abs(t - hover) < Math.abs(new Date(best.heard_at_utc).getTime() - hover) ? p : best;
    }, null
  );

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <svg width={W} height={H} role="img" onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        aria-label={'Meter reading ' + Math.round(last.volume) + '; ' + pts.length + ' transmissions in this window'}>

        <text x={padL - 6} y={11} textAnchor="end" fontSize="10" fill="var(--w-axis)">used</text>
        <text x={W - padR + 8} y={11} fontSize="10" fill="var(--w-axis)">reading</text>

        {/* Gap bands span the full height on purpose: the silence is a property of the whole
            picture, not of the packet lane alone. */}
        {gaps.map((g, i) => {
          const gs = Math.max(new Date(g.start).getTime(), t0);
          const ge = Math.min(new Date(g.end).getTime(), t1);
          if (ge <= gs) return null;
          return (
            <g key={'g' + i}>
              <rect x={x(gs)} y={padT} width={Math.max(2, x(ge) - x(gs))} height={pkTop - padT}
                    fill="var(--w-critical)" opacity="0.08" />
              {x(ge) - x(gs) > 26 ? (
                <text x={(x(gs) + x(ge)) / 2} y={padT - 4} textAnchor="middle" fontSize="9"
                      fontWeight="700" fill="var(--w-critical)">{g.seconds}s</text>
              ) : null}
            </g>
          );
        })}

        {ticks.map((v, i) => (
          <g key={'t' + i}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="var(--w-grid)" strokeWidth="1" />
            <text x={padL - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--w-axis)">{fmtUsed(v)}</text>
            <text x={W - padR + 8} y={y(v) + 4} fontSize="11" fill="var(--w-axis)">
              {Math.round(base + v).toLocaleString()}
            </text>
          </g>
        ))}

        <path d={d} fill="none" stroke="var(--w-series)" strokeWidth="2.2" strokeLinejoin="round" />
        <circle cx={lastX} cy={lastY} r="4" fill="var(--w-series)" />
        <circle cx={lastX} cy={lastY} r="10" fill="var(--w-series)" opacity="0.18">
          <animate attributeName="r" values="5;12;5" dur="2.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.28;0;0.28" dur="2.4s" repeatCount="indefinite" />
        </circle>

        {/* ── signal ─────────────────────────────────────────────────────────────── */}
        <text x={padL - 6} y={snrTop + 4} textAnchor="end" fontSize="10" fill="var(--w-axis)">snr</text>
        {/* The 10 dB line is where packets start dropping — drawn so the trace is read against the
            threshold that matters rather than against its own range. */}
        <line x1={padL} x2={W - padR} y1={ys(10)} y2={ys(10)} stroke="var(--w-critical)"
              strokeWidth="0.8" strokeDasharray="3 4" opacity="0.5" />
        <text x={W - padR + 8} y={ys(10) + 3} fontSize="9" fill="var(--w-critical)" opacity="0.8">10 dB</text>
        <text x={W - padR + 8} y={snrTop + 4} fontSize="9" fill="var(--w-axis)">30</text>
        {sd ? <path d={sd} fill="none" stroke="var(--w-serious)" strokeWidth="1.3" /> : null}

        {/* ── packets ────────────────────────────────────────────────────────────── */}
        <text x={padL - 6} y={pkTop + 4} textAnchor="end" fontSize="10" fill="var(--w-axis)">packets</text>
        {pts.map((p, i) => {
          const px = x(new Date(p.heard_at_utc).getTime());
          const newest = i === pts.length - 1;
          return (
            <line key={'p' + p.heard_at_utc} x1={px} x2={px} y1={pkTop} y2={pkTop - (newest ? 13 : 10)}
                  stroke="var(--w-good)" strokeWidth={newest ? 2 : 1}>
              {/* Keyed on the timestamp so React MOUNTS a new element per arrival and the animation
                  replays. Keyed on the index it would reuse the node and the tick would simply
                  appear — which is the "did anything just happen?" problem this exists to answer. */}
              {newest ? <animate attributeName="y2" from={pkTop} to={pkTop - 13} dur="0.3s" /> : null}
              {newest ? <animate attributeName="stroke-width" values="4;2" dur="0.55s" /> : null}
            </line>
          );
        })}
        {gaps.map((g, i) => {
          const gs = Math.max(new Date(g.start).getTime(), t0);
          const ge = Math.min(new Date(g.end).getTime(), t1);
          if (ge <= gs) return null;
          return <rect key={'gb' + i} x={x(gs)} y={pkTop} width={Math.max(3, x(ge) - x(gs))}
                       height={6} fill="var(--w-critical)" />;
        })}
        <line x1={padL} x2={W - padR} y1={pkTop} y2={pkTop} stroke="var(--w-grid)" strokeWidth="0.6" />

        {/* ── the live edge ────────────────────────────────────────────────────────────────────
            Every point on this chart is live, so the Heartbeat's dashed "stored | live" divider
            would be meaningless here — there is nothing stale to divide from. What is needed
            instead is proof the RIGHT EDGE is still moving: a pulsing marker anchored to the
            newest packet, plus the elapsed seconds since it landed. A marker that stops pulsing,
            or a number that keeps climbing, is the failure showing itself. */}
        <line x1={lastX} x2={lastX} y1={padT} y2={pkTop} stroke="var(--w-good)"
              strokeWidth="1" strokeDasharray="2 3" opacity="0.45" />
        <circle cx={lastX} cy={pkTop - 6} r="3.2" fill="var(--w-good)">
          <animate attributeName="opacity" values="1;0.15;1" dur="1.5s" repeatCount="indefinite" />
        </circle>
        <g transform={'translate(' + Math.min(lastX + 6, W - padR - 46) + ',' + (padT + 2) + ')'}>
          <circle cx="4" cy="4" r="3.2" fill="var(--w-good)">
            <animate attributeName="opacity" values="1;0.2;1" dur="1.5s" repeatCount="indefinite" />
          </circle>
          <text x="11" y="7.5" fontSize="9" fontWeight="700" fill="var(--w-good)">LIVE</text>
          {secondsSince === null ? null : (
            <text x="11" y="19" fontSize="9" fill={secondsSince > 30 ? 'var(--w-critical)' : 'var(--w-axis)'}>
              {secondsSince}s ago
            </text>
          )}
        </g>

        {(() => {
          const out = [];
          const first = Math.ceil(t0 / step) * step;
          for (let t = first; t <= t1 && out.length < 12; t += step) {
            const px = x(t);
            out.push(
              <g key={'x' + t}>
                <line x1={px} x2={px} y1={pkTop + 4} y2={pkTop + 8} stroke="var(--w-grid)" />
                <text x={px} y={pkTop + 21} fontSize="11" fill="var(--w-axis)" textAnchor="middle">
                  {fmtClock(t, tz, span < 10 * 60e3)}
                </text>
              </g>
            );
          }
          return out;
        })()}

        {hoverPt ? (
          <line x1={x(new Date(hoverPt.heard_at_utc).getTime())} x2={x(new Date(hoverPt.heard_at_utc).getTime())}
                y1={padT} y2={pkTop} stroke="var(--w-axis)" strokeWidth="1" strokeDasharray="3 3" />
        ) : null}
      </svg>

      {hoverPt ? (
        <div className="w-tip is-live" style={{
          position: 'absolute', top: 0,
          left: Math.min(Math.max(x(new Date(hoverPt.heard_at_utc).getTime()) - 100, 0), Math.max(0, W - 240)),
        }}>
          <b>{fmtClock(new Date(hoverPt.heard_at_utc).getTime(), tz, true)}</b>{' · '}
          {Number(hoverPt.volume).toLocaleString()} gal{' · '}
          {hoverPt.snr === null || hoverPt.snr === undefined
            ? <span className="muted">no signal data</span>
            : <>snr {hoverPt.snr} dB{hoverPt.rssi === null || hoverPt.rssi === undefined ? null : <> · rssi {hoverPt.rssi}</>}</>}
        </div>
      ) : null}
    </div>
  );
}
