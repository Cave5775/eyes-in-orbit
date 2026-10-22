import { useEffect } from 'react';
import { useStore } from './state/store';
import { DetailPanel } from './ui/DetailPanel';
import { DsnPanel } from './ui/DsnPanel';
import { EntityBrowser } from './ui/EntityBrowser';
import { LaunchBoard } from './ui/LaunchBoard';
import { NewsTicker } from './ui/NewsTicker';
import { SceneView } from './ui/SceneView';
import { TopBar } from './ui/TopBar';

export function App() {
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
    <div className="app">
      <TopBar />
      <EntityBrowser />
      <SceneView />
      <DetailPanel />
      <div className="bottom">
        <LaunchBoard />
        <DsnPanel />
      </div>
      <NewsTicker />
    </div>
  );
}
