import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MPCORB_SAMPLE, OrbitBuilder, readContainer, readMpcorb } from '@eio/core';
import type { Api, MinorPlanetIndex } from '../src/api/types';
import { propagateBelt } from '../src/lib/minor-planets';
import { rememberPicked } from '../src/lib/minor-planet-recent';
import { orbitLines } from '../src/lib/orbit-lines';
import { createPointMaterial } from '../src/scene/materials';
import { MINOR_PLANET_PROBE, MinorPlanetLayer, minorPlanetRecord, type MinorFrame, type WorkerLike } from '../src/scene/minor-planets';
import { classify } from '../src/lib/query';
import type { MpFromWorker, MpToWorker } from '../src/workers/minor-planets.protocol';
import { useStore } from '../src/state/store';

const T = Date.UTC(2026, 10, 18, 12);

async function sample() {
  const b = new OrbitBuilder();
  await readMpcorb(MPCORB_SAMPLE.split('\n'), b);
  return b.finish({ skipped: 0 });
}

class FakeWorker implements WorkerLike {
  sent: MpToWorker[] = [];
  terminated = false;
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  onmessageerror: WorkerLike['onmessageerror'] = null;
  postMessage(m: MpToWorker): void { this.sent.push(m); }
  terminate(): void { this.terminated = true; }
  runs(): Extract<MpToWorker, { type: 'run' }>[] { return this.sent.filter((m): m is Extract<MpToWorker, { type: 'run' }> => m.type === 'run'); }
  reply(m: MpFromWorker): void { this.onmessage?.({ data: m } as MessageEvent<MpFromWorker>); }
}

const flush = async (n = 20) => { for (let i = 0; i < Math.ceil(n / 10); i++) await new Promise((r) => setTimeout(r, 2)); };
const frame = (simMs = T): MinorFrame => ({ origin: new THREE.Vector3(1.5e8, 0, 0), dir: [1, 0, 0], sun: [0, 0, 0], simMs, fovRad: 0.8, aspect: 1.5, heightPx: 600 });
const idx = (chunks: number): MinorPlanetIndex => ({
  count: 20 * chunks, chunkSize: 65536, chunks: Array.from({ length: chunks }, (_, k) => ({ chunk: k, count: 20, hFirst: 3, hLast: 9 })),
  fetchedAt: T, stale: false, skipped: 0, epochMin: T, epochMax: T, credit: 'Minor Planet Center',
});

function setup(opts: { chunks?: number; index?: () => Promise<MinorPlanetIndex | null>; chunk?: (k: number) => Promise<Uint8Array>; sleep?: (ms: number, s: AbortSignal) => Promise<void> } = {}) {
  const worker = new FakeWorker();
  const clock = { t: 10_000 };
  const scene = new THREE.Scene();
  const layer = new MinorPlanetLayer(scene, createPointMaterial(1).uniforms, 1, { makeWorker: () => worker, sleep: opts.sleep ?? (async () => undefined), now: () => clock.t });
  const api = {
    minorPlanetIndex: opts.index ?? (async () => idx(opts.chunks ?? 1)),
    minorPlanetChunk: opts.chunk ?? (async () => new Uint8Array(await sample())),
  } as unknown as Api;
  return { worker, layer, scene, clock, api };
}

/** what the worker would answer for the chunks it holds */
async function cellsFor(total: number, seq: number, simMs = T): Promise<Extract<MpFromWorker, { type: 'cells' }>> {
  const u = readContainer(await sample());
  const r = propagateBelt([u], simMs);
  return { type: 'cells', seq, simMs, total, cells: r.cells, offsets: r.offsets, h: r.h, index: r.index, cell: r.cell, ms: 5 };
}

describe('the cloud layer: one draw, in-place uploads', () => {
  it('draws everything with ONE Points object and writes a texel per cell (end slot = first slot not drawn)', async () => {
    const { layer, worker, api } = setup();
    layer.load(() => api);
    await flush();
    layer.update(frame());
    const run = worker.runs()[0];
    expect(run).toBeDefined();
    worker.reply(await cellsFor(20, run.seq));
    expect(layer.group.children).toHaveLength(1);
    expect(layer.group.matrixAutoUpdate).toBe(false);
    expect(layer.group.children[0].matrixAutoUpdate).toBe(false);
    layer.update(frame());
    const tex = (layer as unknown as { texture: THREE.DataTexture }).texture;
    const data = tex.image.data as unknown as Float32Array;
    const cells = (layer as unknown as { cells: { start: number; count: number }[] }).cells;
    expect(cells.length).toBeGreaterThan(0);
    // the camera is at 1 AU: every cell is near enough for all its points or its brightest share; the texel's alpha is start + drawn
    for (let i = 0; i < cells.length; i++) {
      expect(data[i * 4 + 3]).toBeGreaterThanOrEqual(cells[i].start);
      expect(data[i * 4 + 3]).toBeLessThanOrEqual(cells[i].start + cells[i].count);
    }
    // a second pass of the same size updates the attributes in place: the geometry and the Points object stay
    const before = layer.group.children[0];
    worker.reply({ ...(await cellsFor(20, 1, T + 1000)), seq: worker.runs().length });
    expect(layer.group.children).toHaveLength(1);
    expect(layer.group.children[0]).toBe(before);
    layer.dispose();
  });
});

describe('load race: a chunk posted while a pass is in flight is not lost', () => {
  it('keeps the positions as not shown when the pass did not hold every loaded orbit, and asks again', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { layer, worker, api, clock } = setup({
      chunks: 2,
      chunk: async (k) => { if (k === 1) await gate; return new Uint8Array(await sample()); },
    });
    layer.load(() => api);
    await flush();
    layer.update(frame()); // chunk 0 is loaded: a pass for its 20 orbits starts
    expect(worker.runs()).toHaveLength(1);
    release(); // chunk 1 arrives while the pass runs
    await flush();
    expect(worker.sent.filter((m) => m.type === 'chunk')).toHaveLength(2);
    worker.reply(await cellsFor(20, 1)); // the pass held 20 of the 40
    clock.t += 5_000;
    layer.update(frame());
    expect(worker.runs()).toHaveLength(2); // asked again, with the same sim time: the second pass has all 40
    worker.reply(await cellsFor(40, 2));
    clock.t += 60_000;
    layer.update(frame());
    expect(worker.runs()).toHaveLength(2); // complete and not drifted: quiet
    layer.dispose();
  });
});

describe('worker errors', () => {
  it('resets running, logs once, backs off and stops after four in a row', async () => {
    const warn: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warn.push(a); };
    try {
      const { layer, worker, api, clock } = setup();
      layer.load(() => api);
      await flush();
      layer.update(frame());
      expect(worker.runs()).toHaveLength(1);
      worker.onerror?.({ message: 'boom' } as ErrorEvent);
      layer.update(frame()); // inside the 5 s wait
      expect(worker.runs()).toHaveLength(1);
      clock.t += 6_000;
      layer.update(frame());
      expect(worker.runs()).toHaveLength(2);
      worker.onmessageerror?.({} as MessageEvent);
      clock.t += 11_000;
      layer.update(frame());
      expect(worker.runs()).toHaveLength(3);
      worker.onerror?.({ message: 'boom' } as ErrorEvent);
      clock.t += 25_000;
      layer.update(frame());
      expect(worker.runs()).toHaveLength(4);
      worker.onerror?.({ message: 'boom' } as ErrorEvent);
      expect(worker.terminated).toBe(true);
      clock.t += 1e7;
      layer.update(frame());
      expect(worker.runs()).toHaveLength(4);
      expect(warn).toHaveLength(1);
      expect(layer.stats.workerErrors).toBe(4);
      layer.dispose();
    } finally {
      console.warn = orig;
    }
  });
});

describe('load robustness', () => {
  it('fetches a failed chunk again after a wait', async () => {
    let tries = 0;
    const waits: number[] = [];
    const { layer, worker, api } = setup({
      chunk: async () => { if (++tries < 3) throw new Error('HTTP 502'); return new Uint8Array(await sample()); },
      sleep: async (ms) => { waits.push(ms); },
    });
    layer.load(() => api);
    await flush(60);
    expect(tries).toBe(3);
    expect(waits).toEqual([1_000, 4_000]);
    expect(worker.sent.filter((m) => m.type === 'chunk')).toHaveLength(1);
    expect(layer.stats.error).toBe('');
    layer.dispose();
  });

  it('keeps polling the index slowly (every 10 minutes) and dispose ends the loop', async () => {
    const waits: number[] = [];
    let asked = 0;
    const { layer, api } = setup({
      index: async () => { asked++; return null; },
      sleep: async (ms) => { waits.push(ms); if (waits.length >= 8) return new Promise(() => undefined); },
    });
    layer.load(() => api);
    await flush(80);
    expect(waits.slice(0, 7)).toEqual([5_000, 15_000, 60_000, 300_000, 600_000, 600_000, 600_000]);
    const before = asked;
    layer.dispose();
    await flush(40);
    expect(asked).toBe(before);
    expect(layer.stats.loading).toBe(true); // the pending sleep never resolved here; a real sleep resolves on abort (next test)
  });

  it('a real sleep resolves when the layer is disposed, and the loop returns without asking again', async () => {
    let asked = 0;
    const { layer, api } = setup({ index: async () => { asked++; return null; }, sleep: undefined });
    const l2 = new MinorPlanetLayer(new THREE.Scene(), createPointMaterial(1).uniforms, 1, { makeWorker: () => new FakeWorker(), now: () => 0 });
    l2.load(() => ({ ...api, minorPlanetIndex: async () => { asked++; return null; } }) as Api);
    await flush();
    expect(asked).toBe(1); // asked at once, now sleeping 5 s
    l2.dispose();
    await flush(20);
    expect(asked).toBe(1);
    expect(l2.stats.loading).toBe(false);
    layer.dispose();
  });
});

describe('hidden by the query or the scope', () => {
  it('does not run or draw while hidden', async () => {
    const { layer, worker, api } = setup();
    layer.load(() => api);
    await flush();
    layer.setHidden(true);
    layer.update(frame());
    expect(worker.runs()).toHaveLength(0);
    expect(layer.group.visible).toBe(false);
    layer.setHidden(false);
    layer.update(frame());
    expect(worker.runs()).toHaveLength(1);
    expect(layer.group.visible).toBe(true);
    layer.dispose();
  });

  it('is hidden by classify() of the representative record, the same predicate as every other point (no rule of its own)', () => {
    const q = (terms: object[]) => ({ terms }) as never;
    expect(classify(MINOR_PLANET_PROBE, q([]))).toBe('off');
    expect(classify(MINOR_PLANET_PROBE, q([{ key: 'type', value: 'satellite' }]))).toBe('out');
    expect(classify(MINOR_PLANET_PROBE, q([{ key: 'group', value: 'minor-planets' }]))).toBe('show');
    expect(classify(MINOR_PLANET_PROBE, q([{ key: 'group', value: 'minor-planets', neg: true }]))).not.toBe('show');
  });
});

describe('the picked entities stay few', () => {
  it('rememberPicked keeps the new one and the last four, never evicts the selection', () => {
    let recent: string[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e']) recent = rememberPicked(recent, id, id).recent;
    expect(recent).toEqual(['e', 'd', 'c', 'b', 'a']);
    const r = rememberPicked(recent, 'f', 'f');
    expect(r.recent).toEqual(['f', 'e', 'd', 'c', 'b']);
    expect(r.evict).toEqual(['a']);
    // the selection is kept even when it is old
    const r2 = rememberPicked(['e', 'd', 'c', 'b', 'a'], 'g', 'a');
    expect(r2.evict).toEqual([]);
    expect(r2.recent).toContain('a');
    // a repeat moves to the front
    expect(rememberPicked(['b', 'a'], 'a', 'a').recent).toEqual(['a', 'b']);
  });

  it('the store drops evicted entities but not the selection, and a full reload keeps the selected one', async () => {
    const u = readContainer(await sample());
    const { pickedOrbit } = await import('../src/lib/minor-planets');
    const a = minorPlanetRecord(pickedOrbit(u, 0), T), b = minorPlanetRecord(pickedOrbit(u, 1), T);
    const s = useStore.getState();
    s.upsertEntities([a, b], true);
    s.selectObject(a.id);
    s.removeEntities([a.id, b.id]);
    expect(useStore.getState().entities.has(a.id)).toBe(true);
    expect(useStore.getState().entities.has(b.id)).toBe(false);
    // a reconnect replaces the catalogue with the server's records: the selected minor planet survives, so the selection does too
    useStore.getState().upsertEntities([], true);
    expect(useStore.getState().entities.has(a.id)).toBe(true);
    useStore.getState().upsertEntities([{ ...MINOR_PLANET_PROBE, id: 'x', group: 'other' }], true);
    expect(useStore.getState().selectedId).toBe(a.id);
    useStore.getState().selectObject(null);
  });

  it('a picked minor planet gives no dimmed orbit line under the Sun, only its own when selected', async () => {
    const u = readContainer(await sample());
    const { pickedOrbit } = await import('../src/lib/minor-planets');
    const rec = minorPlanetRecord(pickedOrbit(u, 0), T);
    const sun = { id: 'body-sun', bodyId: 'SUN', provider: { type: 'body', bodyId: 'SUN' }, updatedAt: 0, render: {} } as never;
    const recs = new Map<string, never>([['body-sun', sun], [rec.id, rec as never]]);
    expect(orbitLines(recs, 'body-sun').map((l) => l.id)).not.toContain(rec.id);
    expect(orbitLines(recs, rec.id)[0]).toEqual({ id: rec.id, role: 'selected' });
  });
});
