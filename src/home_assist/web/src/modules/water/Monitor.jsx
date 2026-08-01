import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import BarChart from './BarChart.jsx';
import HeartbeatChart from './HeartbeatChart.jsx';
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

  // Meter-card controls
  const [mode, setMode] = useState('heartbeat');
  const [hours, setHours] = useState(72);
  const [days, setDays] = useState(30);
  const [hoursText, setHoursText] = useState('72');
  const [daysText, setDaysText] = useState('30');

  // Expand all / Collapse all. `forceKey` is what makes a repeated command work — see
  // CollapsibleCard for why a bare boolean is not enough.
  // ⇄ Table: the numbers behind the picture, on screen, without downloading anything. A chart you
  // cannot read the values off is a chart you have to take on faith.
  const [flipMeter, setFlipMeter] = useState(false);
  const [flipHourly, setFlipHourly] = useState(false);

  const [force, setForce] = useState({ open: undefined, key: 0 });
  const forceAll = (open) => setForce((f) => ({ open, key: f.key + 1 }));

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

  const loadSeries = useCallback(async () => {
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
        <Tile label="Today" value={t.today} note={'since midnight ' + status.tz.split('/')[1].replace('_', ' ')} />
        <Tile
          label={`Overnight (${t.overnight_window[0]}–${t.overnight_window[1]})`}
          value={t.overnight}
          note={overnightHigh ? `over the ${t.overnight_threshold} gal threshold` : `threshold ${t.overnight_threshold} gal`}
          alarm={overnightHigh}
        />
        <Tile label="Last 24 hours" value={t.last_24h} />
        <Tile label="Daily average" value={t.avg_day_7d} note="previous 7 full days" />
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
              <button type="button" className={mode === 'heartbeat' ? 'on' : ''} onClick={() => setMode('heartbeat')}>Heartbeat</button>
              <button type="button" className={mode === 'long' ? 'on' : ''} onClick={() => setMode('long')}>Long view</button>
            </span>
            <CardTools
              id={mode === 'long' ? 'water-long' : 'water-heartbeat'}
              title={mode === 'long' ? 'Water — daily totals' : 'Water — meter heartbeat'}
              svgRef={mode === 'long' ? longRef : hbRef}
              headers={mode === 'long' ? lvHeaders : hbHeaders}
              rows={mode === 'long' ? lvRows : hbRows}
              flip={flipMeter}
              onFlip={setFlipMeter}
            />
          </>
        }
      >
        <div className="w-rangebar">
          <span className="w-range-label">{status.tz.split('/')[1].replace('_', ' ')} time</span>
          {(mode === 'long' ? DAY_CHIPS : HOUR_CHIPS).map((n) => (
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
          ))}
          <input
            className="w-numin"
            value={mode === 'long' ? daysText : hoursText}
            onChange={(e) => (mode === 'long' ? setDaysText(e.target.value) : setHoursText(e.target.value))}
            onBlur={() => (mode === 'long'
              ? commit(daysText, setDays, setDaysText, 400)
              : commit(hoursText, setHours, setHoursText, (hb && hb.max_hours) || 72))}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            aria-label={mode === 'long' ? 'days' : 'hours'}
          />
          <span className="w-range-label">{mode === 'long' ? 'days' : 'h'}</span>
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
        <div className={'w-run w-run-' + run.level} role="status">
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
            <div className="w-readout-lab">meter reading now</div>
          </div>
          {mode === 'heartbeat' ? (
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
                <div className="w-readout-lab">since last packet</div>
              </div>
              <div>
                <div className="w-readout-sm">{usedInWindow.toFixed(1)} gal</div>
                <div className="w-readout-lab">used in window</div>
              </div>
              <div>
                <div className="w-readout-sm">{pulseAvg.toFixed(1)} /min</div>
                <div className="w-readout-lab">pulse</div>
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

        {flipMeter ? (
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

function Tile({ label, value, note, alarm }) {
  return (
    <div className="w-tile">
      <div className="w-tile-label">{label}</div>
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
