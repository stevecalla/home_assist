'use strict';
/**
 * rate_limit.js — "allow at most N of this per window", as a pure function.
 *
 * Exists because of a specific failure mode: diagnostic logging that is proportional to how badly
 * things are going. The collector writes a row to water_raw_samples every time it rejects a packet.
 * That is exactly right when one packet in a thousand is corrupt, and exactly wrong when the radio
 * starts producing garbage continuously — then it is ~28,000 rows a day of 4KB text, and the thing
 * that fills the disk is the diagnostics for the problem, not the problem.
 *
 * A counter that resets on a window boundary keeps the first few of each hour (which is all you
 * need to diagnose) and drops the rest. `now` is injected so the behaviour is testable without
 * waiting an hour.
 */

function create_limiter(max_per_window, window_ms) {
  let window_start = null;
  let count = 0;
  let dropped = 0;

  return {
    /**
     * @returns { allowed, dropped_since } — dropped_since is the number suppressed in the window
     *          that just ended, non-zero only on the first allowed call of a new window, so the
     *          caller can log "…and 4,812 more" exactly once instead of never mentioning it.
     */
    check(now) {
      const t = (now instanceof Date ? now.getTime() : now);
      if (window_start === null || (t - window_start) >= window_ms) {
        const carried = dropped;
        window_start = t;
        count = 1;
        dropped = 0;
        return { allowed: true, dropped_since: carried };
      }
      if (count < max_per_window) {
        count++;
        return { allowed: true, dropped_since: 0 };
      }
      dropped++;
      return { allowed: false, dropped_since: 0 };
    },

    state() { return { window_start, count, dropped }; },
  };
}

module.exports = { create_limiter };
