import type { Omm } from '@eio/core';

export interface SatInit {
  id: string;
  omm: Omm;
}

export type ToWorker =
  | { type: 'upsert'; entities: SatInit[] }
  | { type: 'remove'; ids: string[] }
  /** sim time = anchorSim + (Date.now() - anchorWall) * rate; rate 0 = frozen */
  | { type: 'clock'; anchorSim: number; anchorWall: number; rate: number }
  /** hand a consumed position buffer back for reuse */
  | { type: 'recycle'; buffer: Float32Array };

export type FromWorker =
  /** index order of every following `positions` message with the same version */
  | { type: 'layout'; version: number; ids: string[] }
  /** xyz triples in km (TEME); 0,0,0 where propagation failed */
  | { type: 'positions'; version: number; simMs: number; buffer: Float32Array };

export const TICK_MS = 33;
