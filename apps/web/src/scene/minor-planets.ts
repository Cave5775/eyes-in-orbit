import * as THREE from 'three';
import { readContainer, type EntityRecord } from '@eio/core';
import type { Api, MinorPlanetIndex } from '../api/types';
import {
  cellDrawCount, insideNearestKm, pickBelt, rerunDue, shownAtMs, sphereInCone, type BeltCell, type PickedOrbit,
} from '../lib/minor-planets';
import type { MpFromWorker, MpToWorker } from '../workers/minor-planets.protocol';
import { CELL_TEX_W, createCellTexture, createMinorPlanetMaterial } from './materials';

/**
 * The minor planet point cloud (MPC MPCORB, ~1.4 million orbits, the engine's minor-planet connector): chunks by H are fetched brightest
 * first and handed to a worker that propagates them in float64 and bins them into cells (lib/minor-planets.ts, docs/frames.md "Minor planet
 * cloud"). ONE `THREE.Points` draws everything: each vertex holds its float32 offset from its cell's anchor and the cell's number; once per
 * frame the CPU writes one texel per cell into a small float texture (anchor + Sun - camera in float64, and the end slot of the cell's drawn
 * points: the level of detail) and the vertex shader fetches it. Buffers are uploaded only when the worker answers (in place when the size
 * is unchanged). Per frame: a loop over the cells (about 2000: two trig calls and a sphere test each, estimated 0.1 to 0.3 ms) and a
 * 32 KB texture upload. A cell far away or small on screen draws only its brightest points, one off the view none.
 * No labels, no orbit lines; a click picks the nearest drawn point (`pick`) and asks the worker for its orbit.
 */
export interface MinorFrame {
  /** camera world position (float64, km, Earth-inertial of date) */
  origin: THREE.Vector3;
  /** unit view direction */
  dir: [number, number, number];
  /** Sun's position in the same frame at the sim time (core `sunPositionEci`) */
  sun: [number, number, number];
  simMs: number;
  fovRad: number;
  aspect: number;
  heightPx: number;
}

/** The part of a Worker the layer uses (a test hands in a fake). */
export interface WorkerLike {
  postMessage(m: MpToWorker, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent<MpFromWorker>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  onmessageerror: ((ev: MessageEvent) => void) | null;
}

export interface MinorLayerOptions {
  makeWorker?: () => WorkerLike;
  /** waits of the load loop, ms (tests shorten them) */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** Waits before asking the index again: 5 s, 15 s, 1 min, 5 min, then every 10 min until the layer is disposed. */
const INDEX_WAITS = [0, 5_000, 15_000, 60_000, 300_000];
const INDEX_POLL_MS = 600_000;
/** Waits before a failed chunk is fetched again; after the last the load stops and the error is shown. */
const CHUNK_WAITS = [0, 1_000, 4_000, 15_000, 60_000];
/** Worker errors: the next pass waits 5 s, doubling to 5 min; the fourth in a row stops the cloud. */
const WORKER_RETRY_MS = 5_000;
const MAX_WORKER_ERRORS = 4;

export class MinorPlanetLayer {
  readonly group = new THREE.Group();
  private material: THREE.ShaderMaterial;
  private points: THREE.Points | null = null;
  private geo: THREE.BufferGeometry | null = null;
  private worker: WorkerLike | null = null;
  private cells: BeltCell[] = [];
  private offsets: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private index: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
  private rel = new Float64Array(0);
  private drawn = new Int32Array(0);
  private texture: THREE.DataTexture | null = null;
  private on = true;
  private hidden = false;
  private loadStarted = false;
  /** the engine is downloading the orbits: the index is not polled meanwhile, the end of the download asks at once */
  private downloading = false;
  private wake: (() => void) | null = null;
  private readonly abort = new AbortController();
  /** orbits handed to the worker so far */
  private loaded = 0;
  /** sim time of the positions on show (null: none, or orbits arrived since) */
  private atMs: number | null = null;
  private running = false;
  private seq = 0;
  private lastEndWall = -Infinity;
  private lastPassMs = 0;
  private workerErrors = 0;
  private retryAt = 0;
  private dead = false;
  private reqs = new Map<number, (o: PickedOrbit | null) => void>();
  private req = 0;
  private readonly now: () => number;
  /** passes run and the last one's time and size (the tests, the perf overlay) */
  readonly stats = { passes: 0, lastMs: 0, points: 0, cells: 0, drawnPoints: 0, chunks: 0, loading: false, error: '', workerErrors: 0 };

  constructor(scene: THREE.Scene, shared: Record<string, THREE.IUniform>, pixelRatio: number, private readonly opts: MinorLayerOptions = {}) {
    this.now = opts.now ?? (() => performance.now());
    this.material = createMinorPlanetMaterial(shared, pixelRatio);
    this.group.visible = this.on;
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);
  }

  /** View menu "Minor planets" (the cloud is not drawn, nor run, while off). */
  setEnabled(on: boolean): void {
    this.on = on;
    this.group.visible = on && !this.hidden;
  }

  get enabled(): boolean {
    return this.on;
  }

  /** The engine's download state (pushed `minorPlanets` messages): `ready` asks for the index at once, `downloading` pauses the polling. */
  notify(state: 'none' | 'downloading' | 'ready' | 'failed'): void {
    const was = this.downloading;
    this.downloading = state === 'downloading';
    if (state !== 'downloading' || !was) this.wake?.();
  }

  /** Wait `ms` before the next index request, but not while a download runs, and no longer than the next state change. */
  private async waitForIndex(sleep: NonNullable<MinorLayerOptions['sleep']>, ms: number, signal: AbortSignal): Promise<void> {
    for (;;) {
      const woke = new Promise<void>((resolve) => { this.wake = resolve; });
      const timer = new AbortController();
      const elapsed = this.downloading ? new Promise<void>(() => undefined) : sleep(ms, timer.signal);
      await Promise.race([woke, elapsed]);
      timer.abort();
      this.wake = null;
      if (signal.aborted || !this.downloading) return;
    }
  }

  /** The query or the scope hides the cloud (`classify()` of a representative minor planet record): not drawn, not picked, no passes. */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.group.visible = this.on && !hidden;
  }

  private post(m: MpToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(m, transfer);
  }

  /**
   * Fetch the index and the chunks (brightest first) once; each chunk goes to the worker and the next frame asks for a pass. Quiet when the
   * server has none: the index is asked for again after 5 s, 15 s, 1 min, 5 min and then every 10 min (the server's first download takes
   * minutes and a data source may change under us); a failed chunk is fetched again after 1, 4, 15 and 60 s. `dispose` ends the loop.
   */
  load(getApi: () => Api): void {
    if (this.loadStarted) return;
    this.loadStarted = true;
    const sleep = this.opts.sleep ?? defaultSleep;
    const signal = this.abort.signal;
    this.worker = this.opts.makeWorker ? this.opts.makeWorker() : (new Worker(new URL('../workers/minor-planets.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike);
    this.worker.onmessage = (ev) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => this.onWorkerError(ev.message || 'worker error');
    this.worker.onmessageerror = () => this.onWorkerError('worker message could not be read');
    this.stats.loading = true;
    signal.addEventListener('abort', () => this.wake?.(), { once: true });
    void (async () => {
      try {
        let idx: MinorPlanetIndex | null = null;
        for (let n = 0; !signal.aborted; n++) {
          const wait = n < INDEX_WAITS.length ? INDEX_WAITS[n] : INDEX_POLL_MS;
          if (wait || this.downloading) await this.waitForIndex(sleep, wait, signal);
          if (signal.aborted) return;
          try {
            idx = await getApi().minorPlanetIndex();
          } catch {
            idx = null;
          }
          if (idx && idx.count) break;
        }
        if (!idx || signal.aborted) return;
        for (const c of idx.chunks) {
          let bytes: Uint8Array | null = null;
          for (let attempt = 0; attempt < CHUNK_WAITS.length && !bytes; attempt++) {
            if (CHUNK_WAITS[attempt]) await sleep(CHUNK_WAITS[attempt], signal);
            if (signal.aborted) return;
            try {
              bytes = await getApi().minorPlanetChunk(c.chunk);
              readContainer(bytes); // throws on a foreign body before the worker holds it
            } catch (err) {
              bytes = null;
              this.stats.error = (err as Error).message;
            }
          }
          if (!bytes) return;
          this.stats.error = '';
          this.post({ type: 'chunk', bytes }, [bytes.buffer as ArrayBuffer]);
          this.loaded += c.count;
          this.stats.chunks++;
          this.atMs = null; // new orbits: the next frame asks for a pass that has them
        }
      } finally {
        this.stats.loading = false;
      }
    })();
  }

  private onWorkerError(msg: string): void {
    this.running = false;
    this.stats.error = msg;
    this.stats.workerErrors++;
    this.workerErrors++;
    if (this.workerErrors >= MAX_WORKER_ERRORS) {
      this.dead = true;
      this.worker?.terminate();
    } else {
      this.retryAt = this.now() + WORKER_RETRY_MS * 2 ** (this.workerErrors - 1);
    }
    if (this.workerErrors === 1) console.warn(`[eio] minor planet worker: ${msg}`);
  }

  private onMessage(m: MpFromWorker): void {
    if (m.type === 'orbit') {
      this.reqs.get(m.req)?.(m.orbit);
      this.reqs.delete(m.req);
      return;
    }
    this.running = false;
    this.workerErrors = 0;
    this.lastEndWall = this.now();
    this.lastPassMs = m.ms;
    if (m.seq !== this.seq) return;
    // chunks posted while this pass ran are not in it: keep `atMs` null so the next frame asks again (nothing is lost)
    this.atMs = shownAtMs(m.simMs, m.total, this.loaded);
    this.stats.passes++;
    this.stats.lastMs = m.ms;
    this.stats.points = m.total;
    this.stats.cells = m.cells.length;
    this.install(m);
  }

  /** The pass's buffers become the vertex attributes: in place when the point count is unchanged, else a new geometry. */
  private install(m: Extract<MpFromWorker, { type: 'cells' }>): void {
    this.cells = m.cells;
    this.offsets = m.offsets;
    this.index = m.index;
    this.rel = new Float64Array(m.cells.length * 3);
    this.drawn = new Int32Array(m.cells.length);
    const geo = this.geo;
    const pos = geo?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (geo && pos && pos.array.length === m.offsets.length) {
      pos.array = m.offsets;
      pos.needsUpdate = true;
      const h = geo.getAttribute('aH') as THREE.BufferAttribute, cell = geo.getAttribute('aCell') as THREE.BufferAttribute;
      h.array = m.h; h.needsUpdate = true;
      cell.array = m.cell; cell.needsUpdate = true;
    } else {
      if (this.points) this.group.remove(this.points);
      this.geo?.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.offsets, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aH', new THREE.BufferAttribute(m.h, 1).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aCell', new THREE.BufferAttribute(m.cell, 1).setUsage(THREE.DynamicDrawUsage));
      const pts = new THREE.Points(g, this.material);
      pts.frustumCulled = false;
      pts.matrixAutoUpdate = false;
      this.geo = g;
      this.points = pts;
      this.group.add(pts);
    }
    this.geo?.setDrawRange(0, m.total);
    const rows = Math.max(1, Math.ceil(m.cells.length / CELL_TEX_W));
    if (!this.texture || this.texture.image.height < rows) {
      this.texture?.dispose();
      this.texture = createCellTexture(m.cells.length);
      this.material.uniforms.uCells.value = this.texture;
    }
  }

  /** Per frame, before the render: cell offsets in float64 into the texture, level of detail and culling, and a new pass when the positions are visibly old. */
  update(f: MinorFrame): void {
    if (!this.on || this.hidden) return;
    if (!this.cells.length || !this.texture) {
      this.maybeRun(f, 1e9);
      return;
    }
    const pxPerRad = f.heightPx / (2 * Math.tan(f.fovRad / 2));
    const half = Math.atan(Math.tan(f.fovRad / 2) * Math.hypot(1, f.aspect));
    const rel: [number, number, number] = [0, 0, 0];
    const data = this.texture.image.data as unknown as Float32Array;
    let nearest = 1e9, drawnPoints = 0;
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      const x = c.ax + f.sun[0] - f.origin.x, y = c.ay + f.sun[1] - f.origin.y, z = c.az + f.sun[2] - f.origin.z;
      this.rel[i * 3] = x; this.rel[i * 3 + 1] = y; this.rel[i * 3 + 2] = z;
      rel[0] = x; rel[1] = y; rel[2] = z;
      const dist = Math.hypot(x, y, z);
      const n = sphereInCone(rel, c.radiusKm, f.dir, half) ? cellDrawCount(c.count, c.radiusKm, dist, pxPerRad) : 0;
      this.drawn[i] = n;
      data[i * 4] = x; data[i * 4 + 1] = y; data[i * 4 + 2] = z;
      data[i * 4 + 3] = c.start + n;
      if (n > 0) {
        drawnPoints += n;
        // inside the cell's sphere the cell's surface says nothing: the nearest points are about one point spacing away
        nearest = Math.min(nearest, dist <= c.radiusKm ? Math.max(insideNearestKm(c.count, (2 * c.radiusKm) / Math.sqrt(3)), 1e5) : Math.max(dist - c.radiusKm, 1e5));
      }
    }
    this.texture.needsUpdate = true;
    this.stats.drawnPoints = drawnPoints;
    this.maybeRun(f, nearest);
  }

  private maybeRun(f: MinorFrame, nearestKm: number): void {
    if (!this.on || this.hidden || this.dead || !this.worker || !this.loaded) return;
    const t = this.now();
    if (t < this.retryAt) return;
    const due = rerunDue({
      simMs: f.simMs, atMs: this.atMs, nearestKm, fovRad: f.fovRad, viewportPx: f.heightPx,
      sinceLastMs: t - this.lastEndWall, lastPassMs: this.lastPassMs, running: this.running,
    });
    if (!due) return;
    this.running = true;
    this.seq++;
    this.post({ type: 'run', seq: this.seq, simMs: f.simMs });
  }

  /**
   * The drawn point nearest to the pick ray: its orbit (from the worker) through `onOrbit`, `true` when a point was hit. `dir` is the unit
   * ray through the cursor (camera-relative), `tanRadius` the pick radius as a tangent, `hidden` the scene's occlusion test (bodies and disc cones).
   */
  pick(dir: [number, number, number], tanRadius: number, hidden: (x: number, y: number, z: number) => boolean, onOrbit: (o: PickedOrbit | null) => void): boolean {
    if (!this.on || this.hidden || !this.cells.length) return false;
    const r = pickBelt({ cells: this.cells, offsets: this.offsets, drawn: this.drawn, rel: this.rel, dir, tan: tanRadius, hidden });
    if (r.slot < 0) return false;
    const req = ++this.req;
    this.reqs.set(req, onOrbit);
    this.post({ type: 'orbit', req, index: this.index[r.slot] });
    return true;
  }

  dispose(): void {
    this.abort.abort();
    this.worker?.terminate();
    this.geo?.dispose();
    this.texture?.dispose();
    this.material.dispose();
  }
}

/** The lightweight entity of a picked point: a keplerian provider round the Sun, nothing else. */
export function minorPlanetRecord(o: PickedOrbit, nowMs: number): EntityRecord {
  const epoch = new Date(o.epochMs).toISOString().slice(0, 10);
  return {
    id: `mpc-${o.designation.replace(/\s+/g, '-')}`,
    name: /^\d+$/.test(o.designation) ? `(${o.designation})` : o.designation,
    kind: 'asteroid',
    bodyId: 'SUN',
    aliases: { mpc: o.designation },
    group: MINOR_PLANET_GROUP,
    provider: { type: 'keplerian', bodyId: 'SUN', elements: o.elements },
    render: { colorKey: 'body' },
    attrs: {
      designation: o.designation,
      absoluteMagnitudeH: o.h,
      elementsEpoch: epoch,
      positionNote: `approximate (osculating elements at epoch ${epoch})`,
      source: 'Minor Planet Center (MPCORB)',
    },
    updatedAt: nowMs,
  };
}

export const MINOR_PLANET_GROUP = 'minor-planets';

/** What `classify()` is asked about the whole cloud: one record of the kind and group every minor planet entity has. */
export const MINOR_PLANET_PROBE: EntityRecord = {
  id: 'mpc-cloud', name: 'Minor planets', kind: 'asteroid', bodyId: 'SUN', aliases: {}, group: MINOR_PLANET_GROUP, updatedAt: 0,
};
