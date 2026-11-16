import { useEffect, useRef, useState, type HTMLAttributes, type PointerEvent, type ReactNode } from 'react';
import { ZOOM_RESET, isZoomed, panBy, wheelZoomFactor, zoomAt, type ZoomView } from '../lib/zoom-pan';

/**
 * The player box (the `.stream-player` element) with wheel zoom about the cursor and drag to pan. The box keeps its
 * size; the frame (`children`: an iframe or a video) is scaled inside it and clipped. A cross-origin iframe swallows
 * wheel and pointer events, so a transparent capture layer lies over the frame: at 1x it takes the wheel only where
 * `clearBottom` allows (YouTube's own control bar keeps the bottom strip of the box, so its buttons stay usable), and
 * while zoomed it covers the whole box so a drag pans. `overlay` (our strip, cover, buttons) is drawn above it.
 * Zoom lives in this component's state: a new stream remounts it (callers key it by URL), so it resets to 1x.
 * The maths is in `lib/zoom-pan.ts`.
 */
export function ZoomBox({ className, boxProps, children, overlay, clearBottom = false }: {
  className: string;
  boxProps?: HTMLAttributes<HTMLDivElement>;
  children: ReactNode;
  overlay?: ReactNode;
  /** leave the bottom of the picture to the frame's own controls while not zoomed */
  clearBottom?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ZoomView>(ZOOM_RESET);
  const viewRef = useRef(view);
  viewRef.current = view;
  const update = (v: ZoomView) => {
    viewRef.current = v;
    setView(v);
  };
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const zoomed = isZoomed(view);

  // non-passive, so preventDefault keeps the page from scrolling and the globe from zooming
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      update(zoomAt(viewRef.current, wheelZoomFactor(e.deltaY), e.clientX - r.left, e.clientY - r.top, r.width, r.height));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    boxProps?.onPointerDown?.(e);
    if (!isZoomed(viewRef.current) || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // the moves still arrive while the pointer stays over the box
    }
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const r = e.currentTarget.getBoundingClientRect();
    update(panBy(viewRef.current, e.clientX - d.x, e.clientY - d.y, r.width, r.height));
    d.x = e.clientX;
    d.y = e.clientY;
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };

  return (
    <div
      {...boxProps}
      ref={box}
      className={`${className}${zoomed ? ' zoomed' : ''}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => update(ZOOM_RESET)}
    >
      <div className="stream-zoom" style={zoomed ? { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` } : undefined}>
        {children}
      </div>
      <div className={`stream-zoomcap${clearBottom && !zoomed ? ' clear-bottom' : ''}`} />
      {overlay}
      {zoomed && (
        <button className="btn stream-zoom-reset" onClick={() => update(ZOOM_RESET)} title="Back to 1x (also: double-click)">
          {view.scale.toFixed(1)}x reset
        </button>
      )}
    </div>
  );
}
