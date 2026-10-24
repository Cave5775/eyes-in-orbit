import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { scrollTopToReveal } from '../lib/entity-tree';

interface Props {
  count: number;
  rowHeight: number;
  overscan?: number;
  render(index: number): ReactNode;
}

export interface VirtualListHandle {
  /** scroll so row `index` is visible: no movement when it already is, else it is centred */
  reveal(index: number): void;
}

/** Fixed-row-height windowed list: only the visible rows are in the DOM. */
export const VirtualList = forwardRef<VirtualListHandle, Props>(function VirtualList({ count, rowHeight, overscan = 8, render }, handle) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(400);

  useEffect(() => {
    const el = ref.current!;
    setHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useImperativeHandle(handle, () => ({
    reveal(index) {
      const el = ref.current;
      if (!el) return;
      const to = scrollTopToReveal(index, rowHeight, el.scrollTop, el.clientHeight, count);
      if (to !== null) el.scrollTop = to;
    },
  }), [rowHeight, count]);

  const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((top + height) / rowHeight) + overscan);
  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) rows.push(render(i));

  return (
    <div ref={ref} className="vlist" onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
      <div style={{ height: count * rowHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: first * rowHeight, left: 0, right: 0 }}>{rows}</div>
      </div>
    </div>
  );
});
