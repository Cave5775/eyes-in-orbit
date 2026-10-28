import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { centredScrollTop, scrollTopToReveal } from '../lib/entity-tree';

interface Props {
  count: number;
  rowHeight: number;
  overscan?: number;
  render(index: number): ReactNode;
  /**
   * Sticky rows: the indices of the rows to pin at the top while row `first` is the first one in view (outermost first). They
   * are drawn with `render` over the top of the list, each at the row height, so a pinned row behaves like its own row.
   */
  sticky?(first: number): readonly number[];
}

export interface VirtualListHandle {
  /** scroll so row `index` is visible (not under the sticky rows): no movement when it already is, else it is centred */
  reveal(index: number): void;
}

/** The sticky rows never take more than this share of the viewport (the nearest ancestors win when there are too many). */
const MAX_PIN_SHARE = 0.5;

/**
 * Fixed-row-height windowed list: only the visible rows are in the DOM. Scrolling is read at most once per animation frame, and
 * the list re-renders only when the first row in view changes (the window and the sticky rows depend on nothing finer).
 */
export const VirtualList = forwardRef<VirtualListHandle, Props>(function VirtualList({ count, rowHeight, overscan = 8, render, sticky }, handle) {
  const ref = useRef<HTMLDivElement>(null);
  /** the first row in view: floor(scrollTop / rowHeight) */
  const [firstInView, setFirstInView] = useState(0);
  const [height, setHeight] = useState(400);
  const frame = useRef(0);

  useEffect(() => {
    const el = ref.current!;
    setHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, []);

  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = ref.current;
      if (el) setFirstInView(Math.floor(el.scrollTop / rowHeight));
    });
  }, [rowHeight]);

  /** the rows pinned while row `first` is the first in view, capped to a share of the viewport */
  const pinsFor = useCallback((first: number, viewHeight: number): readonly number[] => {
    if (!sticky) return [];
    const all = sticky(first);
    const max = Math.max(0, Math.floor((viewHeight * MAX_PIN_SHARE) / rowHeight));
    return all.length > max ? all.slice(all.length - max) : all;
  }, [sticky, rowHeight]);

  useImperativeHandle(handle, () => ({
    reveal(index) {
      const el = ref.current;
      if (!el) return;
      const view = el.clientHeight;
      const pinnedAt = (scrollTop: number) => pinsFor(Math.floor(scrollTop / rowHeight), view).length * rowHeight;
      let to = scrollTopToReveal(index, rowHeight, el.scrollTop, view, count, pinnedAt(el.scrollTop));
      if (to === null) return;
      // the sticky rows at the new position can be fewer or more than now: centre below the ones that will be there
      for (let i = 0; i < 3; i++) {
        const next = centredScrollTop(index, rowHeight, view, count, pinnedAt(to));
        if (next === to) break;
        to = next;
      }
      el.scrollTop = to;
    },
  }), [rowHeight, count, pinsFor]);

  const first = Math.max(0, firstInView - overscan);
  const last = Math.min(count, firstInView + Math.ceil(height / rowHeight) + 1 + overscan);
  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) rows.push(render(i));
  const pins = firstInView < count ? pinsFor(firstInView, height) : [];

  return (
    <div ref={ref} className="vlist" onScroll={onScroll}>
      {pins.length > 0 && (
        <div className="vlist-pins" style={{ height: 0 }}>
          {pins.map((i, k) => (
            <div key={i} className={k === pins.length - 1 ? 'vlist-pin last' : 'vlist-pin'} style={{ top: k * rowHeight, height: rowHeight }}>
              {render(i)}
            </div>
          ))}
        </div>
      )}
      <div style={{ height: count * rowHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: first * rowHeight, left: 0, right: 0 }}>{rows}</div>
      </div>
    </div>
  );
});
