/**
 * num.js — how a number is written on screen.
 *
 * One rule, one place: anything four digits or longer gets thousands separators. "2480 gal" and
 * "2,480 gal" carry the same information but not the same speed — the eye reads the grouped one as
 * a magnitude and the bare one as a string of digits, and a monthly total is exactly the figure you
 * want judged at a glance rather than parsed.
 *
 * This exists because `toFixed()` was doing the formatting at ~20 call sites. toFixed is a rounding
 * function, not a formatting one: it never groups, at any magnitude. Every one of those sites was
 * therefore printing 2480 where it meant 2,480, and each was one edit away from disagreeing with
 * the next.
 *
 * TWO PLACES DELIBERATELY DO NOT USE THIS, and both would be broken by it:
 *
 *   - CSV export rows (components/CardTools.jsx feeds them to to_csv). A grouped number is quoted
 *     into the file as "2,480" and lands in a spreadsheet as TEXT — the column stops summing. The
 *     rows arrays are data, not display.
 *   - SVG path coordinates (`M${px.toFixed(1)} ${py...}`). Path data is space- and comma-delimited,
 *     so a grouped coordinate does not render a wrong chart, it renders no chart at all.
 *
 * Locale is deliberately the browser's (`undefined`), matching the toLocaleString() calls that were
 * already here. The server formats its own numbers for email with en-US, because an email is read
 * away from the browser that requested it.
 */

// A number is only a number if it is one. NaN, null and undefined all render as an em dash --
// the same "we do not know" the rest of the water UI uses. Printing "NaN gal" on a leak monitor
// invites the reader to treat it as a reading.
export function num(value, dp = 0) {
  // null and '' BEFORE Number(), which turns both into 0. That coercion is the reason a missing
  // reading could render as a confident "0 gal" -- the one thing a leak monitor must never say
  // when it means "we do not know". Number(undefined) is NaN and would have been caught below;
  // Number(null) is 0 and would not.
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

// Gallons, the unit this app is almost entirely made of. Sub-10 volumes keep a decimal because
// "0 gal" and "0.4 gal" are a meaningful difference overnight; above that the decimal is noise.
export function gal(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return num(n, Math.abs(n) < 10 ? 1 : 0);
}
