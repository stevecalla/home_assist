import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import BarChart from './BarChart.jsx';
import HeartbeatChart from './HeartbeatChart.jsx';
import RealtimeChart from './RealtimeChart.jsx';
import DataGrid from '../../components/DataGrid.jsx';
import CollapsibleCard from '../../components/CollapsibleCard.jsx';
import CardTools from '../../components/CardTools.jsx';
import SqlPanel from './SqlPanel.jsx';
import './water.css';

// The Monitor — the page you open when you wonder "is water running right now?"
//
// Ordered by what matters: the verdict first (a leak monitor whose answer you have to hunt for has
// failed), then whether the receiver is even alive, then the numbers, then the meter itself.
//
// EVERY card below is collapsible and every card except the meter starts CLOSED. The meter card is
// the reason the page exists — the continuous-run readout and the heartbeat — so it is the one
// thing you should never have to click to see. The rest is context you go looking for.
const POLL_MS = 5000;          // status: the banner, the tiles, the run meter
const SERIES_MS = 30000;       // the meter series: 4,000-odd rows, not worth re-fetching every 5s

const BANNER = {
  ok:      { icon: '✓', cls: 'ok' },
  leak:    { icon: '⚠', cls: 'leak' },
  offline: { icon: '📵', cls: 'offline' },
  unknown: { icon: '…', cls: 'unknown' },
};

// The continuous-run states. Icon AND word always travel together — color never carries the
// meaning on its own, which is the same rule the charts follow.
const RUN = {
  idle:       { icon: '○', word: 'Idle',       note: () => '' },
  running:    { icon: '💧', word: 'Running',    note: (r) => `normal so far — flagged past ${fmtDur(r.warn_min)}` },
  long:       { icon: '⏱', word: 'Running a long time', note: () => 'longer than a shower or a dishwasher cycle — worth a look' },
  continuous: { icon: '⚠', word: 'CONTINUOUS FLOW', note: (r) => `over ${fmtDur(r.alarm_min)} unbroken — that is not a fixture` },
};

const HOUR_CHIPS = [1, 6, 24, 72];
const DAY_CHIPS = [7, 30, 90, 365];
// Minutes, for the Real time tab. 15 minutes is about 225 transmissions — enough to see the shape
// of the last few gallons without the packet lane becoming a solid block.
const RT_CHIPS = [{ m: 15, label: '15m' }, { m: 60, label: '1h' }, { m: 360, label: '6h' }, { m: 1440, label: '24h' }];
// At ~4 seconds a packet: 15m is ~215 rows, 1h ~860, 6h ~5,100, 24h ~20,600.
//
// TWO independent controls, because they answer different questions and conflating them is what
// made "why only 200 rows?" a reasonable thing to ask:
//
//   the RANGE chips  how far BACK to look          — 15m saw ~215 rows because that is 15 minutes
//   the ROWS chips   how many of that to LOAD      — the cap on fetching and painting
//
// The row counts are a ladder rather than a free number: past a few thousand the browser, not the
// database, is the limit, and a text box inviting "50000" would invite a frozen tab.
const RT_ROW_CHIPS = [200, 500, 2000, 10000];
const RT_ROWS_DEFAULT = 500;
const RT_MS = 4000;         // matched to the meter's transmit cadence — a new row per poll

const MODE_TITLE = {
  realtime: 'Water — every transmission',
  heartbeat: 'Water — meter heartbeat',
  long: 'Water — daily totals',
};

// Signal bands come from the API (rules.SIGNAL_QUALITY) so the badge here and any future alert on
// reception quality can never disagree about what "weak" means.
function band_of(quality, kind, value) {
  if (value === null || value === undefined || !quality || !quality[kind]) return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  for (const b of quality[kind].bands) if (b.min === null || v >= b.min) return b;
  return null;
}

/**
 * What every number on this card means, and what a good one looks like.
 *
 * The table headers have carried definitions since they were built; the readout numbers above them
 * did not, which is the inconsistency that had someone asking what "13.9%" meant. Each entry names
 * the SETTING behind it where one exists, so "where do I change this" is answerable from the number
 * itself rather than by hunting the Settings page.
 */
const METRIC_HELP = {
  reading: 'The lifetime odometer, exactly as the meter transmits it — the same number as the dial in the pit. It only ever goes up, and only in whole gallons.',
  since: 'Seconds since the last decoded transmission. About 4s is normal; past 60s is worth noticing; past two minutes the receiver-silent watchdog will eventually agree. Setting: stale_minutes (Settings → Alerts).',
  shown: 'How many transmissions are loaded into THIS view. Not how many are in the window and not how many are stored — the rows chips control this one.',
  interval: 'The typical gap between transmissions, measured from your own packets rather than assumed. Median, not average, so one dropout cannot drag it up.',
  decoded: 'Packets heard divided by packets that should have arrived, measured over the span actually recorded — not the whole window. 95%+ is a healthy antenna. Below 80% you are losing packets and the gaps list will say where.',
  snr: 'Signal-to-noise on the most recent packets — the number that predicts whether a packet decodes at all. Above 18 dB is comfortable, 10-18 dB works but drops packets, below 10 dB is where gaps begin. Move the antenna to raise this.',
  gaps: 'Silences longer than three times the measured interval. Zero is what you want. Each one is listed below with the signal either side, which is what separates an RF path problem from interference.',
  used_window: 'Gallons the odometer advanced across this window. Zero is the normal overnight answer.',
  pulse: 'Average packets per minute over the last ten minutes of the stored rollup. Around 14 is healthy for a meter transmitting every 4 seconds.',
  today: 'Gallons since local midnight, from the hourly rollup.',
  overnight: 'Gallons used inside the overnight window. This is the one that catches a running toilet, because nothing legitimate should run at 3am. Settings: overnight_start_hour, overnight_end_hour, overnight_threshold_gal.',
  last24: 'A rolling 24 hours, not "today" — it includes last night.',
  avg: 'Mean of the previous 7 COMPLETE days. Today is excluded because a partial day would drag it down all morning.',
  run: 'How long water has been moving without a break. Duration, not volume, is the measurement — every fixture in a house stops on its own, so something that never stops is the thing worth waking you. Settings: run_warn_min, run_alarm_min.',
};

function fmtDur(min) {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

export default function Monitor() {
  const [status, setStatus] = useState(null);
  const [hourly, setHourly] = useState(null);
  const [alerts, setAlerts] = useState(null);
  const [meter, setMeter] = useState(null);
  const [rt, setRt] = useState(null);
  const [rtMin, setRtMin] = useState(15);
  const [rtRowLimit, setRtRowLimit] = useState(RT_ROWS_DEFAULT);
  const [rtScope, setRtScope] = useState('mine');
  const [tail, setTail] = useState([]);
  // A 1-second tick, used only to age the "last packet" counter. The data poll stays at 5s — this
  // is about the DISPLAY being visibly alive, not about asking the server more often.
  const [tick, setTick] = useState(() => Date.now());
  // `beat` changes whenever a NEW packet lands. It is used as a React key on the counter, which
  // remounts the element and therefore replays its animation. A class toggle would need a timer to
  // remove it, and would silently fail to re-fire when two packets land inside the animation.
  const [beat, setBeat] = useState(0);
  const lastHeardRef = useRef(null);
  const [err, setErr] = useState('');

  // Meter-card controls.
  //
  // Real time, this meter, as a table is the default because it is the view that answers the
  // question this card exists for — "what is the radio doing right now" — without needing a
  // reading of the picture first. The other two tabs are context you go looking for.
  const [mode, setMode] = useState('realtime');
  const [hours, setHours] = useState(72);
  const [days, setDays] = useState(30);
  const [hoursText, setHoursText] = useState('72');
  const [daysText, setDaysText] = useState('30');

  // Expand all / Collapse all. `forceKey` is what makes a repeated command work — see
  // CollapsibleCard for why a bare boolean is not enough.
  // ⇄ Table: the numbers behind the picture, on screen, without downloading anything. A chart you
  // cannot read the values off is a chart you have to take on faith.
  //
  // Kept PER MODE rather than as one flag. Real time opens as a table (the rows are the point);
  // Heartbeat and Long view open as charts (the shape is the point). One shared flag would mean
  // switching tabs silently changed what the other tab looked like, and flipping one to a table
  // would turn all three into tables.
  const [flipBy, setFlipBy] = useState({ realtime: true, heartbeat: false, long: false });
  const flipMeter = !!flipBy[mode];
  const setFlipMeter = (v) => setFlipBy((f) => ({ ...f, [mode]: v }));
  const [flipHourly, setFlipHourly] = useState(false);

  const [force, setForce] = useState({ open: undefined, key: 0 });
  const forceAll = (open) => setForce((f) => ({ open, key: f.key + 1 }));

  const rtRef = useRef(null);
  const hbRef = useRef(null);
  const longRef = useRef(null);
  const hourlyRef = useRef(null);

  // The live tail. `/api/water/meter` returns a per-MINUTE series, so on its own the chart can only
  // move once a minute — you open a tap and watch a flat line, which is the exact opposite of what
  // this card is for. The 5-second status poll already carries the current odometer and the time of
  // the last packet, so the tail costs nothing extra: no new endpoint, no new table, no new writes.
  //
  // Stamped with the METER's last-heard time, never the browser clock. If the collector goes deaf
  // the tail must STOP advancing rather than keep drawing a confident flat line into the present.
  const TAIL_MS = 15 * 60 * 1000;

  const loadStatus = useCallback(async () => {
    const s = await api.waterStatus();
    if (s.status === 200 && s.body.ok) {
      setStatus(s.body);
      setErr('');
      const odo = s.body.meter && s.body.meter.odometer_gallons;
      const readAt = s.body.receiver && s.body.receiver.last_read_at;
      if (readAt && lastHeardRef.current !== readAt) {
        lastHeardRef.current = readAt;
        setBeat((n) => n + 1);
      }
      if (typeof odo === 'number' && Number.isFinite(odo) && readAt) {
        const t = new Date(readAt).getTime();
        if (Number.isFinite(t)) {
          setTail((prev) => {
            const lastPt = prev[prev.length - 1];
            if (lastPt && lastPt.t === t && lastPt.gallons === odo) return prev;   // nothing new
            // A rollover or a data wipe would otherwise draw one enormous negative cliff.
            const next = lastPt && odo < lastPt.gallons ? [] : prev;
            return next.concat({ t, gallons: odo }).filter((p) => p.t >= t - TAIL_MS);
          });
        }
      }
    } else setErr(s.body.error || 'Could not load status');
  }, []);

  const loadRealtime = useCallback(async () => {
    if (mode !== 'realtime') return;
    const r = await api.waterPackets({ hours: (rtMin / 60).toFixed(4), meter: rtScope, limit: rtRowLimit });
    if (r.status === 200 && r.body.ok) setRt(r.body);
  }, [mode, rtMin, rtScope, rtRowLimit]);

  const loadSeries = useCallback(async () => {
    if (mode === 'realtime') return;
    const q = mode === 'long' ? { mode: 'long', days } : { mode: 'heartbeat', hours };
    const m = await api.waterMeter(q);
    if (m.status === 200 && m.body.ok) setMeter(m.body);
  }, [mode, hours, days]);

  const loadSlow = useCallback(async () => {
    const h = await api.waterHourly(48);
    if (h.status === 200 && h.body.ok) setHourly(h.body);
    const a = await api.waterAlerts(5);
    if (a.status === 200 && a.body.ok) setAlerts(a.body.alerts);
  }, []);

  useEffect(() => {
    loadStatus();
    loadSlow();
    const id = setInterval(loadStatus, POLL_MS);
    const idSlow = setInterval(loadSlow, 60000);
    return () => { clearInterval(id); clearInterval(idSlow); };
  }, [loadStatus, loadSlow]);

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    loadSeries();
    const id = setInterval(loadSeries, SERIES_MS);
    return () => clearInterval(id);
  }, [loadSeries]);

  useEffect(() => {
    loadRealtime();
    const id = setInterval(loadRealtime, RT_MS);
    return () => clearInterval(id);
  }, [loadRealtime]);

  if (err && !status) return <div className="page"><p className="err">{err}</p></div>;
  if (!status) return <div className="loading">Loading…</div>;

  const b = BANNER[status.leak.state] || BANNER.unknown;
  const r = status.receiver;
  const t = status.totals;
  const overnightHigh = t.overnight > t.overnight_threshold;
  // Tolerate an older server that predates /api/water/status returning `run`.
  const run = status.run || { flowing: false, level: 'idle', minutes: 0, gallons: 0, rate: 0, idle_minutes: null };

  const bars = (hourly ? hourly.series : []).map((s) => ({
    key: s.hour_key,
    label: String(s.hour).padStart(2, '0'),
    value: s.gallons,
    observed: s.observed,
    highlight: s.hour >= t.overnight_window[0] && s.hour < t.overnight_window[1],
  }));

  // ── the meter card's numbers ───────────────────────────────────────────────────────────────
  const hb = meter && meter.mode === 'heartbeat' ? meter : null;
  const lv = meter && meter.mode === 'long' ? meter : null;
  const pts = hb ? hb.series.filter((p) => p.odometer !== null && p.odometer !== undefined) : [];
  const tailLast = tail.length ? tail[tail.length - 1].gallons : null;
  const windowEnd = tailLast !== null && pts.length ? Math.max(tailLast, pts[pts.length - 1].odometer)
    : pts.length ? pts[pts.length - 1].odometer : null;
  const usedInWindow = pts.length && windowEnd !== null ? Math.max(0, windowEnd - pts[0].odometer) : 0;
  // Seconds since the meter was last heard, recomputed on the 1s tick rather than the 5s poll so
  // the number moves every second even between fetches.
  const lastHeardMs = r.last_read_at ? new Date(r.last_read_at).getTime() : null;
  const secsSince = lastHeardMs === null || Number.isNaN(lastHeardMs)
    ? null : Math.max(0, Math.round((tick - lastHeardMs) / 1000));

  const recentPulse = pts.slice(-10);
  const pulseAvg = recentPulse.length
    ? recentPulse.reduce((a, p) => a + (p.packets || 0), 0) / recentPulse.length : 0;
  const snrPts = pts.filter((p) => p.snr !== null && p.snr !== undefined).slice(-10);
  const snrAvg = snrPts.length ? snrPts.reduce((a, p) => a + p.snr, 0) / snrPts.length : null;
  const liveOdo = (meter && meter.live && meter.live.odometer) !== null && meter && meter.live
    ? meter.live.odometer
    : status.meter.odometer_gallons;

  // Export rows follow the chart on screen, so a CSV can always be reconciled with the picture.
  const hbHeaders = ['minute_mtn', 'odometer_gallons', 'packets', 'rssi_db', 'snr_db'];
  const hbRows = hb ? hb.series.map((p) => [p.minute_mtn, p.odometer, p.packets, p.rssi, p.snr]) : [];
  const lvHeaders = ['day_key', 'gallons', 'observed'];
  const lvRows = lv ? lv.series.map((d) => [d.day_key, d.gallons.toFixed(1), d.observed ? 'yes' : 'no']) : [];

  // ── the Real time tab ──────────────────────────────────────────────────────────────────────
  const rtCols = rt && rt.columns ? rt.columns : [];
  const rtPackets = rt ? rt.packets : [];
  const rtMine = rtPackets.filter((p) => p.is_ours);
  // The key is (meter_id, heard_at_utc) — the table's PRIMARY KEY, and stable for the life of the
  // row. It briefly included the array index, which was wrong in a way that only shows up live:
  // rows are newest-first, so ONE arrival at the top shifted every index below it and therefore
  // changed every key. React then remounted the whole table on every poll, and the grid's
  // new-row detection saw all 200 rows as fresh — so either everything flashed or nothing did,
  // and "which row is new" became unanswerable.
  const rtGrid = rtPackets.slice().reverse().map((p) => ({
    ...p,
    _key: p.meter_id + '|' + p.heard_at_utc,
    _highlight: p.is_ours,
    _dim: !p.is_ours,
  }));
  const rtHeaders = rtCols.map((c) => c.key);
  const rtRows = rtGrid.map((r) => rtCols.map((c) => r[c.key]));
  const rtSecs = Math.max(1, rtMin * 60);
  const rtExpected = rt && rt.interval_seconds ? Math.round(rtSecs / rt.interval_seconds) : 0;
  // From the server's COUNT over the whole window, never from the fetched array. Dividing a
  // truncated 24-hour fetch by a full 24-hour expectation reported 29% and looked like a failing
  // antenna; the only thing failing was a LIMIT clause.
  const rtDecodePct = rt && rt.decode ? Math.min(100, rt.decode.pct) : null;
  const rtCounts = rt && rt.counts ? rt.counts : null;
  const rtCoverage = rt && rt.coverage ? rt.coverage : null;
  const rtLastSnr = (() => {
    const withSnr = rtMine.filter((p) => p.snr !== null && p.snr !== undefined).slice(-20);
    return withSnr.length ? withSnr.reduce((a, p) => a + p.snr, 0) / withSnr.length : null;
  })();
  const rtSnrBand = band_of(rt && rt.quality, 'snr', rtLastSnr);

  const exportHeaders = mode === 'long' ? lvHeaders : mode === 'realtime' ? rtHeaders : hbHeaders;
  const exportRows = mode === 'long' ? lvRows : mode === 'realtime' ? rtRows : hbRows;

  const commit = (text, setVal, setText, max) => {
    const n = Math.max(1, Math.min(Math.round(Number(text)) || 1, max));
    setVal(n); setText(String(n));
  };

  return (
    <div className="page w-root">
      <div className="w-page-head">
        <div>
          <h2>Water monitor</h2>
          <p className="muted">{status.meter_name ? status.meter_name + ' · ' : ''}ID {status.meter_id} · {status.tz}</p>
          {/* What is actually on the air, read from the collector's own resolved rtl_433 arguments.
              "No readings" has two very different causes and one of them is being tuned to the
              wrong frequency or running a build without the Orion decoder — so the transmitter and
              the decoder belong on the page, not only in .env. */}
          {status.radio ? (
            <p className="muted small w-radio-line">
              <span className="w-radio-model">{status.radio.model}</span>
              {status.radio.decoder ? <> · {status.radio.decoder}</> : null}
              {status.radio.frequency_mhz ? <> · {status.radio.frequency_mhz} MHz</> : null}
              {status.radio.sample_rate_khz ? <> · {status.radio.sample_rate_khz} ksps</> : null}
              {r.mode ? <> · {r.mode} mode</> : null}
            </p>
          ) : null}
        </div>
        <div className="w-expand-all">
          <button type="button" onClick={() => forceAll(true)}>Expand all</button>
          <button type="button" onClick={() => forceAll(false)}>Collapse all</button>
        </div>
      </div>

      {/* Verdict and receiver health in ONE row.
          They were two stacked cards, which pushed the meter chart below the fold on a laptop — and
          the chart is what you open this page to see. They also belong together: "all clear" is
          only meaningful if the receiver is actually hearing the meter. Neither this banner nor the
          tiles below collapse: they are the answer, not the evidence. */}
      <div className={'w-banner ' + b.cls} role="status">
        <span className="w-banner-icon" aria-hidden="true">{b.icon}</span>
        <span className="w-banner-text">
          <p className="w-banner-head">{status.leak.headline}</p>
          <p className="w-banner-sub">{status.leak.detail}</p>
        </span>
        <span className="w-banner-meta">
          <span className="w-strip-item">
            <span className={'w-dot ' + (r.collector_up ? 'up' : 'down')} aria-hidden="true" />
            <span className="w-strip-value">{r.collector_up ? 'Collector up' : 'Collector DOWN'}</span>
          </span>
          <span className="w-strip-item">
            <span className="w-strip-label">Reading</span>
            <span className="w-strip-value">
              {status.meter.odometer_gallons === null ? '—' : Number(status.meter.odometer_gallons).toLocaleString()}
            </span>
          </span>
          {r.mode === 'replay' ? (
            <span className="w-strip-item"><span className="w-strip-value">REPLAY — not the real meter</span></span>
          ) : null}
          {/* Last packet, in full and right-justified. The relative age ("3 min ago") is the faster
              read, but only the absolute stamp survives a screenshot or a phone call — and it is
              the one you compare against a pm2 log line when something looks wrong. Rendered in the
              METER's timezone, not the browser's, so a laptop on the road still shows house time. */}
          <span className="w-banner-stamp">
            <span className="w-strip-label">Last packet</span>
            <span className="w-strip-value">{fullStamp(r.last_read_at, status.tz)}</span>
            <span className="w-strip-label">{r.quiet_minutes === null ? '' : '(' + ago(r.quiet_minutes) + ')'}</span>
          </span>
        </span>
      </div>

      <div className="w-tiles">
        <Tile label="Today" value={t.today} help={METRIC_HELP.today} note={'since midnight ' + status.tz.split('/')[1].replace('_', ' ')} />
        <Tile
          label={`Overnight (${t.overnight_window[0]}–${t.overnight_window[1]})`}
          value={t.overnight}
          help={METRIC_HELP.overnight}
          note={overnightHigh ? `over the ${t.overnight_threshold} gal threshold` : `threshold ${t.overnight_threshold} gal`}
          alarm={overnightHigh}
        />
        <Tile label="Last 24 hours" value={t.last_24h} help={METRIC_HELP.last24} />
        <Tile label="Daily average" value={t.avg_day_7d} help={METRIC_HELP.avg} note="previous 7 full days" />
      </div>

      {/* ── the meter ─────────────────────────────────────────────────────────────────────────
          The only card that starts open. Two modes behind one toggle:
            Heartbeat  per-minute reading + the packet pulse, up to 72 hours (water_reception)
            Long view  daily totals, any range (water_hourly)
          The pulse is the part that is easy to underrate: a flat reading with a healthy pulse means
          nobody used water; a flat reading with a flatline means you are not being read at all, and
          those two look identical on a single-line chart. */}
      <CollapsibleCard
        title="Meter — live"
        defaultOpen
        forceOpen={force.open}
        forceKey={force.key}
        actions={
          <>
            <span className="w-seg">
              <button type="button" className={mode === 'realtime' ? 'on' : ''} onClick={() => setMode('realtime')}>Real time</button>
              <button type="button" className={mode === 'heartbeat' ? 'on' : ''} onClick={() => setMode('heartbeat')}>Heartbeat</button>
              <button type="button" className={mode === 'long' ? 'on' : ''} onClick={() => setMode('long')}>Long view</button>
            </span>
            <CardTools
              id={'water-' + mode}
              title={MODE_TITLE[mode]}
              svgRef={mode === 'long' ? longRef : mode === 'realtime' ? rtRef : hbRef}
              image={!flipMeter}
              headers={exportHeaders}
              rows={exportRows}
              flip={flipMeter}
              onFlip={setFlipMeter}
            />
          </>
        }
      >
        <div className="w-rangebar">
          <span className="w-range-label">{status.tz.split('/')[1].replace('_', ' ')} time</span>
          {mode === 'realtime' ? (
            <>
              {RT_CHIPS.filter((c) => !rt || c.m <= rt.max_hours * 60).map((c) => (
                <button key={c.m} type="button"
                        className={'w-chip' + (rtMin === c.m ? ' on' : '')}
                        onClick={() => setRtMin(c.m)}>{c.label}</button>
              ))}
              <span className="w-range-label" style={{ marginLeft: 6 }}>rows</span>
              {RT_ROW_CHIPS.map((n) => (
                <button key={'r' + n} type="button"
                        className={'w-chip' + (rtRowLimit === n ? ' on' : '')}
                        title={n >= 10000
                          ? 'Everything in the window, up to 10,000. Sorting and scrolling get slower — the browser is the limit here, not the database.'
                          : 'Load and paint up to ' + n.toLocaleString() + ' of the newest transmissions in this window'}
                        onClick={() => setRtRowLimit(n)}>
                  {n >= 10000 ? 'max' : n.toLocaleString()}
                </button>
              ))}
              {/* A display filter. What gets CAPTURED is packets_capture_all_meters in Settings —
                  flipping this never changes what is stored. */}
              <span className="w-filt">
                <button type="button" className={rtScope === 'mine' ? 'on' : ''} onClick={() => setRtScope('mine')}>This meter</button>
                <button type="button" className={rtScope === 'all' ? 'on' : ''} onClick={() => setRtScope('all')}>All meters</button>
              </span>
              {/* Two different facts, so two tooltips. "Keeping" is a disk retention setting;
                  "in this window" is how many rows this view loaded. They sat next to each other
                  with no way to tell which was which, and neither said where to go to change it. */}
              {rt ? (
                <span className="w-mem">
                  <span title={'How long every transmission is kept on disk before the hourly prune deletes it. Setting: packets_retention_days — Settings → Data → "Keep transmissions for (days)". About 2 MB per day for your meter alone.'}>
                    keeping <b>{rt.retention_days} day{rt.retention_days === 1 ? '' : 's'}</b>
                    <i className="w-q">?</i>
                  </span>
                  {' · '}
                  <span title="Transmissions loaded into this view. Governed by the range chips (how far back) and the rows chips (how many) — nothing to do with how long they are kept.">
                    {rtPackets.length.toLocaleString()} in this window<i className="w-q">?</i>
                  </span>
                  {' · '}
                  <Link to="/water/settings#packets_retention_days" title="Jump to this setting">change</Link>
                </span>
              ) : null}
            </>
          ) : null}
          {mode !== 'realtime' ? (mode === 'long' ? DAY_CHIPS : HOUR_CHIPS).map((n) => (
            <button
              key={n}
              type="button"
              className={'w-chip' + ((mode === 'long' ? days : hours) === n ? ' on' : '')}
              onClick={() => (mode === 'long'
                ? (setDays(n), setDaysText(String(n)))
                : (setHours(n), setHoursText(String(n))))}
            >
              {n}{mode === 'long' ? 'd' : 'h'}
            </button>
          )) : null}
          {mode !== 'realtime' ? <input
            className="w-numin"
            value={mode === 'long' ? daysText : hoursText}
            onChange={(e) => (mode === 'long' ? setDaysText(e.target.value) : setHoursText(e.target.value))}
            onBlur={() => (mode === 'long'
              ? commit(daysText, setDays, setDaysText, 400)
              : commit(hoursText, setHours, setHoursText, (hb && hb.max_hours) || 72))}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            aria-label={mode === 'long' ? 'days' : 'hours'}
          /> : null}
          {mode !== 'realtime' ? <span className="w-range-label">{mode === 'long' ? 'days' : 'h'}</span> : null}
          {mode === 'heartbeat' ? (
            <span className="w-range-note">max {(hb && hb.max_hours) || 72}h — per-minute rows stop being readable past that</span>
          ) : null}
          {/* The clock chip. Keyed on `beat`, so the element REMOUNTS each time a new packet lands
              and its arrival animation replays — the clock does not merely change, it visibly
              ticks. A constant idle pulse would be decoration; a pulse tied to an actual arrival
              is information, and its absence is information too. */}
          <span key={beat} className={'w-livetip ' + (run.flowing ? 'flowing' : 'idle') +
            (secsSince !== null && secsSince > 120 ? ' stalled' : '')}>
            <i aria-hidden="true" />
            {r.last_read_at ? clockOnly(r.last_read_at, status.tz) : 'no packet yet'}
          </span>
        </div>

        {/* Continuous-run meter. THE measurement: every fixture in a house stops on its own, so
            duration without a break is what separates "someone showered" from "something broke".
            Server-computed, so it survives a reload and is not capped by the chart window. */}
        <div className={'w-run w-run-' + run.level} role="status" title={METRIC_HELP.run}>
          <span className="w-run-icon" aria-hidden="true">{RUN[run.level].icon}</span>
          <span className="w-run-body">
            <span className="w-run-head">
              {run.flowing
                ? `${RUN[run.level].word} — ${run.truncated ? 'at least ' : ''}${fmtDur(run.minutes)} without stopping`
                : run.idle_minutes === null ? 'No flow recorded yet' : `Nothing running — quiet for ${fmtDur(run.idle_minutes)}`}
            </span>
            <span className="w-run-sub">
              {run.flowing
                ? `${run.gallons.toFixed(0)} gal this run · ${run.rate.toFixed(1)} gal/min · ${RUN[run.level].note(run)}`
                : 'Every fixture stops on its own. Something that never stops is what this watches for.'}
            </span>
          </span>
        </div>

        <div className="w-readout">
          <div>
            <div className="w-readout-big">
              {liveOdo === null || liveOdo === undefined ? '—' : Number(liveOdo).toLocaleString()}
              <span> gal</span>
            </div>
            <div className="w-readout-lab" title={METRIC_HELP.reading}>meter reading now <i className="w-q">?</i></div>
          </div>
          {mode === 'realtime' ? (
            <>
              <div>
                <div className={'w-readout-sm w-since ' + sinceClass(secsSince)} key={beat}>
                  {secsSince === null ? '—' : secsSince + 's'}
                </div>
                <div className="w-readout-lab" title={METRIC_HELP.since}>since last packet <i className="w-q">?</i></div>
              </div>
              <div>
                <div className="w-readout-sm">{rtMine.length.toLocaleString()}</div>
                <div className="w-readout-lab" title={METRIC_HELP.shown}>transmissions shown <i className="w-q">?</i></div>
              </div>
              <div>
                <div className="w-readout-sm">{rt && rt.interval_seconds ? rt.interval_seconds + 's' : '—'}</div>
                <div className="w-readout-lab" title={METRIC_HELP.interval}>measured interval <i className="w-q">?</i></div>
              </div>
              <div>
                <div className={'w-readout-sm ' + (rtDecodePct !== null && rtDecodePct < 90 ? 'w-since warn' : 'w-since good')}>
                  {rtDecodePct === null ? '—' : rtDecodePct.toFixed(1) + ' %'}
                </div>
                <div className="w-readout-lab" title={METRIC_HELP.decoded}>
                  {rtCoverage && rtCoverage.partial ? 'decoded since ' + String(rtCoverage.first_mtn || '').slice(11, 16) : 'decoded'} <i className="w-q">?</i>
                </div>
              </div>
              <div>
                {/* The badge, not the bare number. "20.6 dB" means nothing without a scale. */}
                <div className={'w-readout-sm w-sig ' + (rtSnrBand ? rtSnrBand.level : '')}
                     title={rtSnrBand ? rtSnrBand.label + ' — ' + rtSnrBand.note : ''}>
                  {rtLastSnr === null ? '—' : rtLastSnr.toFixed(1) + ' dB'}
                  {rtSnrBand ? <span className="w-sig-tag">{rtSnrBand.label}</span> : null}
                </div>
                <div className="w-readout-lab" title={METRIC_HELP.snr}>signal (snr) <i className="w-q">?</i></div>
              </div>
              <div>
                <div className="w-readout-sm" style={{ color: rt && rt.gaps && rt.gaps.length ? 'var(--w-critical)' : undefined }}>
                  {rt && rt.gaps ? rt.gaps.length : 0}
                </div>
                <div className="w-readout-lab" title={METRIC_HELP.gaps}>gaps <i className="w-q">?</i></div>
              </div>
            </>
          ) : mode === 'heartbeat' ? (
            <>
              {/* The proof-of-life counter. It counts up every second and snaps back to 0 each time
                  a packet lands — roughly every 4 seconds when the radio is healthy. Nothing else
                  on the page moves at that cadence, so this is the one element that answers "is
                  this thing actually live, right now" without you having to wait a minute to see
                  whether the chart moved. Colour follows the number; the number is the message. */}
              <div>
                <div key={beat} className={'w-readout-sm w-since ' + sinceClass(secsSince)}>
                  {secsSince === null ? '—' : secsSince + 's'}
                </div>
                <div className="w-readout-lab" title={METRIC_HELP.since}>since last packet <i className="w-q">?</i></div>
              </div>
              <div>
                <div className="w-readout-sm">{usedInWindow.toFixed(1)} gal</div>
                <div className="w-readout-lab" title={METRIC_HELP.used_window}>used in window <i className="w-q">?</i></div>
              </div>
              <div>
                <div className="w-readout-sm">{pulseAvg.toFixed(1)} /min</div>
                <div className="w-readout-lab" title={METRIC_HELP.pulse}>pulse <i className="w-q">?</i></div>
              </div>
              <div>
                <div className="w-readout-sm">{snrAvg === null ? '—' : snrAvg.toFixed(1) + ' dB'}</div>
                <div className="w-readout-lab">signal</div>
              </div>
            </>
          ) : lv ? (
            <>
              <div>
                <div className="w-readout-sm">{lv.summary.total.toFixed(0)} gal</div>
                <div className="w-readout-lab">total over {lv.days} days</div>
              </div>
              <div>
                <div className="w-readout-sm">{lv.summary.avg_day.toFixed(1)} gal</div>
                <div className="w-readout-lab">average day</div>
              </div>
            </>
          ) : null}
        </div>

        {mode === 'realtime' ? (
          flipMeter ? (
            <>
              <DataGrid
                columns={rtCols}
                rows={rtGrid}
                initialSort={null}
                live
                rowNumbers
                paginate
                initialPageSize={100}
                // Frozen through the meter column: position, when, and whose. Those three are what
                // every other column is read AGAINST, so they are the ones that must not scroll
                // away when you go looking at signal.
                freezeCols={2}
                freezeWidths={[132, 138]}
                renderLimit={rtRowLimit}
                windowTotal={rtCounts ? rtCounts.window_total : undefined}
                windowNote={rtCounts && rtCounts.truncated
                  ? 'Showing the most recent ' + rtCounts.returned.toLocaleString() + ' of ' +
                    rtCounts.window_total.toLocaleString() + ' transmissions in this window — the ' +
                    'newest end, which is the live one. Raise ' + String.fromCharCode(8220) + 'rows' +
                    String.fromCharCode(8221) + ' above for more, narrow the range for full coverage, ' +
                    'or use ⬇ CSV for every row. The decoded % is measured against the whole window, ' +
                    'not this slice.'
                  : undefined}
                liveLabel="new transmissions"
                filterPlaceholder="Filter — try a meter id, CRC, or a volume"
                renderCell={renderPacketCell(rt && rt.quality, status.meter_id)}
                emptyMessage={rt && !rt.enabled
                  ? 'Recording is off. Turn on "Record every transmission" in Settings.'
                  : 'Waiting for the first transmission…'}
                maxHeight={420}
              />
              <p className="w-chart-sub small" style={{ marginTop: 8 }}>
                Newest first. <b>Hover any column heading</b> for what it means and what a good value
                looks like. A blank <code>delta</code> is the normal case — the meter re-broadcasts
                the same total every few seconds and only steps when a whole gallon has passed.
              </p>
            </>
          ) : (
            <>
              <div ref={rtRef}>
                <RealtimeChart
                  packets={rtMine}
                  gaps={rt ? rt.gaps : []}
                  secondsSince={secsSince}
                  tz={status.tz}
                  height={280}
                  emptyMessage={rt && !rt.enabled
                    ? 'Recording is off. Turn on "Record every transmission" in Settings.'
                    : 'Waiting for the first transmission…'}
                />
              </div>
              <div className="w-legend-note">
                <span><span className="w-swatch series" /><b>Reading</b> — steps at the exact second the meter ticked</span>
                <span><span className="w-swatch serious" /><b>SNR</b> — per packet; below the dashed line is where packets drop</span>
                <span><span className="w-swatch good" /><b>Packets</b> — one tick each</span>
                <span><span className="w-swatch critical" /><b>Gap</b> — nothing decoded</span>
              </div>
              {rt && rt.gaps && rt.gaps.length ? (
                <>
                  <p className="w-chart-sub" style={{ marginTop: 10, fontWeight: 700 }}>Gaps in this window</p>
                  <table className="w-table">
                    <thead><tr><th>started</th><th>length</th><th>missed</th><th>snr before</th><th>snr after</th><th>reading</th></tr></thead>
                    <tbody>
                      {rt.gaps.slice(-8).reverse().map((g, i) => (
                        <tr key={i}>
                          <td>{String(g.start_mtn || '').slice(11, 23) || '—'}</td>
                          <td style={{ color: 'var(--w-critical)', fontWeight: 700 }}>{g.seconds}s</td>
                          <td>{g.missed}</td>
                          <td>{g.snr_before === null ? '—' : g.snr_before + ' dB'}</td>
                          <td>{g.snr_after === null ? '—' : g.snr_after + ' dB'}</td>
                          {/* The diagnosis, not just the observation. */}
                          <td className="muted small">
                            {g.snr_before !== null && g.snr_after !== null && g.snr_before - g.snr_after > 5
                              ? 'signal collapsed — an RF path problem'
                              : 'signal held — interference or a receiver stall'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : null}
              {rt && rt.meters && rt.meters.length > 1 ? (
                <>
                  <p className="w-chart-sub" style={{ marginTop: 10, fontWeight: 700 }}>Meters heard</p>
                  <table className="w-table">
                    <thead><tr><th>id</th><th></th><th>packets</th><th>decoded</th><th>rssi avg</th><th>snr avg</th><th>last seen</th></tr></thead>
                    <tbody>
                      {rt.meters.map((m) => {
                        const pct = rtExpected ? Math.min(100, (m.packets / rtExpected) * 100) : null;
                        const bd = band_of(rt.quality, 'snr', m.snr_avg);
                        return (
                          <tr key={m.meter_id} className={m.is_ours ? 'is-mine' : 'is-other'}>
                            <td>{m.meter_id}</td>
                            <td><span className={'w-pill ' + (m.is_ours ? 'sent' : 'failed')}>{m.is_ours ? 'mine' : 'other'}</span></td>
                            <td>{m.packets.toLocaleString()}</td>
                            <td>{pct === null ? '—' : pct.toFixed(1) + ' %'}</td>
                            <td>{m.rssi_avg === null ? '—' : m.rssi_avg}</td>
                            <td>{m.snr_avg === null ? '—' : <span className={'w-sig ' + (bd ? bd.level : '')}>{m.snr_avg} dB</span>}</td>
                            <td className="muted small">{String(m.last_seen || '').slice(11, 19)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="muted small" style={{ marginTop: 6 }}>
                    Neighbouring meters are captured for antenna comparison only — they never advance
                    your odometer, enter a rule, or raise an alert. If a move raises your SNR and not
                    theirs, you improved <em>your</em> path; if it raises both, you improved the receiver.
                  </p>
                </>
              ) : null}
            </>
          )
        ) : flipMeter ? (
          <DataTable
            headers={mode === 'long' ? lvHeaders : hbHeaders}
            rows={mode === 'long' ? lvRows : hbRows}
            note={mode === 'long'
              ? 'Daily totals, oldest first — the same rows the bars are drawn from.'
              : 'Newest last, one row per minute. `packets` is what the pulse draws; a 0 is a flatline.'}
          />
        ) : mode === 'heartbeat' ? (
          <>
            <div ref={hbRef}>
              <HeartbeatChart
                series={hb ? hb.series : []}
                tail={tail}
                runs={hb ? hb.runs : []}
                overnight={hb ? hb.overnight : null}
                tz={status.tz}
                height={250}
                emptyMessage={
                  r.collector_up
                    ? 'Listening… the first minute of the heartbeat appears within about a minute.'
                    : 'The collector is not running, so there is nothing live to show.'
                }
              />
            </div>
            <div className="w-legend-note">
              <span><span className="w-swatch series" /><b>Reading</b> — rises only when water moves</span>
              <span><span className="w-swatch good" /><b>Pulse</b> — packets heard; never flat while the radio works</span>
              <span><span className="w-swatch critical" /><b>Flatline</b> — a minute with nothing heard</span>
              <span><span className="w-swatch band" />Overnight window</span>
            </div>
          </>
        ) : (
          <>
            <div ref={longRef}>
              <BarChart
                data={(lv ? lv.series : []).map((d) => ({
                  key: d.day_key,
                  label: d.day_key.slice(5),
                  value: d.gallons,
                  observed: d.observed,
                  highlight: lv ? d.gallons > lv.summary.high_threshold : false,
                }))}
                height={220}
                formatTip={(d) => (d.observed
                  ? `${d.key} — ${d.value.toFixed(0)} gal`
                  : `${d.key} — no data (the collector was not running)`)}
                emptyMessage="No daily rollups yet."
              />
            </div>
            <div className="w-legend-note">
              <span><span className="w-swatch series" />Gallons used</span>
              <span><span className="w-swatch nodata" />No data (not the same as zero)</span>
              <span><span className="w-swatch band" />Above 1.5× the average day in this window</span>
            </div>
          </>
        )}

        <SqlPanel blocks={meter ? meter.sql : null} />
      </CollapsibleCard>

      <CollapsibleCard
        title="Gallons per hour, last 48 hours"
        defaultOpen={false}
        forceOpen={force.open}
        forceKey={force.key}
        sub="The overnight window is shaded. A running toilet shows up as a flat, unbroken row of bars across the shaded band — which is exactly what normal use never looks like."
        actions={
          <>
            <Link className="muted small" to="/water/history">Longer view →</Link>
            <CardTools
              id="water-hourly-48"
              title="Water — gallons per hour, last 48 hours"
              svgRef={hourlyRef}
              headers={['hour_key', 'hour', 'gallons', 'observed']}
              rows={(hourly ? hourly.series : []).map((s) => [s.hour_key, s.hour, s.gallons, s.observed ? 'yes' : 'no'])}
              flip={flipHourly}
              onFlip={setFlipHourly}
            />
          </>
        }
      >
        {flipHourly ? (
          <DataTable
            headers={['hour_key', 'hour', 'gallons', 'observed']}
            rows={(hourly ? hourly.series : []).map((s) => [s.hour_key, s.hour, s.gallons.toFixed(1), s.observed ? 'yes' : 'no'])}
            note="Newest last. `observed` = no means the receiver was not listening — not that usage was zero."
          />
        ) : (
        <div ref={hourlyRef}>
          <BarChart
            data={bars}
            height={190}
            formatTip={(d) => (d.observed
              ? `${d.label}:00 — ${d.value.toFixed(0)} gal`
              : `${d.label}:00 — no data (receiver was not listening)`)}
            emptyMessage="No readings yet. Start the collector: npm run water_collector"
          />
        </div>
        )}
        <div className="w-legend-note">
          <span><span className="w-swatch series" />Gallons used</span>
          <span><span className="w-swatch nodata" />No data (not the same as zero)</span>
          <span><span className="w-swatch band" />Overnight window</span>
        </div>
        <SqlPanel blocks={[{
          label: 'Hourly rollup', table: 'water_hourly', text:
            'SELECT hour_key, gallons, reading_count\n' +
            'FROM   water_hourly\n' +
            'WHERE  meter_id = ' + status.meter_id + '\n' +
            'ORDER BY hour_key DESC\n' +
            'LIMIT  48;   -- hour_key is a LOCAL (' + status.tz + ') key, not UTC',
        }]} />
      </CollapsibleCard>

      {/* Recent alerts, with delivery status. An alert that was raised but never delivered is the
          failure this panel exists to make impossible to miss. */}
      <CollapsibleCard
        title="Recent alerts"
        defaultOpen={false}
        forceOpen={force.open}
        forceKey={force.key}
        actions={
          <>
            <Link className="muted small" to="/water/alerts">All alerts →</Link>
            <CardTools
              id="water-alerts"
              title="Water — recent alerts"
              image={false}
              headers={['fired_at_local', 'kind', 'severity', 'delivered', 'message']}
              rows={(alerts || []).map((a) => [a.fired_at_local, a.kind, a.severity, a.delivered ? 'yes' : 'no', a.message])}
            />
          </>
        }
      >
        {!alerts ? <p className="muted">Loading…</p> : !alerts.length ? (
          <p className="muted">
            Nothing yet — the quiet outcome. Send a test from <b>Settings</b> so you know the
            channel works before it matters.
          </p>
        ) : (
          <table className="w-table stack">
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td style={{ whiteSpace: 'nowrap', width: 160 }}>{a.fired_at_local}</td>
                  <td style={{ width: 110 }}>
                    <span className={'w-pill ' + (a.delivered ? 'sent' : 'failed')}>
                      {a.delivered ? '✓ sent' : '✕ not sent'}
                    </span>
                  </td>
                  <td>{a.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <SqlPanel blocks={[{
          label: 'Alert history (also the cooldown ledger)', table: 'water_alerts', text:
            'SELECT fired_at_mtn, kind, severity, delivered, message\n' +
            'FROM   water_alerts\n' +
            'ORDER BY fired_at_utc DESC\n' +
            'LIMIT  50;',
        }]} />
      </CollapsibleCard>
    </div>
  );
}

// The rows behind a chart. Scrollable and newest-last, so the bottom of the box is "now" — the same
// direction the chart reads, which is what makes the two comparable at a glance.
/**
 * How a packet cell is drawn.
 *
 * Two jobs beyond formatting. First, the signal columns get a BADGE, not a bare number: "-9.4" and
 * "20.6" are meaningless without a scale, and the scale lives on the server so the badge here and
 * any future reception alert can never disagree. Second, a NULL is drawn as an em dash and never as
 * a zero — with -M level off, every signal column is null, and rendering that as 0 dB would send
 * someone up a ladder to fix an antenna that is fine.
 */
function renderPacketCell(quality, myMeter) {
  return function cell(col, value, row) {
    if (value === null || value === undefined || value === '') {
      return <span className="muted">—</span>;
    }
    switch (col.type) {
      case 'time':
        // Already local (MTN) from the server — MySQL's heard_at_mtn column, not a browser clock.
        return <span className="w-mono">{String(value).slice(11, 23)}</span>;
      case 'id':
        return (
          <span className={Number(value) === Number(myMeter) ? 'w-id-mine' : 'w-id-other'}>
            {value}{Number(value) === Number(myMeter) ? <span className="w-pill sent">mine</span> : null}
          </span>
        );
      case 'num':
        return Number(value).toLocaleString();
      case 'delta': {
        // THREE states, drawn differently, because two of them were being collapsed into one.
        //   null  no previous packet from this meter yet — genuinely unknown
        //   0     the odometer did not move: the normal case, and NOT missing data
        //   +n    a whole gallon (or more) passed since the last transmission
        // Rendering 0 as an em dash made an entire column of correct zeroes look like a broken
        // feature. A faint 0 says "measured, and it was zero", which is a different claim.
        const n = Number(value);
        if (!Number.isFinite(n)) return <span className="muted">—</span>;
        if (n === 0) return <span className="w-delta-zero">0</span>;
        return <span style={{ color: 'var(--w-series)', fontWeight: 700 }}>{n > 0 ? '+' : ''}{n}</span>;
      }
      case 'freq':
        return Number(value).toFixed(4);
      case 'rssi':
      case 'snr': {
        const b = band_of(quality, col.type, value);
        return (
          <span className={'w-sig ' + (b ? b.level : '')} title={b ? b.label + ' — ' + b.note : ''}>
            {value}{b ? <span className="w-sig-tag">{b.label}</span> : null}
          </span>
        );
      }
      default:
        return String(value);
    }
  };
}

function DataTable({ headers, rows, note }) {
  const body = (rows || []).slice(-500);
  return (
    <div className="w-datatable">
      {note ? <p className="w-chart-sub small">{note}</p> : null}
      <div className="w-datatable-scroll">
        <table className="w-table">
          <thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {body.map((r, i) => (
              <tr key={i}>{r.map((c, j) => (
                <td key={j}>{c === null || c === undefined || c === '' ? <span className="muted">—</span> : String(c)}</td>
              ))}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Showing the last {body.length.toLocaleString()} of {(rows || []).length.toLocaleString()} rows.
        Use <b>⬇ CSV</b> for all of them.
      </p>
    </div>
  );
}

function Tile({ label, value, note, alarm, help }) {
  return (
    <div className="w-tile">
      <div className="w-tile-label" title={help || undefined}>{label}{help ? <i className="w-q">?</i> : null}</div>
      <div className="w-tile-value">
        {Number(value).toFixed(value < 10 ? 1 : 0)}<span className="w-tile-unit">gal</span>
      </div>
      {note ? <div className={'w-tile-note' + (alarm ? ' alarm' : '')}>{note}</div> : null}
    </div>
  );
}

// The last packet, spelled out. Formatted in the METER's timezone rather than the browser's: this
// dashboard gets opened from a laptop in another state, and "1:44 AM" has to mean 1:44 AM at the
// house or it is worse than useless for comparing against a log line.
function fullStamp(iso, tz) {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  const opts = { timeZone: tz || undefined };
  try {
    const date = new Intl.DateTimeFormat('en-US', { ...opts, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(d);
    const time = new Intl.DateTimeFormat('en-US', { ...opts, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).format(d);
    return date + ' · ' + time;
  } catch (e) {
    return d.toISOString();          // an unknown tz must not blank the whole header
  }
}

// The pulsing chip next to the range chips: just the clock, because it sits inches from the full
// stamp in the banner and repeating the date there would be noise.
function clockOnly(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(d);
  } catch (e) { return '—'; }
}

// The meter transmits about every 4 seconds. Under ~20s is normal jitter; a minute of silence is
// worth noticing; past two minutes something is wrong and the watchdog will eventually agree.
function sinceClass(secs) {
  if (secs === null) return 'unknown';
  if (secs <= 20) return 'good';
  if (secs <= 120) return 'warn';
  return 'bad';
}

function ago(min) {
  if (min < 1) return 'just now';
  if (min < 60) return min + ' min ago';
  const h = Math.floor(min / 60);
  if (h < 24) return h + 'h ' + (min % 60) + 'm ago';
  return Math.floor(h / 24) + 'd ago';
}
