import { json2satrec, propagate, type SatRec } from 'satellite.js';
import type { Omm, ProviderSpec, StateProvider, StateVector } from '../types';

const MS_PER_DAY = 86_400_000;
/** Elements older than this get a reduced confidence value. */
const STALE_AFTER_DAYS = 14;

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
    if (!Number.isFinite(p.x)) return null;
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
