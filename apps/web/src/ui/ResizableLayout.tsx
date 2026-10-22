import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { PANELS, clampSize, loadSizes, maxSize, resolveSizes, saveSizes, type PanelKey, type PanelSizes } from '../lib/layout';
import { Splitter } from './Splitter';

function viewport() {
  return { w: window.innerWidth, h: window.innerHeight };
}

/**
 * The app grid root. Panel sizes are CSS variables on this element (`--left-w`, `--right-w`,
 * `--bottom-h`, `--dsn-w`) so the grid template and the splitter positions both follow them.
 * `children` is passed through unchanged, so resizing re-renders only this component.
 */
export function ResizableLayout({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<PanelSizes>(() => loadSizes());
  const [vp, setVp] = useState(viewport);

  useEffect(() => {
    const onResize = () => setVp(viewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    saveSizes(stored);
  }, [stored]);

  const sizes = useMemo(() => resolveSizes(stored, vp), [stored, vp]);

  const set = useCallback((key: PanelKey, px: number) => {
    setStored((prev) => {
      const effective = resolveSizes(prev, viewport());
      const next = clampSize(key, px, effective, viewport());
      return prev[key] === next ? prev : { ...prev, [key]: next };
    });
  }, []);
  const reset = useCallback((key: PanelKey) => {
    setStored((prev) => {
      if (prev[key] === undefined) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  const style = {
    '--left-w': `${sizes.left}px`,
    '--right-w': `${sizes.right}px`,
    '--bottom-h': `${sizes.bottom}px`,
    '--dsn-w': `${sizes.dsn}px`,
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
      {sp('bottom', { orientation: 'horizontal', grow: -1, label: 'Resize bottom panels', className: 'sp-bottom' })}
      {sp('dsn', { orientation: 'vertical', grow: -1, label: 'Resize DSN panel', className: 'sp-dsn' })}
    </div>
  );
}
