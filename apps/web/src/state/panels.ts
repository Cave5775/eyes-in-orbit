import { create } from 'zustand';

/** Panels the PANELS menu can show and hide. */
export type PanelId = 'board' | 'ticker' | 'legend';
export type PanelVisibility = Record<PanelId, boolean>;

export const PANEL_IDS: readonly PanelId[] = ['board', 'ticker', 'legend'];

/** What the menu shows for each panel (label, one-line hint). */
export const PANEL_INFO: Record<PanelId, { label: string; hint: string }> = {
  board: { label: 'Launches', hint: 'Upcoming launches with countdowns' },
  ticker: { label: 'News ticker', hint: 'Scrolling spaceflight headlines' },
  legend: { label: 'Colour legend', hint: 'Category colours, bottom left of the scene' },
};

/** All panels start shown. (Older stored state may carry a `dsn` key: the DSN moved to the Data streams popup, and unknown keys are dropped.) */
export const DEFAULT_PANELS: PanelVisibility = { board: true, ticker: true, legend: true };

export const PANELS_STORAGE_KEY = 'eio.panels.v1';

/** Minimal slice of the Web Storage interface. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Parse the stored state; anything missing, unknown or not a boolean takes its default. */
export function parsePanels(raw: string | null | undefined): PanelVisibility {
  const out = { ...DEFAULT_PANELS };
  if (!raw) return out;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const id of PANEL_IDS) {
    const v = (obj as Record<string, unknown>)[id];
    if (typeof v === 'boolean') out[id] = v;
  }
  return out;
}

export function serialisePanels(state: PanelVisibility): string {
  const out: Partial<PanelVisibility> = {};
  for (const id of PANEL_IDS) out[id] = !!state[id];
  return JSON.stringify(out);
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadPanels(storage: StorageLike | null | undefined = defaultStorage()): PanelVisibility {
  try {
    return parsePanels(storage?.getItem(PANELS_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_PANELS };
  }
}

export function savePanels(state: PanelVisibility, storage: StorageLike | null | undefined = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(PANELS_STORAGE_KEY, serialisePanels(state));
    return true;
  } catch {
    return false;
  }
}

interface PanelsState {
  visible: PanelVisibility;
  setPanel(id: PanelId, on: boolean): void;
  togglePanel(id: PanelId): void;
}

/** Panel visibility, remembered in this browser. Call `setPanel('board', true)` to open a panel from code. */
export const usePanels = create<PanelsState>((set, get) => {
  const apply = (visible: PanelVisibility) => {
    set({ visible });
    savePanels(visible);
  };
  return {
    visible: loadPanels(),
    setPanel: (id, on) => {
      const cur = get().visible;
      if (cur[id] !== on) apply({ ...cur, [id]: on });
    },
    togglePanel: (id) => apply({ ...get().visible, [id]: !get().visible[id] }),
  };
});
