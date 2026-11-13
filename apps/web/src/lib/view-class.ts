import { defaultBodies, isBodyEntity, type EntityRecord } from '@eio/core';
import { listedParent } from './listed-parent';

/**
 * How an entity is classified for the view and the browser, in ONE place (the name of a mission never decides, the primary
 * body and the trajectory do):
 * - `body`      a Sun / planet / moon entity.
 * - `orbiter`   bound to a primary other than the Earth and the Sun: `bodyId` is a registry body (Mars, the Moon, ...) and the
 *               track is a closed orbit round it (sampled, keplerian, sgp4; not a surface point or a rover / lander). MRO, LRO.
 *               It is a satellite OF THAT BODY: its view distance is measured from the primary, its category is satellites.
 * - `satellite` an Earth orbiter near the Earth: an Earth-bound satellite / station / capsule, or an Earth-bound probe that is
 *               closer than `NEAR_ORBIT_KM` (geocentric radius known).
 * - `probe`     heliocentric or deep-space: the listed parent is the Sun, or an Earth-listed probe farther than `NEAR_ORBIT_KM` (Voyager,
 *               JWST at L2, New Horizons), and every rover or lander.
 * - `other`     anything else (launch vehicles, ground stations, pads, debris...).
 */
export type ViewClass = 'body' | 'orbiter' | 'satellite' | 'probe' | 'other';

/** Geocentric radius (km) under which an Earth-bound spacecraft is an Earth satellite; beyond it, a deep-space probe (L2 is 1.5e6 km). */
export const NEAR_ORBIT_KM = 100_000;

const SURFACE_KINDS: ReadonlySet<string> = new Set(['rover', 'lander']);
const ORBITER_KINDS: ReadonlySet<string> = new Set(['probe', 'satellite', 'station', 'capsule']);

type Rec = Pick<EntityRecord, 'kind' | 'bodyId'> & Partial<Pick<EntityRecord, 'provider'>>;

export function viewClass(rec: Rec, geocentricKm?: number): ViewClass {
  if (isBodyEntity(rec as EntityRecord)) return 'body';
  const k = rec.kind;
  if (SURFACE_KINDS.has(k)) return 'probe';
  // the LISTED parent (lib/listed-parent.ts): a probe whose track is in the Sun's sphere is heliocentric whatever its feed's centre
  const bodyId = listedParent(rec);
  const onSurface = rec.provider?.type === 'geodetic';
  if (ORBITER_KINDS.has(k) && !onSurface && bodyId !== 'EARTH' && bodyId !== 'SUN' && defaultBodies.has(bodyId)) return 'orbiter';
  if (k === 'probe') {
    if (bodyId === 'EARTH' && geocentricKm !== undefined && geocentricKm < NEAR_ORBIT_KM) return 'satellite';
    return 'probe';
  }
  if (k === 'satellite' || k === 'station' || k === 'capsule') return bodyId === 'SUN' ? 'probe' : 'satellite';
  return 'other';
}

/** The primary body an orbiter is measured from (registry id), or undefined for any other class. */
export const primaryOf = (rec: Rec): string | undefined => (viewClass(rec) === 'orbiter' ? listedParent(rec) : undefined);
