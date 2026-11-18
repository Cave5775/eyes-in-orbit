import * as THREE from 'three';
import { readContainer, type EntityRecord } from '@eio/core';
import type { Api, MinorPlanetIndex } from '../api/types';
import {
  cellDrawCount, pickBelt, rerunDue, sphereInCone, type BeltCell, type PickedOrbit,
} from '../lib/minor-planets';
import type { MpFromWorker, MpToWorker } from '../workers/minor-planets.protocol';
import { createMinorPlanetMaterial } from './materials';

/**
 * The minor planet point cloud (MPC MPCORB, ~1.4 million orbits, server route `GET /api/minor-planets`): chunks by H are fetched brightest
 * first and handed to a worker that propagates them in float64 and bins them into cells (lib/minor-planets.ts, docs/frames.md "Cell anchors").
 * Per cell there is one `THREE.Points` whose `position` is the float32 offset from the cell anchor and whose `uOffset` (anchor + Sun - camera,
 * float64, set per frame in `onBeforeRender`) places it: buffers are uploaded only when the worker answers, a frame costs one 3-vector per cell.
 * Level of detail: a cell far away or small on screen draws only its brightest points (`cellDrawCount`), one off the screen not at all.
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

export class MinorPlanetLayer {
  readonly group = new THREE.Group();
  private material: THREE.ShaderMaterial;
  private worker: Worker | null = null;
  private points: THREE.Points[] = [];
  private cells: BeltCell[] = [];
  private offsets: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private index: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
  private rel = new Float64Array(0);
  private drawn = new Int32Array(0);
  private on = true;
  private loadStarted = false;
  private loaded = 0;
  private info: MinorPlanetIndex | null = null;
  /** sim time of the positions on show (null: none) and of the pass in flight */
  private atMs: number | null = null;
  private running = false;
  private seq = 0;
  private lastEndWall = 0;
  private nearestKm = 1e9;
  private reqs = new Map<number, (o: PickedOrbit | null) => void>();
  private req = 0;
  /** passes run and the last one's time and size (debug, the perf overlay) */
  readonly stats = { passes: 0, lastMs: 0, points: 0, cells: 0, drawnPoints: 0, chunks: 0, loading: false, error: '' };

  constructor(scene: THREE.Scene, shared: Record<string, THREE.IUniform>, pixelRatio: number) {
    this.material = createMinorPlanetMaterial(shared, pixelRatio);
    this.group.visible = this.on;
    scene.add(this.group);
  }

  /** The server's index (count, credit), once loaded. */
  get catalogInfo(): MinorPlanetIndex | null {
    return this.info;
  }

  setEnabled(on: boolean): void {
    this.on = on;
    this.group.visible = on;
  }

  get enabled(): boolean {
    return this.on;
  }

  private post(m: MpToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(m, transfer);
  }

  /** Fetch the index and the chunks (brightest first) once; each chunk goes to the worker and triggers a pass. Quiet when the server has none. */
  load(getApi: () => Api): void {
    if (this.loadStarted) return;
    this.loadStarted = true;
    this.worker = new Worker(new URL('../workers/minor-planets.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<MpFromWorker>) => this.onMessage(ev.data);
    this.stats.loading = true;
    void (async () => {
      try {
        // the data source may still change (the mock replaces the REST client when the server is unreachable) and the server may not have
        // downloaded the file yet (its first download takes minutes): ask again after 5 s, 15 s, 1 min, then every 5 min, six times in all
        let idx: MinorPlanetIndex | null = null;
        for (const wait of [0, 5_000, 15_000, 60_000, 300_000, 300_000]) {
          if (wait) await new Promise((r) => setTimeout(r, wait));
          idx = await getApi().minorPlanetIndex();
          if (idx && idx.count) break;
        }
        if (!idx || !idx.count) return;
        const api = getApi();
        this.info = idx;
        for (const c of idx.chunks) {
          const bytes = await api.minorPlanetChunk(c.chunk);
          readContainer(bytes); // throws on a foreign body before the worker holds it
          this.post({ type: 'chunk', bytes }, [bytes.buffer]);
          this.loaded += c.count;
          this.stats.chunks++;
          this.atMs = null; // new orbits: the next frame asks for a pass
        }
      } catch (err) {
        this.stats.error = (err as Error).message;
      } finally {
        this.stats.loading = false;
      }
    })();
  }

  private onMessage(m: MpFromWorker): void {
    if (m.type === 'orbit') {
      this.reqs.get(m.req)?.(m.orbit);
      this.reqs.delete(m.req);
      return;
    }
    this.running = false;
    this.lastEndWall = performance.now();
    if (m.seq !== this.seq) return;
    this.atMs = m.simMs;
    this.stats.passes++;
    this.stats.lastMs = m.ms;
    this.stats.points = m.total;
    this.stats.cells = m.cells.length;
    this.install(m.cells, m.offsets, m.h, m.index);
  }

  /** One `THREE.Points` per cell over its slice of the buffers; the old ones are released. */
  private install(cells: BeltCell[], offsets: Float32Array, h: Uint16Array, index: Uint32Array): void {
    for (const p of this.points) {
      this.group.remove(p);
      p.geometry.dispose();
    }
    this.cells = cells;
    this.offsets = offsets;
    this.index = index;
    this.rel = new Float64Array(cells.length * 3);
    this.drawn = new Int32Array(cells.length);
    this.points = cells.map((c, i) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(offsets.subarray(c.start * 3, (c.start + c.count) * 3), 3));
      geo.setAttribute('aH', new THREE.BufferAttribute(h.subarray(c.start, c.start + c.count), 1));
      geo.setDrawRange(0, 0);
      const pts = new THREE.Points(geo, this.material);
      pts.frustumCulled = false;
      pts.visible = false;
      pts.onBeforeRender = () => {
        (this.material.uniforms.uOffset.value as THREE.Vector3).set(this.rel[i * 3], this.rel[i * 3 + 1], this.rel[i * 3 + 2]);
        this.material.uniformsNeedUpdate = true;
      };
      this.group.add(pts);
      return pts;
    });
  }

  /** Per frame, before the render: cell offsets in float64, level of detail and culling, and a new pass when the positions are visibly old. */
  update(f: MinorFrame): void {
    if (!this.on || !this.cells.length) {
      this.maybeRun(f, 1e9);
      return;
    }
    const pxPerRad = f.heightPx / (2 * Math.tan(f.fovRad / 2));
    const half = Math.atan(Math.tan(f.fovRad / 2) * Math.hypot(1, f.aspect));
    const rel: [number, number, number] = [0, 0, 0];
    let nearest = 1e9, drawnPoints = 0;
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      const x = c.ax + f.sun[0] - f.origin.x, y = c.ay + f.sun[1] - f.origin.y, z = c.az + f.sun[2] - f.origin.z;
      this.rel[i * 3] = x; this.rel[i * 3 + 1] = y; this.rel[i * 3 + 2] = z;
      rel[0] = x; rel[1] = y; rel[2] = z;
      const dist = Math.hypot(x, y, z);
      const n = sphereInCone(rel, c.radiusKm, f.dir, half) ? cellDrawCount(c.count, c.radiusKm, dist, pxPerRad) : 0;
      this.drawn[i] = n;
      const p = this.points[i];
      p.visible = n > 0;
      if (n > 0) {
        p.geometry.setDrawRange(0, n);
        drawnPoints += n;
        nearest = Math.min(nearest, Math.max(dist - c.radiusKm, 1e5));
      }
    }
    this.stats.drawnPoints = drawnPoints;
    this.maybeRun(f, nearest);
  }

  private maybeRun(f: MinorFrame, nearestKm: number): void {
    if (!this.on || !this.worker || !this.loaded) return;
    this.nearestKm = nearestKm;
    const due = rerunDue({
      simMs: f.simMs, atMs: this.atMs, nearestKm, fovRad: f.fovRad, viewportPx: f.heightPx,
      sinceLastMs: performance.now() - this.lastEndWall, running: this.running,
    });
    if (!due) return;
    this.running = true;
    this.seq++;
    this.post({ type: 'run', seq: this.seq, simMs: f.simMs });
  }

  /**
   * The drawn point nearest to the pick ray: its orbit (from the worker) through `onOrbit`, `true` when a point was hit. `dir` is the unit
   * ray through the cursor (camera-relative), `tanRadius` the pick radius as a tangent, `hidden` the scene's occlusion test.
   */
  pick(dir: [number, number, number], tanRadius: number, hidden: (x: number, y: number, z: number) => boolean, onOrbit: (o: PickedOrbit | null) => void): boolean {
    if (!this.on || !this.cells.length) return false;
    const r = pickBelt({ cells: this.cells, offsets: this.offsets, drawn: this.drawn, rel: this.rel, dir, tan: tanRadius, hidden });
    if (r.slot < 0) return false;
    const req = ++this.req;
    this.reqs.set(req, onOrbit);
    this.post({ type: 'orbit', req, index: this.index[r.slot] });
    return true;
  }

  dispose(): void {
    this.worker?.terminate();
    for (const p of this.points) p.geometry.dispose();
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
    group: 'minor-planets',
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
