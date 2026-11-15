import { create } from 'zustand';
import { clampSize, loadSizes, resolveSizes, saveSizes, type PanelKey, type PanelSizes, type Viewport } from '../lib/layout';

/** Dragged panel sizes, remembered in this browser. A panel missing from `stored` takes its default size. */
interface LayoutState {
  stored: PanelSizes;
  setSize(key: PanelKey, px: number, vp: Viewport): void;
  resetSize(key: PanelKey): void;
  resetAll(): void;
}

export const useLayout = create<LayoutState>((set, get) => {
  const apply = (stored: PanelSizes) => {
    if (stored === get().stored) return;
    set({ stored });
    saveSizes(stored);
  };
  return {
    stored: loadSizes(),
    setSize: (key, px, vp) => {
      const prev = get().stored;
      const next = clampSize(key, px, resolveSizes(prev, vp), vp);
      if (prev[key] !== next) apply({ ...prev, [key]: next });
    },
    resetSize: (key) => {
      const prev = get().stored;
      if (prev[key] === undefined) return;
      const { [key]: _drop, ...rest } = prev;
      apply(rest);
    },
    resetAll: () => { if (Object.keys(get().stored).length > 0) apply({}); },
  };
});
