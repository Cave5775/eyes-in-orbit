import { MAX_FLOATS, defaultRect, fitRect, nextZ, type FloatWindow, type Viewport } from './floating';

/**
 * The Sky view window: one floating window, same frame, drag and resize rules as the stream windows (lib/floating.ts) and
 * counted in the same MAX_FLOATS cap. Not remembered across reloads (Aladin starts fresh).
 */

/** Identity of the window in the floating layer (never a real URL). */
export const SKY_WINDOW_ID = 'eio:sky';

export interface SkyWindow extends FloatWindow {
  /** the observatory entity it looks from */
  obsId: string;
}

/** Windows open in total: the streams plus the Sky view. */
export const openWindowCount = (floats: readonly FloatWindow[], sky: SkyWindow | null): number => floats.length + (sky ? 1 : 0);

/** Room for one more stream window? */
export const canOpenStream = (floats: readonly FloatWindow[], sky: SkyWindow | null): boolean => openWindowCount(floats, sky) < MAX_FLOATS;

/** Room for the Sky view (always when it is already open: it is retargeted)? */
export const canOpenSky = (floats: readonly FloatWindow[], sky: SkyWindow | null): boolean => !!sky || floats.length < MAX_FLOATS;

/**
 * Open the Sky view for `obsId`, or retarget and raise the open one (keeping its place and size). Returns `sky` unchanged when the
 * cap is reached.
 */
export function openSkyWindow(sky: SkyWindow | null, floats: readonly FloatWindow[], obsId: string, title: string, vp: Viewport): SkyWindow | null {
  const z = Math.max(nextZ(floats), (sky?.z ?? 0) + 1);
  if (sky) return { ...sky, obsId, title: title.slice(0, 200) || 'Sky view', z };
  if (floats.length >= MAX_FLOATS) return sky;
  return { url: SKY_WINDOW_ID, obsId, title: title.slice(0, 200) || 'Sky view', ...defaultRect(vp, floats.length), z };
}

/** Raise above every stream window. */
export function focusSkyWindow(sky: SkyWindow | null, floats: readonly FloatWindow[]): SkyWindow | null {
  if (!sky || floats.every((f) => f.z < sky.z)) return sky;
  return { ...sky, z: nextZ(floats) };
}

export function setSkyRect(sky: SkyWindow | null, r: { x: number; y: number; w: number }, vp: Viewport): SkyWindow | null {
  return sky ? { ...sky, ...fitRect(r, vp) } : sky;
}
