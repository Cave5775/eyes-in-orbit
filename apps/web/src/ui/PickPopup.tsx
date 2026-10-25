import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { moveIndex, popupPlacement, wheelSteps } from '../lib/pick';

export interface PickItem {
  id: string;
  name: string;
  /** kind label, already readable */
  kind: string;
  /** colour token of the object's category (`--c-<category>`, see `colorKeyOf`) */
  colorKey: string;
}

interface Props {
  items: PickItem[];
  /** candidates beyond the listed ones */
  more: number;
  /** the click, CSS px inside the scene */
  x: number;
  y: number;
  onSelect(id: string): void;
  onClose(): void;
  /** the highlighted candidate (marked in the 3D scene); null when the popup goes away */
  onHighlight(id: string | null): void;
}

/**
 * Choice list for a click on several overlapping objects. The mouse wheel moves the highlight (it is captured at the
 * window, so the camera does not zoom while the popup is open), hover highlights a row, a click or Enter selects it,
 * Up and Down also move, Escape or a press outside closes. Rows are plain buttons, so a tap works without hover.
 * (Objects over a small distant body never get here: they are not drawn nor pickable, a click there selects the body.)
 */
export function PickPopup({ items, more, x, y, onSelect, onClose, onHighlight }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const rows = items.length;
  // handlers read the latest values without re-subscribing on every render
  const live = useRef({ items, index, rows, onSelect, onClose, onHighlight });
  live.current = { items, index, rows, onSelect, onClose, onHighlight };

  // placed next to the cursor, flipped away from the scene edges once its size is known
  useLayoutEffect(() => {
    const el = root.current, host = el?.offsetParent as HTMLElement | null;
    if (el && host) setPos(popupPlacement(x, y, el.offsetWidth, el.offsetHeight, host.clientWidth, host.clientHeight));
  }, [x, y, items.length, more]);

  useEffect(() => {
    live.current.onHighlight(items[index]?.id ?? null);
  }, [index, items]);
  useEffect(() => () => live.current.onHighlight(null), []);

  useEffect(() => {
    let acc = 0;
    const step = (n: number) => setIndex((i) => moveIndex(i, n, live.current.rows));
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (k !== 'Escape' && k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation(); // Escape must not also deselect, arrows must not scroll
      if (k === 'Escape') live.current.onClose();
      else if (k === 'ArrowDown') step(1);
      else if (k === 'ArrowUp') step(-1);
      else {
        const it = live.current.items[live.current.index];
        if (it) live.current.onSelect(it.id);
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation(); // the orbit rig never sees it: no zoom
      const r = wheelSteps(acc, e.deltaY, e.deltaMode);
      acc = r.acc;
      if (r.steps) step(r.steps);
    };
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) live.current.onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, []);

  return (
    <div
      ref={root}
      className="popover pick-pop"
      role="listbox"
      aria-label="Objects under the cursor"
      style={{ left: pos?.left ?? x + 12, top: pos?.top ?? y + 12, visibility: pos ? 'visible' : 'hidden' }}
    >
      <div className="pop-title">{items.length + more} OBJECTS HERE</div>
      {items.map((it, i) => (
        <button
          key={it.id}
          role="option"
          aria-selected={i === index}
          className={i === index ? 'pick-row on' : 'pick-row'}
          onPointerEnter={() => setIndex(i)}
          onClick={() => onSelect(it.id)}
        >
          <i style={{ background: `var(--c-${it.colorKey})` }} />
          <span className="pick-name">{it.name}</span>
          <span className="pick-kind">{it.kind}</span>
        </button>
      ))}
      {more > 0 && <div className="pick-more">+ {more} more, zoom in to separate them</div>}
      <div className="pick-hint">WHEEL / ARROWS CHOOSE · CLICK OR ENTER SELECT · ESC CLOSE</div>
    </div>
  );
}
