import type { ClockSnapshot } from '@eio/core';
import { perf } from '../lib/perf';
import type { FromWorker, SatInit, ToWorker } from '../workers/protocol';

/** Main-thread handle on the SGP4 worker; `positions` always matches `ids` (TEME xyz, km). */
export class PropagatorClient {
  ids: string[] = [];
  positions = new Float64Array(0);
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
        this.onLayout(m.ids);
      } else if (m.version === this.version) {
        const t0 = perf.on ? performance.now() : 0;
        this.positions.set(m.buffer);
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
