import type { ClockSnapshot } from '@eio/core';
import { perf } from '../lib/perf';
import { extrapolateStates } from '../lib/sgp4-extrapolate';
import type { FromWorker, SatInit, ToWorker } from '../workers/protocol';

/**
 * Main-thread handle on the SGP4 worker. `positions` always matches `ids` (TEME xyz, km) and holds the worker's latest
 * sample carried to the time last passed to `advance` (the frame's sim time), so the points never lag the camera.
 */
export class PropagatorClient {
  ids: string[] = [];
  positions = new Float64Array(0);
  /** the latest sample: x, y, z, vx, vy, vz per id at `simMs` */
  private states = new Float64Array(0);
  simMs = 0;
  /** set when `positions` changed since the consumer last cleared it */
  dirty = false;
  onLayout: (ids: string[]) => void = () => undefined;

  private worker = new Worker(new URL('../workers/propagator.worker.ts', import.meta.url), { type: 'module' });
  private version = -1;

  constructor() {
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === 'layout') {
        this.version = m.version;
        this.ids = m.ids;
        this.positions = new Float64Array(m.ids.length * 3);
        this.states = new Float64Array(m.ids.length * 6);
        this.onLayout(m.ids);
      } else if (m.version === this.version) {
        const t0 = perf.on ? performance.now() : 0;
        this.states.set(m.buffer);
        if (perf.on) {
          perf.time('positionsCopy', performance.now() - t0);
          perf.time('propagate', m.ms);
          if (!perf.firstPositionsMs && m.buffer.length) perf.firstPositionsMs = performance.now();
        }
        this.simMs = m.simMs;
        this.dirty = true;
        this.post({ type: 'recycle', buffer: m.buffer }, [m.buffer.buffer]);
      }
    };
  }

  /** Carry the latest sample to sim time `tMs` into `positions`. Call once per frame, before anything reads `positions`. */
  advance(tMs: number): void {
    extrapolateStates(this.states, this.positions, this.ids.length, (tMs - this.simMs) / 1000);
  }

  upsert(entities: SatInit[]): void {
    if (entities.length) this.post({ type: 'upsert', entities });
  }

  remove(ids: string[]): void {
    if (ids.length) this.post({ type: 'remove', ids });
  }

  setClock(s: ClockSnapshot): void {
    this.post({ type: 'clock', anchorSim: s.nowMs, anchorWall: Date.now(), rate: s.mode === 'paused' ? 0 : s.rate });
  }

  dispose(): void {
    this.worker.terminate();
  }

  private post(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }
}
