import { useCallback, useRef, useState, type RefObject } from 'react';
import { DEV_OPTIONS, atDevDefaults } from '../lib/dev-options';
import { useDevOptions } from '../state/dev-options';
import { useDismiss } from './hooks';

/**
 * The top bar's EyesInOrbit icon: its inner circle is a button that opens the "Developer options" popout. Nothing marks it at rest
 * (only the pointer cursor on hover and the focus ring); Esc and an outside click close it. The options come from `lib/dev-options.ts`.
 */
export function BrandIcon() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<SVGGElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, root, close, button as unknown as RefObject<HTMLElement>);

  return (
    <div className="menu-anchor brand-icon" ref={root}>
      <svg width="18" height="18" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true" />
        <g
          ref={button} className="dev-hit" role="button" tabIndex={0} aria-label="Developer options" aria-expanded={open} aria-haspopup="dialog"
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); } }}>
          <circle cx="8" cy="8" r="3.6" fill="transparent" />
          <circle cx="8" cy="8" r="2" fill="currentColor" />
        </g>
      </svg>
      {open && <Panel />}
    </div>
  );
}

function Panel() {
  const values = useDevOptions((s) => s.values);
  const { set, reset } = useDevOptions.getState();
  return (
    <div className="popover menu-pop dev-pop" role="dialog" aria-label="Developer options">
      <fieldset className="menu-group">
        <legend>Developer options</legend>
        {DEV_OPTIONS.length === 0 && <div className="menu-note">No options yet.</div>}
        {DEV_OPTIONS.map((d) => d.type === 'toggle' ? (
          <label key={d.id} className="menu-row" title={d.hint}>
            <input type="checkbox" className="switch" checked={values[d.id] === true} onChange={(e) => set(d.id, e.target.checked)} />
            <span className="menu-name">{d.label}</span>
            {d.hint && <span className="menu-hint">{d.hint}</span>}
          </label>
        ) : (
          <label key={d.id} className="menu-row" title={d.hint}>
            <input
              type="number" className="dev-input" min={d.min} max={d.max} step={d.step} value={Number(values[d.id])}
              onChange={(e) => { if (e.target.value !== '') set(d.id, e.target.value); }} />
            <span className="menu-name">{d.label}{d.unit ? ` (${d.unit})` : ''}</span>
            {d.hint && <span className="menu-hint">{d.hint}</span>}
          </label>
        ))}
      </fieldset>
      <div className="settings-foot">
        <button className="key" disabled={atDevDefaults(values)} onClick={reset}>Reset to defaults</button>
      </div>
    </div>
  );
}
