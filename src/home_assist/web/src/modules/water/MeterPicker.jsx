import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

/**
 * The meter selector: two pills plus a caret that opens the list.
 *
 * One component, used by Monitor, History and Diagnostics, so the control looks and behaves the
 * same everywhere and the selection cannot mean one thing on one page and another elsewhere.
 * Selection itself lives in meterSel.js — this only renders it.
 *
 * A DISPLAY filter. What gets captured is packets_capture_all_meters in Settings; changing this
 * never changes what is stored.
 *
 * Props:
 *   sel, setSel  the shared selection (from useMeterSel)
 *   ownId        your meter id, for the "This meter" tooltip
 *   allowAll     false on pages that chart usage — two houses' odometers cannot be summed into one
 *                line, so "All meters" only means something where rows sit side by side
 */
export default function MeterPicker({ sel, setSel, ownId, allowAll = true }) {
  const [meterList, setMeterList] = useState(null);
  const [open, setOpen] = useState(false);

  // Options come from water_meters, not from whatever packets were just fetched. Packets are pruned
  // within a day, so a list derived from them loses any meter that went quiet overnight — options
  // that come and go read as a bug in the app rather than as reception.
  useEffect(() => {
    let live = true;
    api.waterMeters().then((r) => {
      if (live && r.status === 200 && r.body.ok) setMeterList(r.body.meters);
    });
    return () => { live = false; };
  }, []);

  // The id IS the name. An auto-generated label that only repeated the "mine" badge beside it said
  // the same thing twice and hid the number you actually search the table by.
  const label = sel === 'mine' || sel === 'all' ? 'All meters' : String(sel);

  // The menu lives in a WRAPPER, not inside .w-filt. That pill has overflow:hidden to clip its own
  // rounded corners, which silently clipped the dropdown out of existence — it rendered, it was
  // just invisible. Anything absolutely positioned below a pill has to escape that box.
  return (
    <span className="w-pickwrap">
      <span className="w-filt">
        <button type="button"
                className={sel === 'mine' ? 'on' : ''}
                onClick={() => { setSel('mine'); setOpen(false); }}
                title={'Your meter' + (ownId ? ' (' + ownId + ')' : '')}>
          This meter
        </button>
        <button type="button"
                className={sel !== 'mine' ? 'on' : ''}
                onClick={() => { setSel(allowAll ? 'all' : sel === 'mine' ? 'mine' : sel); setOpen(!allowAll); }}
                title={allowAll
                  ? 'Every meter the radio hears, mixed into one table'
                  : 'Pick one meter — usage totals are per meter and cannot be summed across houses'}>
          {label}
        </button>
        <button type="button"
                className={'w-caret' + (open ? ' on' : '')}
                aria-label="Pick a meter"
                title="Pick one meter"
                onClick={() => setOpen((v) => !v)}>▾</button>
      </span>
      {open ? (
        <span className="w-pick-menu" onMouseLeave={() => setOpen(false)}>
          {allowAll ? (
            <button type="button"
                    className={sel === 'all' ? 'on' : ''}
                    onClick={() => { setSel('all'); setOpen(false); }}>
              All meters
            </button>
          ) : null}
          {(meterList || []).map((m) => (
            <button key={m.meter_id} type="button"
                    className={sel === String(m.meter_id) ? 'on' : ''}
                    disabled={!m.has_packets && !m.has_readings}
                    onClick={() => { setSel(String(m.meter_id)); setOpen(false); }}>
              {m.meter_id}
              {m.owned ? <i className="w-mine">mine</i> : null}
              {m.has_packets || m.has_readings ? null : <i className="w-nodata">no data</i>}
            </button>
          ))}
          {meterList && meterList.length === 0
            ? <span className="w-pick-empty">No meters heard yet</span> : null}
          {meterList === null
            ? <span className="w-pick-empty">Loading…</span> : null}
        </span>
      ) : null}
    </span>
  );
}
