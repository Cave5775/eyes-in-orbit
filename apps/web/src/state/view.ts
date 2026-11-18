import { create } from 'zustand';
import { SKY_OFF, skyReduce, type SkyEvent, type SkyModeState } from '../lib/sky-mode';
import { DEFAULT_SKY_TRANSITION, SKY_TRANSITION_KEY, parseSkyTransition, type SkyTransitionId } from '../lib/sky-transition';
import { SURFACE_PREF_KEY } from '../lib/surface';

/**
 * Scene display settings that the View menu (top bar), the scene's camera toolbar and the hotkeys share. `SceneView` subscribes
 * and pushes each change to the SceneController; nothing here touches the scene directly.
 * Labels, close-up detail and the surface-view default are remembered per browser (`eio.labels`, `eio.detail`, `eio.surface`,
 * value 'on' / 'off', anything else = on); so is the Sky view's transition (`eio.skyTransition`, lib/sky-transition.ts). Scope resets to auto on reload. `surface` mirrors the controller's current mode.
 */
export interface ViewState {
  labels: boolean;
  detail: boolean;
  /** day / night shading from the Sun on bodies and models; off lights everything evenly (View menu) */
  sunShading: boolean;
  /** the minor planet point cloud (MPC MPCORB), View menu "Minor planets"; remembered, default on */
  minorPlanets: boolean;
  scopeAll: boolean;
  surface: boolean;
  /** focusing an object near the Earth switches to the surface view (Settings; the last S / Surface also sets it) */
  surfaceAuto: boolean;
  /** eased orbit, zoom and pan with inertia (Settings, Camera; tuning in the developer options, lib/smoothing.ts) */
  smoothCamera: boolean;
  /** id of the observatory the camera stands at (first-person view), else null; mirrors the controller */
  firstPerson: string | null;
  /**
   * The Sky view's phase machine (lib/sky-mode.ts): phase, observatory, and the message of the last failure. It is driven by
   * `skyDispatch`; the work that goes with each phase is state/sky-flow.ts (the flow) and ui/SkyOverlay.tsx (the Aladin view).
   */
  sky: SkyModeState;
  /** how the scene changes into the Sky view and back (Settings > Sky view) */
  skyTransition: SkyTransitionId;
  help: boolean;
  toggleLabels(): void;
  toggleDetail(): void;
  setDetail(on: boolean): void;
  toggleSunShading(): void;
  toggleMinorPlanets(): void;
  toggleScope(): void;
  setSurface(on: boolean): void;
  setSmoothCamera(on: boolean): void;
  setSurfaceAuto(on: boolean): void;
  setFirstPerson(id: string | null): void;
  skyDispatch(e: SkyEvent): void;
  setSkyTransition(id: SkyTransitionId): void;
  setHelp(on: boolean): void;
  toggleHelp(): void;
}

export const LABELS_KEY = 'eio.labels';
export const DETAIL_KEY = 'eio.detail';
export const SUN_SHADING_KEY = 'eio.sunShading';
export const SMOOTH_CAMERA_KEY = 'eio.smoothCamera';
export const MINOR_PLANETS_KEY = 'eio.minorPlanets';
export { SKY_TRANSITION_KEY };
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

/** The remembered Sky view transition; the default when nothing valid is stored or storage is blocked. */
export function loadSkyTransition(storage: Pick<StorageLike, 'getItem'> | null | undefined = defaultStorage()): SkyTransitionId {
  try {
    return parseSkyTransition(storage?.getItem(SKY_TRANSITION_KEY));
  } catch {
    return DEFAULT_SKY_TRANSITION;
  }
}

export function createViewStore(storage: StorageLike | null | undefined = defaultStorage()) {
  return create<ViewState>((set, get) => ({
    labels: loadFlag(LABELS_KEY, storage),
    detail: loadFlag(DETAIL_KEY, storage),
    sunShading: loadFlag(SUN_SHADING_KEY, storage),
    minorPlanets: loadFlag(MINOR_PLANETS_KEY, storage),
    scopeAll: false,
    surface: false,
    surfaceAuto: loadFlag(SURFACE_PREF_KEY, storage),
    smoothCamera: loadFlag(SMOOTH_CAMERA_KEY, storage),
    firstPerson: null,
    sky: SKY_OFF,
    skyTransition: loadSkyTransition(storage),
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
    toggleSunShading: () => {
      const sunShading = !get().sunShading;
      saveFlag(SUN_SHADING_KEY, sunShading, storage);
      set({ sunShading });
    },
    toggleMinorPlanets: () => {
      const minorPlanets = !get().minorPlanets;
      saveFlag(MINOR_PLANETS_KEY, minorPlanets, storage);
      set({ minorPlanets });
    },
    toggleScope: () => set({ scopeAll: !get().scopeAll }),
    setSurface: (surface) => { if (get().surface !== surface) set({ surface }); },
    setSmoothCamera: (smoothCamera) => {
      saveFlag(SMOOTH_CAMERA_KEY, smoothCamera, storage);
      if (get().smoothCamera !== smoothCamera) set({ smoothCamera });
    },
    setSurfaceAuto: (surfaceAuto) => {
      saveFlag(SURFACE_PREF_KEY, surfaceAuto, storage);
      if (get().surfaceAuto !== surfaceAuto) set({ surfaceAuto });
    },
    setFirstPerson: (firstPerson) => { if (get().firstPerson !== firstPerson) set({ firstPerson }); },
    skyDispatch: (e) => {
      const sky = skyReduce(get().sky, e);
      if (sky !== get().sky) set({ sky });
    },
    setSkyTransition: (skyTransition) => {
      try {
        storage?.setItem(SKY_TRANSITION_KEY, skyTransition);
      } catch { /* private window: the choice just is not remembered */ }
      if (get().skyTransition !== skyTransition) set({ skyTransition });
    },
    setHelp: (help) => { if (get().help !== help) set({ help }); },
    toggleHelp: () => set({ help: !get().help }),
  }));
}

export const useView = createViewStore();
