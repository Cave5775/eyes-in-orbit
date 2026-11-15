import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { PANELS, maxSize, resolveSizes, type PanelKey } from '../lib/layout';
import { useLayout } from '../state/layout';
import { usePanels } from '../state/panels';
import { Splitter } from './Splitter';

function viewport() {
  return { w: window.innerWidth, h: window.innerHeight };
}

/**
 * The app grid root. Panel sizes are CSS variables on this element (`--left-w`, `--right-w`,
 * `--bottom-h`) so the grid template and the splitter positions both follow them.
 * `children` is passed through unchanged, so resizing re-renders only this component. Sizes come from state/layout.ts.
 */
export function ResizableLayout({ children }: { children: ReactNode }) {
  const stored = useLayout((s) => s.stored);
  const [vp, setVp] = useState(viewport);

  useEffect(() => {
    const onResize = () => setVp(viewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const sizes = useMemo(() => resolveSizes(stored, vp), [stored, vp]);

  const set = (key: PanelKey, px: number) => useLayout.getState().setSize(key, px, viewport());
  const reset = (key: PanelKey) => useLayout.getState().resetSize(key);

  // hidden panels (PANELS menu) give their space back; the stored sizes are untouched, so showing one restores it
  const shown = usePanels((s) => s.visible);
  const bottomShown = shown.board || shown.observatories;
  const style = {
    '--left-w': `${sizes.left}px`,
    '--right-w': `${sizes.right}px`,
    '--bottom-h': bottomShown ? `${sizes.bottom}px` : '0px',
    '--obs-w': `${sizes.obs}px`,
    '--ticker-h': shown.ticker ? '26px' : '0px',
  } as CSSProperties;

  const sp = (key: PanelKey, extra: { orientation: 'vertical' | 'horizontal'; grow: 1 | -1; label: string; className: string }) => (
    <Splitter
      {...extra}
      value={sizes[key]}
      min={PANELS[key].min}
      max={maxSize(key, sizes, vp)}
      onChange={(px) => set(key, px)}
      onReset={() => reset(key)}
    />
  );

  return (
    <div className="app" style={style}>
      {children}
      {sp('left', { orientation: 'vertical', grow: 1, label: 'Resize entity list', className: 'sp-left' })}
      {sp('right', { orientation: 'vertical', grow: -1, label: 'Resize detail panel', className: 'sp-right' })}
      {shown.board && shown.observatories && sp('obs', { orientation: 'vertical', grow: -1, label: 'Resize observatory panel', className: 'sp-obs' })}
      {bottomShown && sp('bottom', { orientation: 'horizontal', grow: -1, label: 'Resize bottom panels', className: 'sp-bottom' })}
    </div>
  );
}
