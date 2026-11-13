import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { FLOAT_HEAD_PX, totalHeight, dragMiniRect, dragRect, resizeRect, shownRect, viewportNow, type FloatRect, type FloatWindow, type Viewport } from '../lib/floating';
import { useStore } from '../state/store';
import { SkyView } from './SkyView';
import { StreamFrame } from './StreamFrame';

/**
 * Pop-out stream windows, drawn above the app (fixed, outside the grid). Each window is keyed by its embed URL,
 * so reordering or restacking never remounts a player. Windows are clamped to the viewport on every render.
 */
export function FloatingLayer() {
  const floats = useStore((s) => s.floats);
  const [vp, setVp] = useState<Viewport>(viewportNow);

  useEffect(() => {
    const onResize = () => setVp(viewportNow());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const sky = useStore((s) => s.sky);
  const focusSky = useStore((s) => s.focusSky);
  const setSkyRect = useStore((s) => s.setSkyRect);
  const closeSky = useStore((s) => s.closeSky);
  const focusFloat = useStore((s) => s.focusFloat);
  const setFloatRect = useStore((s) => s.setFloatRect);
  const closeFloat = useStore((s) => s.closeFloat);
  const minFloat = useStore((s) => s.toggleFloatMinimized);
  const minSky = useStore((s) => s.toggleSkyMinimized);

  if (floats.length === 0 && !sky) return null;
  return (
    <div className="float-layer">
      {floats.map((f) => (
        <FloatingWindow key={f.url} win={f} vp={vp} focus={focusFloat} setRect={setFloatRect} close={closeFloat} toggleMin={minFloat}>
          <StreamFrame url={f.url} className="float-frame" />
        </FloatingWindow>
      ))}
      {/* the Sky view shares the window cap and the chrome; it is not a stream and is not remembered across reloads */}
      {sky && (
        <FloatingWindow key={sky.url} win={sky} vp={vp} focus={focusSky} setRect={(_id, r) => setSkyRect(r)} close={closeSky} toggleMin={minSky}>
          <SkyView obsId={sky.obsId} />
        </FloatingWindow>
      )}
    </div>
  );
}

type Mode = 'move' | 'resize';

interface WindowProps {
  win: FloatWindow;
  vp: Viewport;
  focus(id: string): void;
  setRect(id: string, rect: { x: number; y: number; w: number }): void;
  close(id: string): void;
  toggleMin(id: string): void;
  children: ReactNode;
}

function FloatingWindow({ win, vp, focus, setRect, close, toggleMin, children }: WindowProps) {
  const mini = !!win.minimized;
  const rect: FloatRect = shownRect(win, vp);
  const bodyRef = useRef<HTMLDivElement>(null);
  // a minimized window stays mounted (the stream keeps playing) but its clipped body takes no focus or clicks
  useEffect(() => {
    if (mini) bodyRef.current?.setAttribute('inert', '');
    else bodyRef.current?.removeAttribute('inert');
  }, [mini]);
  const drag = useRef<{ px: number; py: number; start: FloatRect; mode: Mode } | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);

  // while a drag runs, iframes and the WebGL canvas must not take pointer events (set on body, see styles.css)
  useEffect(() => {
    if (!mode) return;
    const cls = mode === 'move' ? 'floating-move' : 'floating-resize';
    document.body.classList.add('floating-busy', cls);
    return () => document.body.classList.remove('floating-busy', cls);
  }, [mode]);

  // the gesture is followed by listeners on the window, not by pointer capture alone: whatever is under the pointer (the Sky view's
  // canvas and bar, an iframe) cannot swallow the moves, and a browser that does not retarget to the captured element still works
  const live = useRef({ vp, setRect });
  live.current = { vp, setRect };
  const miniDrag = useRef(mini);
  miniDrag.current = mini;
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const begin = (e: PointerEvent<HTMLElement>, next: Mode) => {
    if (e.button !== 0) return;
    e.preventDefault();
    stop.current?.();
    const el = e.currentTarget;
    const pointerId = e.pointerId;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // the window listeners below carry the gesture
    }
    drag.current = { px: e.clientX, py: e.clientY, start: mini ? { ...rect, w: win.w } : rect, mode: next };
    focus(win.url);
    setMode(next);
    const track = (m: globalThis.PointerEvent) => {
      const d = drag.current;
      if (!d || m.pointerId !== pointerId) return;
      const dx = m.clientX - d.px;
      const dy = m.clientY - d.py;
      const v = live.current.vp;
      // a tab only moves; the store keeps the full width for the restore
      const to = d.mode === 'resize' ? resizeRect(d.start, dx, dy, v) : miniDrag.current ? { ...dragMiniRect(d.start, dx, dy, v), w: d.start.w } : dragRect(d.start, dx, dy, v);
      live.current.setRect(win.url, to);
    };
    const end = (m: globalThis.PointerEvent) => {
      if (m.pointerId !== pointerId) return;
      stop.current?.();
    };
    stop.current = () => {
      window.removeEventListener('pointermove', track);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      stop.current = null;
      drag.current = null;
      setMode(null);
      try {
        if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
      } catch {
        // already released
      }
    };
    window.addEventListener('pointermove', track);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const onHeadDown = (e: PointerEvent<HTMLElement>) => {
    // the buttons in the title bar keep their own clicks
    if ((e.target as HTMLElement).closest('button')) return;
    begin(e, 'move');
  };

  return (
    <div
      className={`float-win${mode ? ' busy' : ''}${mini ? ' mini' : ''}`}
      data-float-url={win.url}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: win.z }}
      onPointerDown={() => focus(win.url)}
    >
      <div
        className="float-head"
        onPointerDown={onHeadDown}
        title="Drag to move"
      >
        <span className="float-title" title={win.title}>{win.title}</span>
        <button
          className="float-btn"
          onClick={() => toggleMin(win.url)}
          title={mini ? 'Restore this window' : 'Minimize this window'}
          aria-label={mini ? 'Restore this window' : 'Minimize this window'}
        >{mini ? '□' : '–'}</button>
        <button className="float-btn" onClick={() => close(win.url)} title="Close this window" aria-label="Close this window">&times;</button>
      </div>
      {/* minimized: the window is clipped to the title bar but the body keeps its full size, so the player is never unmounted, hidden with display:none or resized */}
      <div
        ref={bodyRef}
        className="float-body"
        aria-hidden={mini || undefined}
        style={mini ? { flex: 'none', width: win.w, height: totalHeight(win.w) - FLOAT_HEAD_PX } : undefined}
      >
        {children}
      </div>
      {!mini && (
        <div
          className="float-grip"
          onPointerDown={(e) => begin(e, 'resize')}
          title="Drag to resize (keeps 16:9)"
          aria-label="Resize window"
        />
      )}
    </div>
  );
}
