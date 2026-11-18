import { create } from 'zustand';
import {
  DEV_OPTIONS, clampNumber, defaultValues, loadDevValues, parseValue, saveDevValues, type DevOptionDef, type DevStorage, type DevValues,
} from '../lib/dev-options';

interface DevState {
  values: DevValues;
  set(id: string, raw: unknown): void;
  reset(): void;
}

export function createDevOptionsStore(storage?: DevStorage | null, defs: readonly DevOptionDef[] = DEV_OPTIONS) {
  return create<DevState>((set, get) => ({
    values: loadDevValues(storage, defs),
    set: (id, raw) => {
      const def = defs.find((d) => d.id === id);
      if (!def) return;
      const v = parseValue(def, raw);
      if (get().values[id] === v) return;
      const values = { ...get().values, [id]: v };
      saveDevValues(values, storage, defs);
      set({ values });
    },
    reset: () => {
      const values = defaultValues(defs);
      saveDevValues(values, storage, defs);
      set({ values });
    },
  }));
}

export const useDevOptions = createDevOptionsStore();

/** Current value of one number option, for code outside React (the scene reads these every frame). */
export function devNumber(id: string): number {
  const def = DEV_OPTIONS.find((d) => d.id === id);
  const v = useDevOptions.getState().values[id];
  return typeof v === 'number' ? v : def?.type === 'number' ? clampNumber(def, def.default) : 0;
}
/** Current value of one toggle option. */
export const devFlag = (id: string): boolean => useDevOptions.getState().values[id] === true;
