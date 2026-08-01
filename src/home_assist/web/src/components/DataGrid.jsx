import { useMemo, useState, useRef, useLayoutEffect, useEffect } from 'react';

/**
 * DataGrid — a table that behaves like one: sort, filter, sticky header, row hover, and a
 * definition on every column header.
 *
 * Column definitions come from the SERVER (`/api/water/packets` -> `columns`), deliberately. A
 * tooltip typed into a React component drifts from the query that produces the column, and a
 * confidently wrong definition is worse than none. The API owns both, so they change together.
 *
 * Sorting is client-side over the rows already fetched, and the footer says how many of how many
 * are on screen. That distinction matters: sorting 500 of 13,000 rows by RSSI shows you the weakest
 * of the RECENT ones, not the weakest overall, and a grid that hides that is lying quietly.
 *
 * LIVE BEHAVIOUR (`live` prop). Rows arrive newest-first while you are looking at them, and the
 * right response depends on where you are:
 *
 *   At the top    stay pinned at the top. New rows appear under the header as they land, which is
 *                 the whole point of a live table, and each is flashed briefly so an arrival is
 *                 motion rather than a silently longer list.
 *   Scrolled away you are READING something. Prepending rows would shove that line down the screen
 *                 mid-sentence, so the scroll offset is adjusted by exactly the height of what was
 *                 inserted — your row does not move a pixel — and a "N new" pill appears. Clicking
 *                 it returns you to the top and clears the count.
 *
 * Auto-scrolling someone away from what they were reading is the failure mode this avoids; a table
 * that silently swallows new rows while you look away is the other. The pill is what lets both be
 * true at once.
 */

// A value's rendered form and its sort key are different problems. "916.4512" sorts as a number;
// "—" for a null must sort to one end rather than landing wherever string comparison drops it.
function sort_key(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v).toLowerCase();
}

function compare(a, b, dir) {
  const ka = sort_key(a), kb = sort_key(b);
  if (ka === null && kb === null) return 0;
  if (ka === null) return 1;            // nulls always sink, in both directions
  if (kb === null) return -1;
  if (ka < kb) return dir === 'asc' ? -1 : 1;
  if (ka > kb) return dir === 'asc' ? 1 : -1;
  return 0;
}

export default function DataGrid({
  columns,              // [{ key, label, help, align, type, unit }]
  rows,                 // [ { ...values, _highlight?: bool } ]
  initialSort,          // { key, dir }
  filterPlaceholder = 'Filter…',
  renderCell,           // optional (col, value, row) => node
  totalRows,            // the count BEFORE the fetch limit, if larger than rows.length
  emptyMessage = 'Nothing in this window yet.',
  maxHeight = 380,
  live = false,         // newest-first and arriving continuously
  liveLabel = 'new',
  rowNumbers = false,   // a leading position column
}) {
  const [sort, setSort] = useState(initialSort || null);
  const [q, setQ] = useState('');
  const [newCount, setNewCount] = useState(0);
  const [flash, setFlash] = useState(() => new Set());

  const scrollRef = useRef(null);
  const atTopRef = useRef(true);
  const seenRef = useRef(null);          // null until the first render, so row 1 does not "flash in"

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows || [];
    // Substring across every rendered column. Deliberately dumb: a query language would be a
    // feature nobody asked for, and "type 16642655 and see only that meter" is the actual use.
    return (rows || []).filter((r) => columns.some((c) => {
      const v = r[c.key];
      return v !== null && v !== undefined && String(v).toLowerCase().indexOf(needle) !== -1;
    }));
  }, [rows, q, columns]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const out = filtered.slice();
    out.sort((a, b) => compare(a[sort.key], b[sort.key], sort.dir));
    return out;
  }, [filtered, sort]);

  const toggle = (key) => setSort((s) => (
    !s || s.key !== key ? { key, dir: 'asc' }
      : s.dir === 'asc' ? { key, dir: 'desc' }
        : null                                   // third click clears — back to natural order
  ));

  const shown = sorted.length;
  const total = totalRows !== undefined && totalRows !== null ? totalRows : (rows || []).length;

  // ── live arrivals ──────────────────────────────────────────────────────────────────────────
  // useLayoutEffect, not useEffect: the scroll correction has to happen in the same frame the new
  // rows are painted. One frame late and you watch your reading position jump and snap back.
  useLayoutEffect(() => {
    if (!live) return;
    const el = scrollRef.current;
    const keys = sorted.map((r, i) => r._key || i);
    const seen = seenRef.current;

    if (seen === null) {                       // first paint — everything is "already there"
      seenRef.current = new Set(keys);
      return;
    }

    const fresh = keys.filter((k) => !seen.has(k));
    keys.forEach((k) => seen.add(k));
    // The set would otherwise grow without bound over a long session on a fast table.
    if (seen.size > 12000) seenRef.current = new Set(keys);
    if (!fresh.length || !el) return;

    if (atTopRef.current) {
      el.scrollTop = 0;
      setFlash(new Set(fresh));
    } else {
      // Hold the reader's line exactly where it was. Measuring the rendered rows rather than
      // assuming a fixed height keeps this correct when a cell wraps or the font changes.
      const rowEls = el.querySelectorAll('tbody tr');
      let delta = 0;
      for (let i = 0; i < fresh.length && i < rowEls.length; i++) delta += rowEls[i].offsetHeight;
      el.scrollTop += delta;
      setNewCount((n) => n + fresh.length);
    }
  }, [sorted, live]);

  // The flash is a one-shot: clear it so a row that arrives, is read, and stays does not keep
  // announcing itself.
  useEffect(() => {
    if (!flash.size) return undefined;
    const id = setTimeout(() => setFlash(new Set()), 1400);
    return () => clearTimeout(id);
  }, [flash]);

  function onScroll(e) {
    const top = e.currentTarget.scrollTop <= 6;
    atTopRef.current = top;
    if (top && newCount) setNewCount(0);
  }

  function toTop() {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    atTopRef.current = true;
    setNewCount(0);
  }

  return (
    <div className="w-grid">
      <div className="w-grid-bar">
        <input
          className="w-grid-filter"
          value={q}
          placeholder={filterPlaceholder}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Filter rows"
        />
        {q ? <button type="button" className="w-grid-clear" onClick={() => setQ('')}>✕ clear</button> : null}
        {sort ? (
          <button type="button" className="w-grid-clear" onClick={() => setSort(null)}>
            ↕ sorted by {sort.key} — reset
          </button>
        ) : null}
        {live ? (
          <span className="w-grid-live" title="This table is updating as transmissions arrive">
            <i aria-hidden="true" />LIVE
          </span>
        ) : null}
        <span className="w-grid-count">
          {shown.toLocaleString()}{shown !== total ? ' of ' + total.toLocaleString() : ''} rows
        </span>
      </div>

      <div className="w-grid-wrap">
        {newCount ? (
          <button type="button" className="w-grid-new" onClick={toTop}>
            ↑ {newCount.toLocaleString()} {liveLabel}
          </button>
        ) : null}
        <div className="w-grid-scroll" ref={scrollRef} onScroll={onScroll} style={{ maxHeight }}>
        <table className="w-grid-table">
          <thead>
            <tr>
              {/* Position, not identity. Deliberately NOT sortable — it IS the sort order, so
                  clicking it could only ever reorder by the thing it is describing. It is also
                  excluded from the filter, or typing "1" would match nearly every row. */}
              {rowNumbers ? (
                <th className="w-grid-num">
                  <span className="w-grid-th as-static"
                        title="Position in the list as displayed. With newest first it shifts down as transmissions arrive — it numbers the view, not the row.">
                    #
                  </span>
                </th>
              ) : null}
              {columns.map((c) => {
                const active = sort && sort.key === c.key;
                return (
                  <th key={c.key} className={active ? 'is-sorted' : ''}>
                    {/* The whole header is the sort control AND the tooltip target — one hit area,
                        so there is no 12px arrow to chase. `title` is used rather than a custom
                        popover because it survives keyboard focus and screen readers for free. */}
                    <button
                      type="button"
                      className="w-grid-th"
                      onClick={() => toggle(c.key)}
                      title={c.help ? c.label + (c.unit ? ' (' + c.unit + ')' : '') + ' — ' + c.help : c.label}
                    >
                      <span className="w-grid-label">{c.label}</span>
                      {c.help ? <span className="w-grid-info" aria-hidden="true">?</span> : null}
                      <span className="w-grid-arrow">{active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {!sorted.length ? (
              <tr><td colSpan={columns.length + (rowNumbers ? 1 : 0)} className="w-grid-empty">{q ? 'Nothing matches "' + q + '".' : emptyMessage}</td></tr>
            ) : sorted.map((r, i) => (
              <tr key={r._key || i}
                  className={(r._highlight ? 'is-mine' : (r._dim ? 'is-other' : '')) +
                    (flash.has(r._key || i) ? ' is-new' : '')}>
                {rowNumbers ? <td className="w-grid-num">{i + 1}</td> : null}
                {columns.map((c) => (
                  <td key={c.key} className={'align-' + (c.align || 'center')}>
                    {renderCell ? renderCell(c, r[c.key], r) : fallback(r[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function fallback(v) {
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
  return String(v);
}
