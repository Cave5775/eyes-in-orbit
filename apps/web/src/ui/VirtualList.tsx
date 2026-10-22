import { useEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
  count: number;
  rowHeight: number;
  overscan?: number;
  render(index: number): ReactNode;
}

/** Fixed-row-height windowed list: only the visible rows are in the DOM. */
export function VirtualList({ count, rowHeight, overscan = 8, render }: Props) {
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
}
