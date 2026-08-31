import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * CardStack — a list of cards the reader can put in their own order.
 *
 * Pages like Admin and Metrics stack five or six cards whose "right" order depends entirely on why
 * you opened the page. Someone tuning access wants Users at the top; someone chasing a fault wants
 * Issues there. Neither is wrong, and picking one for everybody means the other person scrolls past
 * the same three cards every time.
 *
 * TWO WAYS TO MOVE A CARD, deliberately:
 *
 *   DRAG the handle. Fast when you know where it is going.
 *   ▲ / ▼ buttons. The only ones that work with a keyboard, on a phone, or with a screen reader —
 *   and the only ones that can be tested without simulating pointer physics. Drag-and-drop as the
 *   sole mechanism is a feature that quietly excludes people.
 *
 * Only the HANDLE starts a drag, not the card. A card body holds inputs, tables and text; making
 * the whole thing draggable turns every attempt to select a value into a drag of the card.
 *
 * The order lives in localStorage, per page, per browser. It is a preference about how one person
 * likes to read a page — not data, not shared, and not worth a column and a round trip. Every
 * access is wrapped: Safari's private mode throws on write, and a layout preference is never worth
 * a blank page.
 */
const PREFIX = 'ha_cardorder_';

function read_order(key) {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    const list = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) ? list.filter(function (x) { return typeof x === 'string'; }) : null;
  } catch (e) { return null; }
}
function write_order(key, list) {
  try { window.localStorage.setItem(PREFIX + key, JSON.stringify(list)); } catch (e) { /* private mode */ }
}
function clear_order(key) {
  try { window.localStorage.removeItem(PREFIX + key); } catch (e) { /* private mode */ }
}

/**
 * Apply a saved order to the CURRENT set of cards.
 *
 * Saved ids that no longer exist are dropped, and cards the saved order has never seen are appended
 * in their declared position rather than hidden. That second rule is the one that matters: a card
 * added in a later release must still appear for someone who reordered the page a year ago —
 * otherwise the feature ships invisible to exactly the people who use the page most.
 */
export function apply_order(ids, saved) {
  if (!saved || !saved.length) return ids.slice();
  const known = new Set(ids);
  const out = saved.filter(function (id) { return known.has(id); });
  const placed = new Set(out);
  ids.forEach(function (id, i) {
    if (placed.has(id)) return;
    // Insert where it was declared, not at the end: a new card that belongs second reads as an
    // afterthought if it always lands last.
    out.splice(Math.min(i, out.length), 0, id);
    placed.add(id);
  });
  return out;
}

export default function CardStack({ storageKey, items, className }) {
  const ids = useMemo(function () { return items.map(function (it) { return it.id; }); },
    [items.map(function (it) { return it.id; }).join('|')]);   // eslint-disable-line react-hooks/exhaustive-deps

  const [order, setOrder] = useState(function () { return apply_order(ids, read_order(storageKey)); });
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const [armed, setArmed] = useState(null);      // which handle is holding the mouse down

  // Re-apply whenever the SET of cards changes — a page that conditionally renders a card must not
  // lose the saved order of the others.
  useEffect(function () { setOrder(apply_order(ids, read_order(storageKey))); }, [ids, storageKey]);

  const commit = useCallback(function (next) {
    setOrder(next);
    write_order(storageKey, next);
  }, [storageKey]);

  const move = useCallback(function (id, delta) {
    const i = order.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = order.slice();
    next.splice(j, 0, next.splice(i, 1)[0]);
    commit(next);
    // Keep the focus on the button that moved, so a second press repeats the move rather than
    // landing on whatever the DOM shuffle put under the cursor.
    window.requestAnimationFrame(function () {
      const el = document.querySelector('[data-cardmove="' + id + '-' + (delta < 0 ? 'up' : 'down') + '"]');
      if (el) el.focus();
    });
  }, [order, commit]);

  function drop_on(target) {
    if (!dragId || dragId === target) return;
    const next = order.slice();
    const from = next.indexOf(dragId);
    next.splice(from, 1);
    next.splice(next.indexOf(target) + (from < next.indexOf(target) ? 1 : 0), 0, dragId);
    commit(next);
  }

  const byId = {};
  items.forEach(function (it) { byId[it.id] = it; });
  const moved = order.join('|') !== ids.join('|');

  return (
    <div className={'ha-stack' + (className ? ' ' + className : '')}>
      {moved ? (
        <div className="ha-stack-reset">
          <button type="button" className="btn small"
                  onClick={function () { clear_order(storageKey); setOrder(ids.slice()); }}>
            Reset card order
          </button>
        </div>
      ) : null}

      {order.map(function (id, i) {
        const it = byId[id];
        if (!it) return null;
        return (
          <div
            key={id}
            className={'ha-stack-item'
              + (dragId === id ? ' is-dragging' : '')
              + (overId === id && dragId && dragId !== id ? ' is-over' : '')}
            // draggable only while the handle is held. Otherwise selecting text inside a card
            // starts a drag of the card, which is maddening in a table.
            draggable={armed === id}
            onDragStart={function (e) { setDragId(id); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); } catch (err) { /* ignore */ } }}
            onDragEnd={function () { setDragId(null); setOverId(null); setArmed(null); }}
            onDragOver={function (e) { if (dragId) { e.preventDefault(); setOverId(id); } }}
            onDrop={function (e) { e.preventDefault(); drop_on(id); setDragId(null); setOverId(null); setArmed(null); }}
          >
            <div className="ha-stack-grip">
              <span
                className="ha-grip"
                role="button"
                tabIndex={-1}
                aria-hidden="true"
                title="Drag to move this card"
                onMouseDown={function () { setArmed(id); }}
                onMouseUp={function () { setArmed(null); }}
              >⠿</span>
              <button type="button" className="ha-stack-btn" data-cardmove={id + '-up'}
                      disabled={i === 0} onClick={function () { move(id, -1); }}
                      aria-label={'Move ' + (it.label || id) + ' up'} title="Move up">▲</button>
              <button type="button" className="ha-stack-btn" data-cardmove={id + '-down'}
                      disabled={i === order.length - 1} onClick={function () { move(id, 1); }}
                      aria-label={'Move ' + (it.label || id) + ' down'} title="Move down">▼</button>
            </div>
            <div className="ha-stack-body">{it.node}</div>
          </div>
        );
      })}
    </div>
  );
}
