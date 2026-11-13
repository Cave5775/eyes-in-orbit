import { create } from 'zustand';

/**
 * One shared choice for every video player: show the provider's own controls (YouTube's control bar) instead of the
 * app's hover strip. Twitch, Vimeo and video files always show their own controls, so only YouTube embeds change.
 * Remembered per browser; storage failures (private mode, blocked site data) fall back to the default, off.
 */
export const PLAYER_STORAGE_KEY = 'eio.player.v1';

export function parseNativeControls(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const obj: unknown = JSON.parse(raw);
    return !!obj && typeof obj === 'object' && (obj as Record<string, unknown>).nativeControls === true;
  } catch {
    return false;
  }
}

function load(): boolean {
  try {
    return parseNativeControls(localStorage.getItem(PLAYER_STORAGE_KEY));
  } catch {
    return false;
  }
}

function save(on: boolean): void {
  try {
    localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify({ nativeControls: on }));
  } catch {
    /* not remembered; the choice still holds for this page */
  }
}

interface PlayerPrefs {
  nativeControls: boolean;
  setNativeControls(on: boolean): void;
}

export const usePlayerPrefs = create<PlayerPrefs>((set) => ({
  nativeControls: load(),
  setNativeControls: (on) => {
    save(on);
    set({ nativeControls: on });
  },
}));
