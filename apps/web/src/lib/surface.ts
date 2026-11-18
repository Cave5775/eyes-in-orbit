import { EARTH, bodyOf, defaultBodies, type EntityRecord } from '@eio/core';
import { hasSurface } from './surface-body';
import { listedParent } from './listed-parent';
import { viewClass } from './view-class';

/**
 * Policy for the surface-oriented camera (level horizon, local vertical up, north-up) that is on by default whenever an
 * object near a body with a ground (the Earth, the Moon, Mars, ...) is being viewed. Pure: the scene controller feeds it the facts.
 */

/**
 * THE rule for which body the surface view stands on, from the subject's primary body, never from a name: a body entity is its own
 * ground; an orbiter, lander or rover is on its primary body (`viewClass`, the listed parent / `bodyId`); an Earth satellite, pad,
 * booster or ground station is on the Earth; a deep-space probe has none (null); a bare ground point or the free camera (no `rec`)
 * is on the frame's body when the frame centre is a body with a ground, else the Earth. The Sun is never a ground.
 * `frameBodyId` is the registry id of the frame centre (null when the centre is not a body); `geocentricKm` tells an Earth probe's class.
 */
export function surfaceBodyFor(
  rec: (Pick<EntityRecord, 'kind' | 'bodyId'> & Partial<Pick<EntityRecord, 'provider'>>) | null,
  frameBodyId: string | null,
  geocentricKm?: number,
): string | null {
  if (!rec) return frameBodyId && hasSurface(frameBodyId) ? frameBodyId : frameBodyId === null ? 'EARTH' : null;
  const own = bodyOf(rec);
  if (own !== undefined) return hasSurface(own) ? own : null;
  const cls = viewClass(rec, geocentricKm);
  if (cls === 'orbiter') return hasSurface(listedParent(rec)) ? listedParent(rec) : null;
  if (cls === 'surface') return hasSurface(rec.bodyId) ? rec.bodyId : null;
  if (cls === 'probe') return null;
  return 'EARTH';
}

/** Highest altitude (km above the ellipsoid) at which the surface orientation is still useful: past GEO and the high elliptical orbits, but well short of the Moon. */
export const AUTO_SURFACE_MAX_ALT_KM = 100_000;
/** The same limit in radii of the body (the Earth's 100,000 km is 15.7 of them), so the rule does not change with the body's size: 27,000 km at the Moon, 53,000 km at Mars. */
export const AUTO_SURFACE_MAX_RADII = AUTO_SURFACE_MAX_ALT_KM / EARTH.radiusKm;

export interface AutoSurfaceContext {
  /** the user's remembered choice: false after they switched the surface view off (S / SURFACE) */
  pref: boolean;
  /** the body the surface view would stand on (`surfaceBodyFor`), null when there is none (a deep-space probe, the Sun) */
  bodyId: string | null;
}

/**
 * Should focusing this subject switch the camera into the surface orientation?
 * `rec` is the focused entity, or null for a bare ground point (a launch pad focused by latitude and longitude);
 * `altKm` is the subject's height above that body's ground, null when it has no position (nothing to orient to).
 * Yes for anything near the body, whatever its provider (orbit, launch ascent, booster, ground entity, a Moon orbiter, a Mars
 * rover); no for a body entity itself, for objects beyond `AUTO_SURFACE_MAX_RADII` radii, when there is no ground body, and
 * after the user opted out.
 */
export function shouldAutoSurface(rec: Partial<Pick<EntityRecord, 'provider'>> | null, altKm: number | null, ctx: AutoSurfaceContext): boolean {
  if (!ctx.pref || !ctx.bodyId) return false;
  if (!rec) return true;
  if (rec.provider?.type === 'body') return false;
  return altKm !== null && Number.isFinite(altKm) && altKm < AUTO_SURFACE_MAX_RADII * defaultBodies.get(ctx.bodyId).radiusKm;
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
