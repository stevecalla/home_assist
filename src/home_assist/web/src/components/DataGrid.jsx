import { useMemo, useState } from 'react';

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
}) {
  const [sort, setSort] = useState(initialSort || null);
  const [q, setQ] = useState('');

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
        <span className="w-grid-count">
          {shown.toLocaleString()}{shown !== total ? ' of ' + total.toLocaleString() : ''} rows
        </span>
      </div>

      <div className="w-grid-scroll" style={{ maxHeight }}>
        <table className="w-grid-table">
          <thead>
            <tr>
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
              <tr><td colSpan={columns.length} className="w-grid-empty">{q ? 'Nothing matches "' + q + '".' : emptyMessage}</td></tr>
            ) : sorted.map((r, i) => (
              <tr key={r._key || i} className={r._highlight ? 'is-mine' : (r._dim ? 'is-other' : '')}>
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
  );
}

function fallback(v) {
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
  return String(v);
}
