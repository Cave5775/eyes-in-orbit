/**
 * Ascent trajectory shape (ported from the server's `trajectory.ts`, which also holds the parsers; those arrive with the
 * on-demand services). The Hub keeps a list of them.
 */
export interface Trajectory {
  id: string;
  source?: string;
  azimuthDeg: number;
  match: { launchId?: string; nameContains?: string };
  rows: { tSec: number; altKm: number; downrangeKm: number }[];
}
