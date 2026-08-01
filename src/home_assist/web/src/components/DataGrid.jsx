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
  renderLimit = 800,    // how many rows reach the DOM when NOT paginating
  paginate = false,
  pageSizes = [50, 100, 250, 500],
  initialPageSize = 100,
  windowTotal,          // rows in the server-side window, before its fetch limit
  windowNote,           // one line explaining what was left out
  freezeCols = 0,       // how many leading DATA columns stay put when scrolling sideways
  freezeWidths = [],    // their pixel widths — sticky needs a known offset, not a guess
  numWidth = 46,
}) {
  const [sort, setSort] = useState(initialSort || null);
  const [q, setQ] = useState('');
  const [newCount, setNewCount] = useState(0);
  const [flash, setFlash] = useState(() => new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);

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

  // ── frozen columns ─────────────────────────────────────────────────────────────────────────
  // `left` offsets have to be exact pixels, so the frozen columns get fixed widths. Sticky cells
  // also need an OPAQUE background or the rows sliding underneath show straight through them —
  // which is the failure that makes a frozen column look broken rather than absent. Every cell in
  // this table therefore paints `--w-row-bg`, a solid colour set per row state.
  const frozen = Math.max(0, Math.min(freezeCols, columns.length));
  const offsets = (() => {
    const out = [];
    let x = rowNumbers ? numWidth : 0;
    for (let i = 0; i < frozen; i++) {
      out.push(x);
      x += freezeWidths[i] || 130;
    }
    return out;
  })();
  const freezeStyle = (i) => (i < frozen
    ? { position: 'sticky', left: offsets[i], width: freezeWidths[i] || 130, minWidth: freezeWidths[i] || 130 }
    : undefined);
  const freezeClass = (i) => (i < frozen ? ' is-frozen' + (i === frozen - 1 ? ' is-frozen-edge' : '') : '');

  const toggle = (key) => setSort((s) => (
    !s || s.key !== key ? { key, dir: 'asc' }
      : s.dir === 'asc' ? { key, dir: 'desc' }
        : null                                   // third click clears — back to natural order
  ));

  const shown = sorted.length;
  const total = totalRows !== undefined && totalRows !== null ? totalRows : (rows || []).length;

  // ── paging ─────────────────────────────────────────────────────────────────────────────────
  // What reaches the DOM. 5,000 rows x 12 cells is 60,000 elements — enough to make sorting and
  // even scrolling visibly stutter, for rows nobody scrolls to. Paging solves that properly:
  // instead of truncating to "the first 800 and you cannot have the rest", every row is reachable
  // and exactly one page is painted. The chart and the CSV always use the FULL fetched set.
  const pageCount = paginate ? Math.max(1, Math.ceil(shown / pageSize)) : 1;
  const safePage = Math.min(page, pageCount);
  const start = paginate ? (safePage - 1) * pageSize : 0;
  const visible = paginate
    ? sorted.slice(start, start + pageSize)
    : (sorted.length > renderLimit ? sorted.slice(0, renderLimit) : sorted);

  // Filtering or re-sorting makes the current page meaningless — "page 7 of the old order" is not a
  // place. Snap back to the first page rather than stranding the reader somewhere arbitrary.
  useEffect(() => { setPage(1); }, [q, sort && sort.key, sort && sort.dir, pageSize]);

  // Only page 1 is live. On any later page the rows are a fixed slice of history and prepending to
  // it would shuffle content under the reader's eyes on every poll; the "N new" pill is how you
  // come back. Same principle as the scroll behaviour — never move what someone is reading.
  const atLiveEdge = !paginate || safePage === 1;

  // ── live arrivals ──────────────────────────────────────────────────────────────────────────
  // useLayoutEffect, not useEffect: the scroll correction has to happen in the same frame the new
  // rows are painted. One frame late and you watch your reading position jump and snap back.
  useLayoutEffect(() => {
    if (!live) return;
    const el = scrollRef.current;
    const keys = visible.map((r, i) => r._key || i);
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

    if (!atLiveEdge) {
      setNewCount((n) => n + fresh.length);
      return;
    }

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
  }, [visible, live, atLiveEdge]);

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
    setPage(1);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    atTopRef.current = true;
    setNewCount(0);
  }

  // Everything the reader can change, back to how the table arrived. Deliberately ONE button
  // rather than three: after ten minutes of filtering, sorting and paging, "put it back" is a
  // single intention, and having to undo each control separately is how you end up reloading the
  // page instead.
  const dirty = !!q || !!sort || safePage !== 1 || pageSize !== initialPageSize;
  function reset() {
    setQ('');
    setSort(initialSort || null);
    setPage(1);
    setPageSize(initialPageSize);
    setNewCount(0);
    if (scrollRef.current) { scrollRef.current.scrollTop = 0; scrollRef.current.scrollLeft = 0; }
    atTopRef.current = true;
  }

  function goto(n) {
    setPage(Math.min(Math.max(1, n), pageCount));
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    atTopRef.current = true;
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
            ↕ sorted by {sort.key}
          </button>
        ) : null}
        <button type="button" className={'w-grid-reset' + (dirty ? ' is-dirty' : '')}
                onClick={reset} disabled={!dirty}
                title={dirty
                  ? 'Clear the filter and sort, return to page 1, and scroll back to the start'
                  : 'Nothing to reset — the table is as it arrived'}>
          ↺ reset
        </button>
        {live ? (
          <span className="w-grid-live" title="This table is updating as transmissions arrive">
            <i aria-hidden="true" />LIVE
          </span>
        ) : null}
        {/* Say what is NOT here. A grid that renders 800 of 20,571 and reports "800 rows" is the
            same silent-truncation bug as a chart whose axis lies about its window. */}
        <span className="w-grid-count">
          {paginate && pageCount > 1
            ? 'page ' + safePage.toLocaleString() + ' of ' + pageCount.toLocaleString() + ' · ' +
              shown.toLocaleString() + ' loaded'
            : visible.length.toLocaleString() +
              (visible.length !== shown ? ' of ' + shown.toLocaleString() + ' loaded' : ' rows')}
          {windowTotal && windowTotal > shown ? ' · ' + windowTotal.toLocaleString() + ' in window' : ''}
        </span>
      </div>

      {windowNote && ((windowTotal && windowTotal > shown) || visible.length !== shown) ? (
        <p className="w-grid-note">{windowNote}</p>
      ) : null}

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
                <th className={'w-grid-num' + (frozen ? ' is-frozen' : '')}
                    style={frozen ? { position: 'sticky', left: 0, width: numWidth, minWidth: numWidth } : undefined}>
                  <span className="w-grid-th as-static"
                        title="Position in the list as displayed. With newest first it shifts down as transmissions arrive — it numbers the view, not the row.">
                    #
                  </span>
                </th>
              ) : null}
              {columns.map((c, ci) => {
                const active = sort && sort.key === c.key;
                return (
                  <th key={c.key} className={(active ? 'is-sorted' : '') + freezeClass(ci)}
                      style={freezeStyle(ci)}>
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
            ) : visible.map((r, i) => (
              <tr key={r._key || i}
                  className={(r._highlight ? 'is-mine' : (r._dim ? 'is-other' : '')) +
                    (flash.has(r._key || i) ? ' is-new' : '')}>
                {/* Numbering continues ACROSS pages — row 101 on page 2 is row 101 of the list,
                    not row 1 of the page. Restarting at 1 would make the column a page offset
                    dressed up as a position. */}
                {rowNumbers ? (
                  <td className={'w-grid-num' + (frozen ? ' is-frozen' : '')}
                      style={frozen ? { position: 'sticky', left: 0, width: numWidth, minWidth: numWidth } : undefined}>
                    {start + i + 1}
                  </td>
                ) : null}
                {columns.map((c, ci) => (
                  <td key={c.key} className={'align-' + (c.align || 'center') + freezeClass(ci)}
                      style={freezeStyle(ci)}>
                    {renderCell ? renderCell(c, r[c.key], r) : fallback(r[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          </table>
        </div>
      </div>

      {paginate ? (
        <div className="w-page-bar">
          <button type="button" disabled={safePage <= 1} onClick={() => goto(1)} title="First page">« first</button>
          <button type="button" disabled={safePage <= 1} onClick={() => goto(safePage - 1)}>‹ prev</button>
          <span className="w-page-of">
            page
            <input
              className="w-page-in"
              value={safePage}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n)) goto(n);
              }}
              aria-label="page number"
            />
            of {pageCount.toLocaleString()}
          </span>
          <button type="button" disabled={safePage >= pageCount} onClick={() => goto(safePage + 1)}>next ›</button>
          <button type="button" disabled={safePage >= pageCount} onClick={() => goto(pageCount)} title="Last page">last »</button>

          <span className="w-page-size">
            <span className="w-range-label">per page</span>
            {pageSizes.map((n) => (
              <button key={n} type="button"
                      className={'w-chip' + (pageSize === n ? ' on' : '')}
                      onClick={() => setPageSize(n)}>{n}</button>
            ))}
          </span>

          {/* Page 1 is the live edge; anywhere else is history and stays put. Saying so beats
              letting someone wonder why page 4 stopped updating. */}
          {live ? (
            <span className={'w-page-live ' + (atLiveEdge ? 'on' : 'off')}>
              {atLiveEdge ? '● live' : 'paused — page 1 is live'}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function fallback(v) {
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
  return String(v);
}
