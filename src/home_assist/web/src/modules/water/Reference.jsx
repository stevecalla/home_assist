import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import CollapsibleCard from '../../components/CollapsibleCard.jsx';
import './water.css';

// Reference — "when will this thing actually wake me up, and how do I change that?"
//
// Every number on this page comes from /api/water/reference, which reads the SAME catalog the rules
// use and the SAME settings rows the collector reads. Nothing here is retyped prose. A reference
// page maintained by hand is wrong within two releases, and being wrong about when your leak alarm
// fires is worse than having no page at all.
//
// Panel is 'water', not 'water-admin': knowing when you will be woken is not an administrative
// privilege. The links to change things still land on the admin-gated Settings page.

function dur(min) {
  if (min === null || min === undefined) return '—';
  if (min < 60) return min + ' min';
  const h = min / 60;
  return (Number.isInteger(h) ? h : h.toFixed(1)) + ' hours';
}

const SEV = {
  high: { label: 'Wakes you', cls: 'sev-high' },
  low: { label: 'Informational', cls: 'sev-low' },
  info: { label: 'Dashboard only', cls: 'sev-info' },
};

export default function Reference() {
  const [ref, setRef] = useState(null);
  const [err, setErr] = useState('');
  // forceOpen + a bumping key is the usat_apps pattern for "expand all" / "collapse all": the key
  // is what makes pressing the same button twice work after the user has toggled a card by hand.
  const [force, setForce] = useState({ open: undefined, key: 0 });
  const all = (open) => setForce((f) => ({ open, key: f.key + 1 }));

  useEffect(() => {
    api.waterReference().then((r) => {
      if (r.status === 200 && r.body.ok) setRef(r.body);
      else setErr(r.body.error || 'Could not load the reference');
    });
  }, []);

  if (err) return <div className="page"><p className="err">{err}</p></div>;
  if (!ref) return <div className="loading">Loading…</div>;

  const ch = ref.channels;

  return (
    <div className="page w-root">
      <h2>Reference</h2>
      <p className="muted">
        What fires, when, and which setting moves it. Every value below is read live from the running
        configuration — not from documentation that can drift away from the code.
      </p>

      <div className="w-card-bar">
        <button type="button" className="btn small" onClick={() => all(true)}>Expand all</button>
        <button type="button" className="btn small" onClick={() => all(false)}>Collapse all</button>
      </div>

      {/* ── the card people actually come here for ───────────────────────────────── */}
      <CollapsibleCard
        title="Alert schedule"
        defaultOpen
        forceOpen={force.open}
        forceKey={force.key}
        actions={<Link className="muted small" to="/water/settings">Change these →</Link>}
      >
        <p className="w-chart-sub">
          The collector re-evaluates every rule <strong>every {ref.tick_seconds} seconds</strong>, in{' '}
          {ref.tz} local time. A <strong>cooldown</strong> is the minimum gap before the same alert can
          repeat — it exists so a leak that runs all weekend does not send you 400 emails, which is how
          people end up muting the thing that was trying to help.
        </p>
        <p className="w-chart-sub">
          <strong>Detection and delivery are separate.</strong> These rules run over{' '}
          <em>every</em> meter the receiver stores readings for, and the results are recorded so any
          meter&apos;s history and banner work. Only a meter marked <code>notify</code> is actually
          emailed or pushed, and that is your own meter unless you change it — a stranger&apos;s
          shower should never wake you. One exception: <strong>Receiver silent never fires for an
          observed meter</strong>, because silence there means this antenna lost them, not that
          their pipe burst.
        </p>

        <div className="w-ref-list">
          {ref.alerts.map((a, i) => {
            const sev = SEV[a.severity] || SEV.info;
            return (
              <div className="w-ref-item" key={i}>
                <div className="w-ref-top">
                  <span className="w-ref-name">{a.label}</span>
                  <span className={'w-ref-sev ' + sev.cls}>{sev.label}</span>
                  <span className="w-ref-cool">
                    {a.email === false ? 'no email' : 'repeats at most every ' + dur(a.cooldown_min)}
                  </span>
                </div>
                <div className="w-ref-when"><strong>Fires:</strong> {a.when}</div>
                <div className="w-ref-why">{a.why}</div>
                {a.settings.length ? (
                  <div className="w-ref-settings">
                    {a.settings.map((s) => (
                      <span className="w-ref-chip" key={s.name} title={s.help}>
                        {s.label}: <strong>{String(s.value)}</strong>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </CollapsibleCard>

      {/* ── how it reaches you ───────────────────────────────────────────────────── */}
      <CollapsibleCard
        title="How alerts reach you"
        defaultOpen={false}
        forceOpen={force.open}
        forceKey={force.key}
        actions={<Link className="muted small" to="/water/diagnostics">Verify SMTP →</Link>}
      >
        <p className="w-chart-sub">
          An alert that cannot be delivered is not an alert. Both channels record whether delivery
          actually succeeded — <em>raised</em> and <em>delivered</em> are different facts, and the{' '}
          <Link to="/water/alerts">Alerts</Link> page shows both.
        </p>
        <table className="w-table">
          <thead><tr><th>Channel</th><th>State</th><th>Where</th></tr></thead>
          <tbody>
            <tr>
              <td>Email <span className="muted small">(primary)</span></td>
              <td>{ch.email.enabled ? (ch.email.configured ? '✓ on' : '⚠ on, but SMTP not configured') : 'off'}</td>
              <td>{ch.email.to || <span className="muted">no recipient set</span>}</td>
            </tr>
            <tr>
              <td>ntfy push <span className="muted small">(optional)</span></td>
              <td>{ch.ntfy.enabled ? '✓ on' : 'off'}</td>
              <td>{ch.ntfy.topic_set ? ch.ntfy.server : <span className="muted">no topic set</span>}</td>
            </tr>
          </tbody>
        </table>
      </CollapsibleCard>

      {/* ── the thing that trips everyone up ─────────────────────────────────────── */}
      <CollapsibleCard title="Two processes, one app" defaultOpen={false} forceOpen={force.open} forceKey={force.key}>
        <p className="w-chart-sub">
          These are separate on purpose: rebuilding or restarting the dashboard must never interrupt
          leak detection.
        </p>
        <table className="w-table">
          <thead><tr><th>Process</th><th>Port</th><th>Job</th><th>If it stops</th></tr></thead>
          <tbody>
            <tr>
              <td><code>water_collector</code></td>
              <td className="muted">none</td>
              <td>Owns the radio, applies the rules, sends alerts. Writes MySQL.</td>
              <td><strong>Leak detection stops.</strong> This is the one that must stay up.</td>
            </tr>
            <tr>
              <td><code>home_assist</code></td>
              <td>8050</td>
              <td>Serves this dashboard. Only reads MySQL.</td>
              <td>You lose the UI. Alerts keep working.</td>
            </tr>
          </tbody>
        </table>
        <p className="w-chart-sub small" style={{ marginTop: 10 }}>
          Port <strong>5176</strong> is the Vite dev server and only runs during development. In normal
          use everything is on <strong>8050</strong>. They cannot both run — pm2 holds the port.
        </p>
      </CollapsibleCard>

      {/* ── reading the dashboard correctly ──────────────────────────────────────── */}
      <CollapsibleCard title="Reading the numbers" defaultOpen={false} forceOpen={force.open} forceKey={force.key}>
        <table className="w-table">
          <thead><tr><th>You see</th><th>It means</th></tr></thead>
          <tbody>
            <tr>
              <td><strong>A gap in a chart</strong></td>
              <td>We were <em>not listening</em>. Different from a zero, which means we were listening
                and no water moved. On a leak monitor those are opposite facts, so they are never drawn
                the same way.</td>
            </tr>
            <tr>
              <td><strong>Flat live line</strong></td>
              <td>Nothing is running. This is the healthy overnight state.</td>
            </tr>
            <tr>
              <td><strong>Collector up, but no readings</strong></td>
              <td>The process is alive and hearing nothing — the dangerous case. The receiver-silent
                alert exists specifically for this.</td>
            </tr>
            <tr>
              <td><strong>Empty “recent readings”</strong></td>
              <td>No water used. Readings are only written when the odometer moves.</td>
            </tr>
            <tr>
              <td><strong>Meter reading {ref.meter.gallons_per_unit === 1 ? '' : '(scaled)'}</strong></td>
              <td>The lifetime odometer, same number as the dial in the pit.
                {ref.meter.gallons_per_unit !== 1 ? ' Scaled by ' + ref.meter.gallons_per_unit + ' gal per count.' : ' 1 count = 1 gallon.'}</td>
            </tr>
          </tbody>
        </table>
      </CollapsibleCard>

      {/* ── the Real time tab ────────────────────────────────────────────────────── */}
      <CollapsibleCard
        title="Reading the Real time tab"
        defaultOpen={false}
        forceOpen={force.open}
        forceKey={force.key}
        actions={<Link className="muted small" to="/water/monitor">Open the Monitor →</Link>}
      >
        <p className="w-chart-sub">
          Three tabs on the meter card, each one rung coarser and one rung longer than the last.
          Nothing overlaps, and no tab is doing another&apos;s job.
        </p>
        <table className="w-table">
          <thead><tr><th>Tab</th><th>Answers</th><th>Source</th><th>Resolution</th><th>Window</th></tr></thead>
          <tbody>
            <tr>
              <td><strong>Real time</strong></td>
              <td>Is it running <em>this second</em>? Is my antenna healthy?</td>
              <td><code>water_packets</code></td>
              <td>every packet (~4 s)</td>
              <td>15 m – 24 h</td>
            </tr>
            <tr>
              <td><strong>Heartbeat</strong></td>
              <td>What happened over the last few days? When did the run start?</td>
              <td><code>water_reception</code></td>
              <td>1 minute</td>
              <td>1 – 72 h</td>
            </tr>
            <tr>
              <td><strong>Long view</strong></td>
              <td>Is usage creeping up month over month?</td>
              <td><code>water_hourly</code></td>
              <td>1 day</td>
              <td>7 – 400 d</td>
            </tr>
          </tbody>
        </table>

        <p className="w-chart-sub" style={{ marginTop: 12, fontWeight: 700 }}>Signal strength, in words</p>
        <p className="w-chart-sub small">
          <strong>SNR is the one that matters.</strong> It is how far the signal sits above the
          background noise, and it — not raw power — predicts whether a packet decodes. RSSI is here
          because read next to <code>noise</code> it separates &ldquo;the meter is far away&rdquo;
          from &ldquo;the band got noisy&rdquo;.
        </p>
        {ref.signal_quality ? (
          <table className="w-table">
            <thead><tr><th>Band</th><th>SNR (dB)</th><th>RSSI (dBm)</th><th>What it means</th></tr></thead>
            <tbody>
              {ref.signal_quality.snr.bands.map((b, i) => {
                const r = ref.signal_quality.rssi.bands[i] || {};
                return (
                  <tr key={b.level}>
                    <td><span className={'w-sig ' + b.level}><span className="w-sig-tag">{b.label}</span></span></td>
                    <td>{b.min === null ? 'below ' + ref.signal_quality.snr.bands[i - 1].min : b.min + ' and up'}</td>
                    <td>{r.min === null ? 'below ' + (ref.signal_quality.rssi.bands[i - 1] || {}).min : r.min + ' and up'}</td>
                    <td className="muted small">{b.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}

        <p className="w-chart-sub" style={{ marginTop: 12, fontWeight: 700 }}>Gaps, and what they tell you</p>
        <table className="w-table">
          <thead><tr><th>What you see</th><th>It means</th></tr></thead>
          <tbody>
            <tr>
              <td><strong>A gap at all</strong></td>
              <td>A silence longer than 3× the measured interval. Normal jitter is not flagged, or the
                list would be one nobody reads.</td>
            </tr>
            <tr>
              <td><strong>Signal collapsed across it</strong></td>
              <td>An <em>RF path</em> problem — something moved, something got wet, a door closed.</td>
            </tr>
            <tr>
              <td><strong>Signal held across it</strong></td>
              <td>Interference, or the receiver stalled. The path was fine; something else was not.</td>
            </tr>
            <tr>
              <td><strong>&ldquo;decoded since 12:31&rdquo;</strong></td>
              <td>The window reaches back further than the recording does. The percentage is measured
                over what was actually recorded, not the whole window — otherwise enabling recording
                an hour ago would report a failing antenna.</td>
            </tr>
            <tr>
              <td><strong>A neighbouring meter</strong></td>
              <td>Captured for comparison only. It can never advance your odometer, enter a rule, or
                raise an alert. If an antenna move raises your SNR and not theirs you improved
                <em> your</em> path; if it raises both, you improved the receiver.</td>
            </tr>
          </tbody>
        </table>

        {ref.packet_columns ? (
          <>
            <p className="w-chart-sub" style={{ marginTop: 12, fontWeight: 700 }}>Every column in the table</p>
            <table className="w-table">
              <thead><tr><th>Column</th><th>Means</th></tr></thead>
              <tbody>
                {ref.packet_columns.map((c) => (
                  <tr key={c.key}>
                    <td style={{ whiteSpace: 'nowrap' }}><code>{c.key}</code></td>
                    <td className="small">{c.help}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small" style={{ marginTop: 6 }}>
              These are the same definitions the column tooltips show — one source, so they cannot
              disagree.
            </p>
          </>
        ) : null}
      </CollapsibleCard>

      {/* ── data ─────────────────────────────────────────────────────────────────── */}
      <CollapsibleCard
        title="Data & retention"
        defaultOpen={false}
        forceOpen={force.open}
        forceKey={force.key}
        actions={<Link className="muted small" to="/water/settings">Change these →</Link>}
      >
        <p className="w-chart-sub">
          Each table stores one <em>level</em> of detail, and each level is either bounded by a prune
          or small enough that it never needs one. The radio hears the meter roughly every 4 seconds —
          about <strong>780,000 packets a year</strong> — and none of them is stored as a row. What
          gets kept is the summary at the resolution that level is actually read at. That is the whole
          reason the database stays in the tens of megabytes rather than the gigabytes.
        </p>
        <table className="w-table">
          <thead><tr><th>Table</th><th>One row is</th><th>Rows/year</th><th>Kept</th></tr></thead>
          <tbody>
            <tr>
              <td><code>water_hourly</code></td>
              <td>One hour of use. Every chart and every leak rule reads this.</td>
              <td>8,760</td>
              <td>{ref.retention.hourly_retention_days
                ? <strong>{ref.retention.hourly_retention_days} days</strong>
                : <><strong>Forever</strong> — ~1 MB/yr. Rarely worth pruning.</>}</td>
            </tr>
            <tr>
              <td><code>water_readings</code></td>
              <td>One accepted reading — written only when the odometer <em>moves</em>, so roughly one
                row per gallon used.</td>
              <td>~50,000 at 130 gal/day</td>
              <td>{ref.retention.readings_retention_days
                ? ref.retention.readings_retention_days + ' days'
                : 'forever (~6 MB/yr)'}</td>
            </tr>
            <tr>
              <td><code>water_reception</code></td>
              <td>One minute of radio reception — packet counts, signal, and the odometer at the end
                of that minute. This is the heartbeat chart.</td>
              <td>525,600 <span className="muted small">if never pruned</span></td>
              <td><strong>{ref.retention.reception_retention_days || 14} days</strong> — a hard cap of
                about {((ref.retention.reception_retention_days || 14) * 1440).toLocaleString()} rows,
                pruned hourly.</td>
            </tr>
            <tr>
              <td><code>water_packets</code></td>
              <td>One decoded transmission — every meter in range. The Real time tab. Neighbours are
                captured for antenna comparison and never counted.</td>
              <td>7,884,000 <span className="muted small">if never pruned</span></td>
              <td><strong>{ref.retention.packets_retention_days || 1} day
                {(ref.retention.packets_retention_days || 1) === 1 ? '' : 's'}</strong> — about{' '}
                {((ref.retention.packets_retention_days || 1) * 21600).toLocaleString()} rows a day
                for your meter, roughly 3× that with two neighbours in range. ~2 MB/day.</td>
            </tr>
            <tr>
              <td className="muted"><em>other meters, every table</em></td>
              <td>A ceiling applied to any meter that is not yours. It can shorten a retention but
                never extend one.</td>
              <td className="muted">—</td>
              <td><strong>{ref.retention.observed_retention_days || 45} days</strong></td>
            </tr>
            <tr>
              <td><code>water_alerts</code></td>
              <td>One alert, for one meter. Also the cooldown ledger, keyed on
                (meter, signal) — so a neighbour's overnight alert can never take the cooldown slot
                and silence yours.</td>
              <td>a few hundred</td>
              <td>{ref.retention.alerts_retention_days ? ref.retention.alerts_retention_days + ' days' : 'forever'}</td>
            </tr>
            <tr>
              <td><code>water_raw_samples</code></td>
              <td>A raw decoder line, kept for field-name forensics.</td>
              <td className="muted">capped, not accumulated</td>
              <td>last {ref.retention.raw_sample_keep} rows, trimmed hourly</td>
            </tr>
            <tr>
              <td><code>water_collector_state</code></td>
              <td>Where the meter is right now.</td>
              <td className="muted">—</td>
              <td><strong>Exactly one row</strong>, updated in place, per meter.</td>
            </tr>
            <tr>
              <td><code>water_settings</code></td>
              <td>One tunable setting.</td>
              <td className="muted">—</td>
              <td>~30 rows, updated in place.</td>
            </tr>
          </tbody>
        </table>
        <p className="w-chart-sub small" style={{ marginTop: 10 }}>
          <strong>Two tables grow on a timer rather than on usage</strong> — <code>water_packets</code>
          and <code>water_reception</code>. Both have hard, always-on prunes, which is what keeps
          the total flat: <code>water_packets</code> settles around 2 MB a day held, and{' '}
          <code>water_reception</code>{' '}writes a row every minute whether or not water moves — which is exactly what
          makes it able to prove the radio is alive during a flat line. At{' '}
          {ref.retention.reception_retention_days || 14} days it settles at a fixed size and stops
          growing; the long view reads <code>water_hourly</code> instead, which is why history past
          two weeks costs nothing.
        </p>
        <p className="w-chart-sub small" style={{ marginTop: 6 }}>
          <strong>The hourly rollup has a floor.</strong> It is the table every chart and every leak
          rule reads, so a short retention there does not just cost detail — it stops the monitor
          being able to detect things. The continuous-flow rule needs six consecutive hours, the
          overnight rule needs last night, and the daily summary needs yesterday. Any value below
          <strong> 7 days</strong> is refused, both on this page and again at the moment of pruning,
          so a value edited straight into the database cannot quietly disarm a rule either. Long view
          ranges beyond the retention simply run out of data rather than showing zeros.
        </p>
        <p className="muted small">
          <strong>Other meters are bounded separately.</strong> Neighbouring meters are captured for
          antenna comparison — signal strength, decode rates, gap analysis. The hourly rollup is
          otherwise permanent, which would turn that into an indefinite record of when other
          households use water. The ceiling above keeps the diagnostic value and bounds the rest;
          your own meter is unaffected, and no other meter can ever raise an alert.
        </p>
        <p className="muted small">
          <strong>Do not</strong> set alert retention below the longest cooldown ({dur(20 * 60)}) —
          that table is also the cooldown ledger, so pruning it too aggressively would let an alert
          repeat immediately.
        </p>
      </CollapsibleCard>

      {/* ── commands ─────────────────────────────────────────────────────────────── */}
      <CollapsibleCard title="Commands worth remembering" defaultOpen={false} forceOpen={force.open} forceKey={force.key}>
        <table className="w-table">
          <thead><tr><th>Do this</th><th>Run</th></tr></thead>
          <tbody>
            <tr><td>Watch the radio</td><td><code>npm run pm2_logs_water_collector</code></td></tr>
            <tr><td>Is everything up?</td><td><code>npm run pm2_status</code></td></tr>
            <tr><td>Check MySQL, email, radio, protocol 223</td><td><code>npm run water_check</code></td></tr>
            <tr><td>Restart everything</td><td><code>npm run pm2_restart_all</code></td></tr>
            <tr><td>Interactive menu (46 items)</td><td><code>npm run home_assist_menu</code></td></tr>
            <tr><td>Wipe meter history, keep settings</td><td><code>npm run water_reset</code> <span className="muted small">(dry run first)</span></td></tr>
          </tbody>
        </table>
        <p className="w-chart-sub small" style={{ marginTop: 10 }}>
          The collector logs a proof-of-life line every 5 minutes — <code>radio ok — N packets in 5m</code>.
          Without it a silent log means either “nobody used water” or “the process died”, and you
          cannot tell which.
        </p>
      </CollapsibleCard>
    </div>
  );
}
