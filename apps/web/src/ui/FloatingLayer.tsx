import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { dragRect, fitRect, resizeRect, viewportNow, type FloatRect, type FloatWindow, type Viewport } from '../lib/floating';
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

  if (floats.length === 0 && !sky) return null;
  return (
    <div className="float-layer">
      {floats.map((f) => (
        <FloatingWindow key={f.url} win={f} vp={vp} focus={focusFloat} setRect={setFloatRect} close={closeFloat}>
          <StreamFrame url={f.url} className="float-frame" />
        </FloatingWindow>
      ))}
      {/* the Sky view shares the window cap and the chrome; it is not a stream and is not remembered across reloads */}
      {sky && (
        <FloatingWindow key={sky.url} win={sky} vp={vp} focus={focusSky} setRect={(_id, r) => setSkyRect(r)} close={closeSky}>
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
  children: ReactNode;
}

function FloatingWindow({ win, vp, focus, setRect, close, children }: WindowProps) {
  const rect: FloatRect = fitRect(win, vp);
  const drag = useRef<{ px: number; py: number; start: FloatRect; mode: Mode } | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);

  // while a drag runs, iframes and the WebGL canvas must not take pointer events (set on body, see styles.css)
  useEffect(() => {
    if (!mode) return;
    const cls = mode === 'move' ? 'floating-move' : 'floating-resize';
    document.body.classList.add('floating-busy', cls);
    return () => document.body.classList.remove('floating-busy', cls);
  }, [mode]);

  const begin = (e: PointerEvent<HTMLElement>, next: Mode) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, start: rect, mode: next };
    focus(win.url);
    setMode(next);
  };
  const track = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    const next = d.mode === 'move' ? dragRect(d.start, dx, dy, vp) : resizeRect(d.start, dx, dy, vp);
    setRect(win.url, next);
  };
  const end = (e: PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setMode(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onHeadDown = (e: PointerEvent<HTMLElement>) => {
    // the buttons in the title bar keep their own clicks
    if ((e.target as HTMLElement).closest('button')) return;
    begin(e, 'move');
  };

  return (
    <div
      className={mode ? 'float-win busy' : 'float-win'}
      data-float-url={win.url}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: win.z }}
      onPointerDown={() => focus(win.url)}
    >
      <div
        className="float-head"
        onPointerDown={onHeadDown}
        onPointerMove={track}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        title="Drag to move"
      >
        <span className="float-title" title={win.title}>{win.title}</span>
        <button className="float-btn" onClick={() => close(win.url)} title="Close this window" aria-label="Close this window">&times;</button>
      </div>
      <div className="float-body">
        {children}
      </div>
      <div
        className="float-grip"
        onPointerDown={(e) => begin(e, 'resize')}
        onPointerMove={track}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        title="Drag to resize (keeps 16:9)"
        aria-label="Resize window"
      />
    </div>
  );
}
