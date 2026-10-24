import type { EntityRecord } from '@eio/core';

/**
 * Policy for the surface-oriented camera (level horizon, local vertical up, north-up) that is on by default whenever an
 * object near the Earth is being viewed. Pure: the scene controller feeds it the facts.
 */

/** Highest altitude (km above the ellipsoid) at which the surface orientation is still useful: past GEO and the high elliptical orbits, but well short of the Moon. */
export const AUTO_SURFACE_MAX_ALT_KM = 100_000;

export interface AutoSurfaceContext {
  /** the user's remembered choice: false after they switched the surface view off (S / SURFACE) */
  pref: boolean;
  /** the camera frame is the Earth (not the Moon or the Sun view, later a non-Earth frame centre) */
  earthCentred: boolean;
}

/**
 * Should focusing this subject switch the camera into the surface orientation?
 * `rec` is the focused entity, or null for a bare ground point (a launch pad focused by latitude and longitude);
 * `altKm` is the subject's height above the ellipsoid, null when it has no position (nothing to orient to).
 * Yes for anything near the Earth, whatever its provider (orbit, launch ascent, booster, ground entity); no for deep-space
 * objects, for entities whose primary body is not the Earth, for a non-Earth frame, and after the user opted out.
 */
export function shouldAutoSurface(rec: Pick<EntityRecord, 'bodyId'> | null, altKm: number | null, ctx: AutoSurfaceContext): boolean {
  if (!ctx.pref || !ctx.earthCentred) return false;
  if (!rec) return true;
  if (rec.bodyId !== 'EARTH') return false;
  return altKm !== null && Number.isFinite(altKm) && altKm < AUTO_SURFACE_MAX_ALT_KM;
}

/** localStorage key of the opt-out; absent (or anything but 'off') means the surface view is on by default. */
export const SURFACE_PREF_KEY = 'eio.surface';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The remembered choice: true (the default) unless the user turned the surface view off. */
export function loadSurfacePref(storage: Pick<StorageLike, 'getItem'> | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(SURFACE_PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Remember the choice; turning it on again removes the key, which restores the default. */
export function saveSurfacePref(on: boolean, storage: StorageLike | null = defaultStorage()): void {
  try {
    if (on) storage?.removeItem(SURFACE_PREF_KEY);
    else storage?.setItem(SURFACE_PREF_KEY, 'off');
  } catch { /* private window: the choice just is not remembered */ }
}
