import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { PANEL_INFO, usePanels, type PanelId } from '../state/panels';
import { useStore } from '../state/store';
import { useView } from '../state/view';
import { useDismiss } from './hooks';
import { MinorPlanetsControl } from './MinorPlanetsControl';

/** Optional panels the menu lists under "Panels" (the colour legend is a scene setting, listed under "Scene"). */
const PANEL_ROWS: readonly PanelId[] = ['board', 'observatories', 'ticker'];

interface Row { key: string; label: string; hint: string; on: boolean; toggle(): void; extra?: ReactNode }

/**
 * Top bar "View" menu: the quick show / hide toggles. "Scene" holds the display toggles (labels, highlight, scope, colour legend);
 * "Panels" shows and hides the optional panels. Set-and-forget choices live in Settings (SettingsMenu.tsx). Each choice is
 * remembered where it was before (state/view.ts, state/store.ts highlight, state/panels.ts). Closes on an outside click and on Esc.
 */
export function ViewMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const visible = usePanels((s) => s.visible);
  const togglePanel = usePanels((s) => s.togglePanel);
  const view = useView();
  const highlight = useStore((s) => s.highlight);
  const setHighlight = useStore((s) => s.setHighlight);

  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, root, close, button);
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
  }, [open]);

  const scene: Row[] = [
    { key: 'labels', label: 'Labels', hint: 'Names of bodies, the selection and search matches', on: view.labels, toggle: view.toggleLabels },
    { key: 'sunShading', label: 'Sunlight shading', hint: 'Off: light every body and model evenly, so the side away from the Sun shows its texture', on: view.sunShading, toggle: view.toggleSunShading },
    { key: 'minorPlanets', label: 'Minor planets', hint: 'About 1.4 million asteroids as points (Minor Planet Center, approximate orbits); turning it on downloads about 70 MB once', on: view.minorPlanets, toggle: view.toggleMinorPlanets, extra: <MinorPlanetsControl /> },
    { key: 'highlight', label: 'Highlight', hint: 'Dim what the search leaves out instead of hiding it', on: highlight, toggle: () => setHighlight(!highlight) },
    { key: 'scope', label: 'Draw everything', hint: 'Off: only what is near the camera focus, the selection and search matches', on: view.scopeAll, toggle: view.toggleScope },
    { key: 'legend', label: PANEL_INFO.legend.label, hint: PANEL_INFO.legend.hint, on: visible.legend, toggle: () => togglePanel('legend') },
  ];
  const panels: Row[] = PANEL_ROWS.map((id) => ({ key: id, label: PANEL_INFO[id].label, hint: PANEL_INFO[id].hint, on: visible[id], toggle: () => togglePanel(id) }));

  const group = (title: string, rows: Row[]) => (
    <fieldset className="menu-group">
      <legend>{title}</legend>
      {rows.map((r) => (
        <Fragment key={r.key}>
          <label className="menu-row">
            <input type="checkbox" className="switch" checked={r.on} onChange={r.toggle} />
            <span className="menu-name">{r.label}</span>
            <span className="menu-hint">{r.hint}</span>
          </label>
          {r.extra}
        </Fragment>
      ))}
    </fieldset>
  );

  return (
    <div className="menu-anchor" ref={root}>
      <button
        ref={button} className={open ? 'key on' : 'key'} onClick={() => setOpen((o) => !o)}
        aria-expanded={open} aria-haspopup="true" title="What the scene shows, and which panels are open">
        View
        <svg className="caret" width="8" height="5" viewBox="0 0 8 5" aria-hidden="true"><path d="M.5.5 4 4 7.5.5" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
      </button>
      {open && (
        <div className="popover menu-pop" role="group" aria-label="View">
          {group('Scene', scene)}
          {group('Panels', panels)}
        </div>
      )}
    </div>
  );
}
