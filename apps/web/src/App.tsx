import { useEffect } from 'react';
import { usePanels } from './state/panels';
import { runtime } from './state/runtime';
import { useStore } from './state/store';
import { useView } from './state/view';
import { DetailPanel } from './ui/DetailPanel';
import { EntityBrowser } from './ui/EntityBrowser';
import { FloatingLayer } from './ui/FloatingLayer';
import { LaunchBoard } from './ui/LaunchBoard';
import { PerfOverlay } from './ui/PerfOverlay';
import { NewsTicker } from './ui/NewsTicker';
import { ObservatoryPanel } from './ui/ObservatoryPanel';
import { ResizableLayout } from './ui/ResizableLayout';
import { SceneView } from './ui/SceneView';
import { TopBar } from './ui/TopBar';

export function App() {
  const panels = usePanels((s) => s.visible);

  // Esc: drop selection and return to the Earth view (ignored while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Escape' && !(t instanceof HTMLInputElement && t.type === 'search' && t.value)) {
        // first-person: the first Esc only steps back out of it (the selection stays); the next one is the usual reset
        if (runtime.camera && useView.getState().firstPerson) runtime.camera.leaveFirstPerson();
        else useStore.getState().resetView();
      }
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
        {/* the bottom row exists only while the launch board or the observatory panel is shown (View menu) */}
        {(panels.board || panels.observatories) && (
          <div className={panels.board && panels.observatories ? 'bottom two' : 'bottom'}>
            {panels.board && <LaunchBoard />}
            {panels.observatories && <ObservatoryPanel />}
          </div>
        )}
        {panels.ticker && <NewsTicker />}
      </ResizableLayout>
      {/* outside the grid: floating stream windows sit above the whole app */}
      <FloatingLayer />
      <PerfOverlay />
    </>
  );
}
