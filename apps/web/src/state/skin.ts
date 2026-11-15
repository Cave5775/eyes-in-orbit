import { create } from 'zustand';
import { DEFAULT_SKIN, SKIN_ATTR, SKIN_KEY, parseSkin, serialiseSkin, type SkinId } from '../lib/skin';

/**
 * The active skin (Settings > Appearance). It is the `data-skin` attribute on `<html>`: `index.html` sets it from the stored
 * value before the first paint, this store keeps it in step with later choices and remembers them. The scene reads its
 * background from the CSS, so `SceneView` re-reads the palette when the skin changes.
 */
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadSkin(storage: Pick<StorageLike, 'getItem'> | null = defaultStorage()): SkinId {
  try {
    return parseSkin(storage?.getItem(SKIN_KEY));
  } catch {
    return DEFAULT_SKIN;
  }
}

function saveSkin(id: SkinId, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(SKIN_KEY, serialiseSkin(id));
  } catch { /* private window: the choice holds for this page only */ }
}

/** Put the skin on the root element (a no-op without a document, as in the unit tests). */
export function applySkin(id: SkinId): void {
  if (typeof document !== 'undefined') document.documentElement.setAttribute(SKIN_ATTR, id);
}

interface SkinState {
  skin: SkinId;
  setSkin(id: SkinId): void;
}

export const useSkin = create<SkinState>((set, get) => {
  const skin = loadSkin();
  applySkin(skin);
  return {
    skin,
    setSkin: (id) => {
      saveSkin(id);
      applySkin(id);
      if (get().skin !== id) set({ skin: id });
    },
  };
});
