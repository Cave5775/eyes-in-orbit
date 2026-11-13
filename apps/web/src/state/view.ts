import { create } from 'zustand';

/**
 * Scene display settings that the View menu (top bar), the scene's camera toolbar and the hotkeys share. `SceneView` subscribes
 * and pushes each change to the SceneController; nothing here touches the scene directly.
 * Labels and close-up detail are remembered per browser under the keys the scene used before (`eio.labels`, `eio.detail`, value
 * 'on' / 'off', anything else = on). Scope resets to auto on reload. `surface` mirrors the controller (which owns and saves it).
 */
export interface ViewState {
  labels: boolean;
  detail: boolean;
  scopeAll: boolean;
  surface: boolean;
  /** id of the observatory the camera stands at (first-person view), else null; mirrors the controller */
  firstPerson: string | null;
  help: boolean;
  toggleLabels(): void;
  toggleDetail(): void;
  toggleScope(): void;
  setSurface(on: boolean): void;
  setFirstPerson(id: string | null): void;
  setHelp(on: boolean): void;
  toggleHelp(): void;
}

export const LABELS_KEY = 'eio.labels';
export const DETAIL_KEY = 'eio.detail';

/** Minimal slice of the Web Storage interface. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** A remembered on/off flag that defaults to on: only the stored text 'off' turns it off; blocked storage reads as on. */
export function loadFlag(key: string, storage: StorageLike | null | undefined = defaultStorage()): boolean {
  try {
    return storage?.getItem(key) !== 'off';
  } catch {
    return true;
  }
}

export function saveFlag(key: string, on: boolean, storage: StorageLike | null | undefined = defaultStorage()): void {
  try {
    storage?.setItem(key, on ? 'on' : 'off');
  } catch { /* private window: the choice just is not remembered */ }
}

export function createViewStore(storage: StorageLike | null | undefined = defaultStorage()) {
  return create<ViewState>((set, get) => ({
    labels: loadFlag(LABELS_KEY, storage),
    detail: loadFlag(DETAIL_KEY, storage),
    scopeAll: false,
    surface: false,
    firstPerson: null,
    help: false,
    toggleLabels: () => {
      const labels = !get().labels;
      saveFlag(LABELS_KEY, labels, storage);
      set({ labels });
    },
    toggleDetail: () => {
      const detail = !get().detail;
      saveFlag(DETAIL_KEY, detail, storage);
      set({ detail });
    },
    toggleScope: () => set({ scopeAll: !get().scopeAll }),
    setSurface: (surface) => { if (get().surface !== surface) set({ surface }); },
    setFirstPerson: (firstPerson) => { if (get().firstPerson !== firstPerson) set({ firstPerson }); },
    setHelp: (help) => { if (get().help !== help) set({ help }); },
    toggleHelp: () => set({ help: !get().help }),
  }));
}

export const useView = createViewStore();
