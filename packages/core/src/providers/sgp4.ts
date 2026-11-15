import { json2satrec, propagate, type SatRec } from 'satellite.js';
import type { Omm, ProviderSpec, StateProvider, StateVector } from '../types';

const MS_PER_DAY = 86_400_000;
/** Elements older than this get a reduced confidence value. */
const STALE_AFTER_DAYS = 14;
/** Earth's gravitational parameter (km^3/s^2, WGS-72 as SGP4 uses) and the radius under which a state is inside the Earth (km). */
const MU_EARTH = 398_600.8;
const MIN_RADIUS_KM = 6_300;

/**
 * Is an SGP4 state physically possible for a catalogued (bound) Earth orbiter? SGP4 does not always flag a decayed element set:
 * a set with a large drag term (BSTAR 0.16, propagated weeks past its epoch) gives error 6 most minutes and, in between,
 * finite positions at 186,000 km/s with error 0 (STARLINK-35837, triage #29). Any state at or above escape speed
 * (vis-viva: v^2 >= 2 mu / r), or inside the Earth, is rejected. r in km, v in km/s.
 */
export function plausibleSgp4State(rx: number, ry: number, rz: number, vx: number, vy: number, vz: number): boolean {
  const r = Math.hypot(rx, ry, rz);
  if (!(r >= MIN_RADIUS_KM)) return false;
  return vx * vx + vy * vy + vz * vz < (2 * MU_EARTH) / r;
}

/** SGP4 propagation of a CelesTrak OMM element set. Output frame is Earth inertial (TEME). */
export class Sgp4Provider implements StateProvider {
  readonly type = 'sgp4';
  private satrec: SatRec;
  private epochMs: number;

  constructor(private omm: Omm) {
    this.satrec = json2satrec(omm as never);
    this.epochMs = Date.parse(omm.EPOCH.endsWith('Z') ? omm.EPOCH : `${omm.EPOCH}Z`);
  }

  stateAt(t: number): StateVector | null {
    const out = propagate(this.satrec, new Date(t));
    if (!out || !out.position || typeof out.position === 'boolean') return null;
    const p = out.position as { x: number; y: number; z: number };
    const v = out.velocity as { x: number; y: number; z: number };
    if (!v || !plausibleSgp4State(p.x, p.y, p.z, v.x, v.y, v.z)) return null; // decayed set: no state rather than a wild one
    const ageDays = Math.abs(t - this.epochMs) / MS_PER_DAY;
    return {
      frame: 'EARTH:inertial',
      r: [p.x, p.y, p.z],
      v: [v.x, v.y, v.z],
      confidence: ageDays > STALE_AFTER_DAYS ? Math.max(0.1, 1 - (ageDays - STALE_AFTER_DAYS) / 30) : 1,
    };
  }

  /** Orbital period in minutes. */
  get periodMin(): number {
    return (2 * Math.PI) / this.satrec.no;
  }

  toSpec(): ProviderSpec {
    return { type: 'sgp4', omm: this.omm };
  }
}
