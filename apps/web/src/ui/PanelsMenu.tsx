import { useEffect, useRef, useState } from 'react';
import { PANEL_IDS, PANEL_INFO, usePanels } from '../state/panels';

/**
 * Top bar menu that shows and hides the optional panels (DSN, launch board, news ticker). The state lives in
 * `state/panels.ts` and is remembered per browser. Closes on an outside click and on Esc.
 */
export function PanelsMenu() {
  const [open, setOpen] = useState(false);
  const visible = usePanels((s) => s.visible);
  const toggle = usePanels((s) => s.togglePanel);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node | null)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation(); // the app-wide Esc (back to the Earth view) must not also fire
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    // capture phase: runs before the window-level Esc handler in App.tsx
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className="health panels-menu" ref={root}>
      <button
        ref={button} className={open ? 'btn health-btn panels-btn active' : 'btn health-btn panels-btn'} onClick={() => setOpen((o) => !o)}
        aria-expanded={open} aria-haspopup="true" aria-label="Panels menu: show or hide panels" title="Panels: show or hide the DSN panel, launch board and news ticker">
        <svg className="panels-icon" width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
          <path d="M1 1.5h12M1 6h12M1 10.5h12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <span className="panels-text">PANELS</span>
      </button>
      {open && (
        <div className="popover panels-pop" role="group" aria-label="Panels">
          <div className="pop-title">PANELS</div>
          {PANEL_IDS.map((id) => (
            <label key={id} className="panels-row">
              <input type="checkbox" checked={visible[id]} onChange={() => toggle(id)} />
              <span className="panels-name">{PANEL_INFO[id].label}</span>
              <span className="panels-hint dim">{PANEL_INFO[id].hint}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
