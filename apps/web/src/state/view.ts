import { create } from 'zustand';
import { SURFACE_PREF_KEY } from '../lib/surface';

/**
 * Scene display settings that the View menu (top bar), the scene's camera toolbar and the hotkeys share. `SceneView` subscribes
 * and pushes each change to the SceneController; nothing here touches the scene directly.
 * Labels, close-up detail and the surface-view default are remembered per browser (`eio.labels`, `eio.detail`, `eio.surface`,
 * value 'on' / 'off', anything else = on). Scope resets to auto on reload. `surface` mirrors the controller's current mode.
 */
export interface ViewState {
  labels: boolean;
  detail: boolean;
  scopeAll: boolean;
  surface: boolean;
  /** focusing an object near the Earth switches to the surface view (Settings; the last S / Surface also sets it) */
  surfaceAuto: boolean;
  /** id of the observatory the camera stands at (first-person view), else null; mirrors the controller */
  firstPerson: string | null;
  help: boolean;
  toggleLabels(): void;
  toggleDetail(): void;
  setDetail(on: boolean): void;
  toggleScope(): void;
  setSurface(on: boolean): void;
  setSurfaceAuto(on: boolean): void;
  setFirstPerson(id: string | null): void;
  setHelp(on: boolean): void;
  toggleHelp(): void;
}

export const LABELS_KEY = 'eio.labels';
export const DETAIL_KEY = 'eio.detail';
export { SURFACE_PREF_KEY };

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
    surfaceAuto: loadFlag(SURFACE_PREF_KEY, storage),
    firstPerson: null,
    help: false,
    toggleLabels: () => {
      const labels = !get().labels;
      saveFlag(LABELS_KEY, labels, storage);
      set({ labels });
    },
    toggleDetail: () => get().setDetail(!get().detail),
    setDetail: (detail) => {
      saveFlag(DETAIL_KEY, detail, storage);
      if (get().detail !== detail) set({ detail });
    },
    toggleScope: () => set({ scopeAll: !get().scopeAll }),
    setSurface: (surface) => { if (get().surface !== surface) set({ surface }); },
    setSurfaceAuto: (surfaceAuto) => {
      saveFlag(SURFACE_PREF_KEY, surfaceAuto, storage);
      if (get().surfaceAuto !== surfaceAuto) set({ surfaceAuto });
    },
    setFirstPerson: (firstPerson) => { if (get().firstPerson !== firstPerson) set({ firstPerson }); },
    setHelp: (help) => { if (get().help !== help) set({ help }); },
    toggleHelp: () => set({ help: !get().help }),
  }));
}

export const useView = createViewStore();
