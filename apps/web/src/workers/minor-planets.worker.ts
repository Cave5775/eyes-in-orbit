import { readContainer, type UnpackedOrbits } from '@eio/core';
import { pickedOrbit, propagateBelt } from '../lib/minor-planets';
import type { MpFromWorker, MpToWorker } from './minor-planets.protocol';

/**
 * Propagates the minor planets (lib/minor-planets.ts `propagateBelt`, float64) and writes the cells the scene draws. It holds the
 * chunks it was sent (the orbits stay here, 32 bytes each: the page never keeps them) and answers a `run` with transferable buffers.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;
const chunks: UnpackedOrbits[] = [];

ctx.onmessage = (ev: MessageEvent<MpToWorker>) => {
  const m = ev.data;
  if (m.type === 'chunk') {
    chunks.push(readContainer(m.bytes));
  } else if (m.type === 'clear') {
    chunks.length = 0;
  } else if (m.type === 'run') {
    const r = propagateBelt(chunks, m.simMs);
    const out: MpFromWorker = { type: 'cells', seq: m.seq, simMs: r.simMs, total: r.index.length, cells: r.cells, offsets: r.offsets, h: r.h, index: r.index, cell: r.cell, ms: r.ms };
    ctx.postMessage(out, [r.offsets.buffer, r.h.buffer, r.index.buffer, r.cell.buffer]);
  } else {
    let at = m.index;
    let orbit = null;
    for (const u of chunks) {
      if (at < u.count) {
        orbit = pickedOrbit(u, at);
        break;
      }
      at -= u.count;
    }
    const out: MpFromWorker = { type: 'orbit', req: m.req, orbit };
    ctx.postMessage(out);
  }
};
