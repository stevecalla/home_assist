import { useEffect, useState } from 'react';

/**
 * The water panel's meter selection, shared by every page in the module.
 *
 * Deliberately a module-level value with a subscriber list rather than storage or a context:
 *
 *  - Shared, because the selection is a property of what you are LOOKING AT, not of one card.
 *    Picking a neighbour on the Monitor and then opening History only to be silently returned to
 *    your own meter is the bug this exists to prevent — the numbers would change with no visible
 *    cause.
 *  - NOT persisted, so a page load always comes back to your own meter. A leak monitor that
 *    reopens showing someone else's house, with the banner reading "All clear" about a meter that
 *    is not yours, is the one failure mode worth designing against. Sticky convenience is not
 *    worth it here.
 *  - Not React context, because that would mean wrapping the module's routes in a provider — a
 *    change to the shell for the sake of one module.
 *
 * Values: 'mine' | 'all' | a meter id as a string. The API resolves all three.
 */
const OWN = 'mine';

let current = OWN;
const listeners = new Set();

export function get_meter_sel() { return current; }

export function set_meter_sel(next) {
  const v = String(next === undefined || next === null ? OWN : next);
  if (v === current) return;
  current = v;
  listeners.forEach(function (fn) { try { fn(v); } catch (e) { /* a dead subscriber never blocks the rest */ } });
}

/** Reset to the owned meter. Called once when the module mounts, not on every navigation. */
export function reset_meter_sel() { set_meter_sel(OWN); }

/** `const [sel, setSel] = useMeterSel();` — same shape as useState, so callers read normally. */
export function useMeterSel() {
  const [value, setValue] = useState(current);
  useEffect(function () {
    // Re-sync on mount: another page may have changed it between renders.
    setValue(current);
    listeners.add(setValue);
    return function () { listeners.delete(setValue); };
  }, []);
  return [value, set_meter_sel];
}
