import type { KeplerElements } from './types';
import { DEG, J2000_MS, type Vec3 } from './math';
import { moonStateEci } from './ephemeris';

export type BodyRotation =
  | { kind: 'gmst' }
  | {
      kind: 'linear';
      /** IAU pole right ascension / declination, degrees */
      poleRaDeg: number;
      poleDecDeg: number;
      /** prime meridian angle at J2000, degrees */
      w0Deg: number;
      /** rotation rate, degrees per day */
      rateDegPerDay: number;
    };

export interface Body {
  id: string;
  name: string;
  parentId?: string;
  /** equatorial radius, km */
  radiusKm: number;
  /** (a-b)/a */
  flattening: number;
  /** km^3/s^2 */
  gm: number;
  rotation: BodyRotation;
  /** orbit around parent (approximate mean elements), used to relate inertial frames */
  orbit?: KeplerElements;
  /** `orbit` is referred to the ecliptic; relating inertial frames rotates it into the equatorial axes they all share */
  orbitPlane?: 'ecliptic';
  /** position and velocity relative to the parent (parent's inertial axes), km and km/s; used instead of `orbit` when set */
  ephemeris?: (tMs: number) => { r: Vec3; v: Vec3 };
  /** true when ephemeris/rotation values are only low precision */
  approx?: boolean;
}

export const SUN: Body = {
  id: 'SUN', name: 'Sun', radiusKm: 695_700, flattening: 0, gm: 1.32712440018e11,
  rotation: { kind: 'linear', poleRaDeg: 286.13, poleDecDeg: 63.87, w0Deg: 84.176, rateDegPerDay: 14.1844 },
};

export const EARTH: Body = {
  id: 'EARTH', name: 'Earth', parentId: 'SUN',
  radiusKm: 6378.137, flattening: 1 / 298.257223563, gm: 398_600.4418,
  rotation: { kind: 'gmst' },
  orbit: { a: 149_598_023, e: 0.0167, i: 0, raan: 0, argp: 102.9 * DEG, m0: 357.5 * DEG, epochMs: J2000_MS },
  orbitPlane: 'ecliptic',
  approx: true,
};

export const MOON: Body = {
  id: 'MOON', name: 'Moon', parentId: 'EARTH',
  radiusKm: 1737.4, flattening: 0.0012, gm: 4902.8,
  rotation: { kind: 'linear', poleRaDeg: 269.9949, poleDecDeg: 66.5392, w0Deg: 38.3213, rateDegPerDay: 13.17635815 },
  orbit: { a: 384_400, e: 0.0549, i: 5.145 * DEG, raan: 125.08 * DEG, argp: 318.15 * DEG, m0: 135.27 * DEG, epochMs: J2000_MS },
  ephemeris: moonStateEci,
  approx: true,
};

export const MARS: Body = {
  id: 'MARS', name: 'Mars', parentId: 'SUN',
  radiusKm: 3396.19, flattening: 1 / 169.8, gm: 42_828.37,
  rotation: { kind: 'linear', poleRaDeg: 317.68143, poleDecDeg: 52.8865, w0Deg: 176.63, rateDegPerDay: 350.89198226 },
  orbit: { a: 227_939_200, e: 0.0934, i: 1.85 * DEG, raan: 49.58 * DEG, argp: 286.5 * DEG, m0: 19.4 * DEG, epochMs: J2000_MS },
  orbitPlane: 'ecliptic',
  approx: true,
};

export class BodyRegistry {
  private bodies = new Map<string, Body>();

  constructor(initial: Body[] = [SUN, EARTH, MOON, MARS]) {
    for (const b of initial) this.register(b);
  }

  register(body: Body): void {
    this.bodies.set(body.id, body);
  }

  get(id: string): Body {
    const b = this.bodies.get(id);
    if (!b) throw new Error(`Unknown body: ${id}`);
    return b;
  }

  has(id: string): boolean {
    return this.bodies.has(id);
  }

  all(): Body[] {
    return [...this.bodies.values()];
  }

  /** Chain from body up to the root, body first. */
  lineage(id: string): Body[] {
    const out: Body[] = [];
    let cur: Body | undefined = this.get(id);
    while (cur) {
      out.push(cur);
      cur = cur.parentId ? this.get(cur.parentId) : undefined;
    }
    return out;
  }
}

export const defaultBodies = new BodyRegistry();
