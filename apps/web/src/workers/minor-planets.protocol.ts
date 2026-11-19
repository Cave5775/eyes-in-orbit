import type { BeltCell } from '../lib/minor-planets';
import type { PickedOrbit } from '../lib/minor-planets';

export type MpToWorker =
  /** a chunk of orbits (an `MPCB` container); chunks arrive in file order */
  | { type: 'chunk'; bytes: Uint8Array }
  /** propagate everything loaded to `simMs` and answer with `cells` */
  | { type: 'run'; seq: number; simMs: number }
  /** the orbit with this index (over all chunks) for the pick */
  | { type: 'orbit'; req: number; index: number }
  | { type: 'clear' };

export type MpFromWorker =
  | { type: 'cells'; seq: number; simMs: number; total: number; cells: BeltCell[]; offsets: Float32Array; h: Uint16Array; index: Uint32Array; cell: Float32Array; ms: number }
  | { type: 'orbit'; req: number; orbit: PickedOrbit | null };
