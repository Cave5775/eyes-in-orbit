import { useEffect } from 'react';
import { usePanels } from './state/panels';
import { useStore } from './state/store';
import { DetailPanel } from './ui/DetailPanel';
import { DsnPanel } from './ui/DsnPanel';
import { EntityBrowser } from './ui/EntityBrowser';
import { FloatingLayer } from './ui/FloatingLayer';
import { LaunchBoard } from './ui/LaunchBoard';
import { NewsTicker } from './ui/NewsTicker';
import { ResizableLayout } from './ui/ResizableLayout';
import { SceneView } from './ui/SceneView';
import { TopBar } from './ui/TopBar';

export function App() {
  const panels = usePanels((s) => s.visible);

  // Esc: drop selection and return to the Earth view (ignored while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Escape' && !(t instanceof HTMLInputElement && t.type === 'search' && t.value)) useStore.getState().resetView();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <ResizableLayout>
        <TopBar />
        <EntityBrowser />
        <SceneView />
        <DetailPanel />
        {/* the bottom row exists only while the launch board or the DSN panel is shown (PANELS menu) */}
        {(panels.board || panels.dsn) && (
          <div className={panels.board && panels.dsn ? 'bottom' : 'bottom solo'}>
            {panels.board && <LaunchBoard />}
            {panels.dsn && <DsnPanel />}
          </div>
        )}
        {panels.ticker && <NewsTicker />}
      </ResizableLayout>
      {/* outside the grid: floating stream windows sit above the whole app */}
      <FloatingLayer />
    </>
  );
}
