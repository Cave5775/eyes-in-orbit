import * as THREE from 'three';
import type { EntityGraph, EntityRecord, Vec3 } from '@eio/core';
import type { DistanceScale } from '../lib/deepspace';
import { fixedToInertial, type Spin } from '../lib/floating-origin';
import { EARTH_CENTRE, centrePositionEci, frameForRec, frameSampler, graphLookup, type Centre } from '../lib/frame';
import {
  PATH_MAX_PHASES, makePathBuffers, nowIndex, pathStale, planPathWindow, samplePath, type PathPlan, type PathResult,
} from '../lib/paths';
import { SHOW_EXEMPT } from '../lib/pick';
import { GLYPH_ID } from './palette';
import { RelPositions, type RenderFrame } from './relative';

const MIN_REBUILD_WALL_MS = 150;

export interface PathStatus {
  /** a path is currently drawn */
  active: boolean;
  /** drawn on the compressed deep-space shell (not to scale) */
  compressed: boolean;
  frame: 'fixed' | 'inertial';
  plan: PathPlan | null;
}

const OFF: PathStatus = { active: false, compressed: false, frame: 'inertial', plan: null };

function makeLine(position: THREE.BufferAttribute, color: THREE.Color, opacity: number): THREE.Line {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', position);
  const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  line.frustumCulled = false;
  line.visible = false;
  return line;
}

/**
 * Trajectory line of the selected non-SGP4 entity: dimmer solid line for the past, brighter for the predicted
 * future, plus ticks at composite phase boundaries. Points come from `lib/paths.ts` (float64); the two lines share one
 * position buffer and only their draw ranges move with the clock. Rebuilt only when the selection changes, the distance
 * scale changes or the time window has slid by a tenth of its length. The GPU copy is re-based on the camera every
 * frame (`uploadFrame`), and a path sampled in the Earth-fixed frame is rotated by the Earth's spin at that moment, so
 * it stays glued to the ground without a rotating parent object. Depth-tested like everything else, so the Earth hides
 * the far side of a path.
 */
export class PathOverlay {
  private readonly buf = makePathBuffers();
  private readonly line = new RelPositions(this.buf.pos, false);
  private readonly past: THREE.Line;
  private readonly future: THREE.Line;
  private readonly ticks: THREE.Points;
  private readonly tickPos = new RelPositions(PATH_MAX_PHASES, false);
  private readonly tickSize = new THREE.BufferAttribute(new Float32Array(PATH_MAX_PHASES), 1);
  private res: PathResult | null = null;
  private recKey: unknown = null;
  private builtAt = -Infinity;
  private builtWall = -Infinity;
  private builtScale: DistanceScale | null = null;
  private builtCentre = '';
  /** how far the frame centre has moved since the buffers were filled, km (world space) */
  private shift: Vec3 = [0, 0, 0];
  private readonly tmp = new THREE.Vector3();
  private readonly colors: { past: THREE.Color; pastHot: THREE.Color; future: THREE.Color; futureHot: THREE.Color };
  private hot = false;

  constructor(private world: THREE.Object3D, pointMaterial: THREE.Material, color: THREE.Color) {
    this.colors = {
      past: color.clone().multiplyScalar(0.5), pastHot: color.clone().lerp(new THREE.Color(1, 1, 1), 0.2),
      future: color.clone().lerp(new THREE.Color(1, 1, 1), 0.4), futureHot: new THREE.Color(1, 1, 1),
    };
    this.past = makeLine(this.line.attr, this.colors.past.clone(), 0.6);
    this.future = makeLine(this.line.attr, this.colors.future.clone(), 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', this.tickPos.attr);
    const col = new THREE.BufferAttribute(new Float32Array(PATH_MAX_PHASES * 3), 3);
    const glyph = new THREE.BufferAttribute(new Float32Array(PATH_MAX_PHASES).fill(GLYPH_ID.diamond), 1);
    const show = new THREE.BufferAttribute(new Float32Array(PATH_MAX_PHASES).fill(SHOW_EXEMPT), 1); // the selected path's ticks are never hidden over a small body
    const c = color.clone().lerp(new THREE.Color(1, 1, 1), 0.5);
    for (let i = 0; i < PATH_MAX_PHASES; i++) col.setXYZ(i, c.r, c.g, c.b);
    g.setAttribute('aColor', col);
    g.setAttribute('aGlyph', glyph);
    g.setAttribute('aSize', this.tickSize);
    g.setAttribute('aShow', show);
    this.ticks = new THREE.Points(g, pointMaterial);
    this.ticks.frustumCulled = false;
    this.ticks.renderOrder = 5;
    this.ticks.visible = false;
    for (const o of [this.past, this.future]) o.renderOrder = 3;
    world.add(this.past, this.future, this.ticks);
    this.hide();
  }

  dispose(): void {
    for (const o of [this.past, this.future, this.ticks]) {
      o.removeFromParent();
      o.geometry.dispose();
    }
    (this.past.material as THREE.Material).dispose();
    (this.future.material as THREE.Material).dispose();
  }

  /**
   * Update for sim time `t`. `orbitHandled`: the entity already has the closed-orbit line/trail, so no path. `centre`:
   * the frame of reference; the path is sampled relative to it (see lib/frame.ts) and rebuilt when it changes.
   */
  update(
    graph: EntityGraph, rec: EntityRecord, t: number, wall: number, orbitHandled: boolean, scale: DistanceScale = 'compressed',
    centre: Centre = EARTH_CENTRE,
  ): PathStatus {
    if (orbitHandled) return this.hide();
    centre = frameForRec(centre, rec);
    const provider = graph.provider(rec.id);
    const key = rec.provider;
    const plan = planPathWindow(rec.provider, t, { validRange: provider?.validRange, trailSeconds: rec.render?.trailSeconds });
    if (!plan) return this.hide();

    if (key !== this.recKey || scale !== this.builtScale || centre !== this.builtCentre || (pathStale(this.builtAt, t, this.res?.plan ?? plan) && wall - this.builtWall > MIN_REBUILD_WALL_MS)) {
      const lookup = graphLookup(graph);
      this.res = samplePath(graph, rec.id, plan, rec.provider, this.buf, scale, frameSampler(centre, t, lookup));
      this.recKey = key;
      this.builtScale = scale;
      this.builtCentre = centre;
      this.builtAt = t;
      this.builtWall = wall;
      this.line.fixed = this.tickPos.fixed = this.res.frame === 'fixed';
      this.line.count = this.res.count;
      this.fillTicks(this.res);
    }
    const res = this.res;
    if (!res || res.count < 2 || !res.moving) return this.hide();
    // the centre has moved since the path was built: shift the whole path with it (a translation, no rebuild)
    this.shift = [0, 0, 0];
    if (res.centreRef) {
      const c = centrePositionEci(centre, t, graphLookup(graph));
      if (!c) return this.hide();
      this.shift = [c[0] - res.centreRef[0], c[1] - res.centreRef[1], c[2] - res.centreRef[2]];
    }
    this.line.shift = this.tickPos.shift = this.shift;

    const k = nowIndex(this.buf.times, res.count, t);
    this.past.visible = k >= 1;
    this.past.geometry.setDrawRange(0, Math.max(0, k + 1));
    this.future.visible = k < res.count - 1;
    const from = Math.max(0, k);
    this.future.geometry.setDrawRange(from, res.count - from);
    this.ticks.visible = res.phases.length > 0;
    return { active: true, compressed: res.compressed, frame: res.frame, plan: res.plan };
  }

  /** Refill the GPU buffers relative to this frame's camera. Call once per frame after `update`. */
  uploadFrame(f: RenderFrame): void {
    if (this.past.visible || this.future.visible) this.line.upload(f, this.res?.count ?? 0);
    if (this.ticks.visible) this.tickPos.upload(f, PATH_MAX_PHASES);
  }

  /** Visit every path point in world space, float64 (for FIT). */
  worldPoints(spin: Spin, visit: (x: number, y: number, z: number) => void): void {
    const res = this.res;
    if (!res || (!this.past.visible && !this.future.visible)) return;
    const fixed = res.frame === 'fixed';
    const step = Math.max(1, Math.floor(res.count / 120));
    const p: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < res.count; i += step) {
      const x = this.buf.pos[i * 3], y = this.buf.pos[i * 3 + 1], z = this.buf.pos[i * 3 + 2];
      if (fixed) {
        fixedToInertial([x, y, z], spin, p);
        visit(p[0], p[1], p[2]);
      } else visit(x + this.shift[0], y + this.shift[1], z + this.shift[2]);
    }
  }

  /**
   * The drawn path as last uploaded, for hit-testing (lib/path-pick.ts): camera-relative xyz (the exact buffer the GPU draws,
   * so it already carries the spin / frame shift that `worldPoints` applies) and the ascending sample times, ms. Valid after
   * `uploadFrame`. Null unless a planned flight is drawn (a launch ascent or booster return: its times are real and fixed),
   * so the paths of probes, trails and other windows around "now" are not clickable.
   */
  pickSamples(): { rel: Float32Array; times: Float64Array; count: number } | null {
    const res = this.res;
    if (!res || !res.plan.anchored || res.count < 2 || !(this.past.visible || this.future.visible)) return null;
    return { rel: this.line.attr.array as Float32Array, times: this.buf.times, count: res.count };
  }

  /** Brighten the whole line while the cursor is on it. */
  setHighlight(on: boolean): void {
    if (on === this.hot) return;
    this.hot = on;
    const c = this.colors;
    (this.past.material as THREE.LineBasicMaterial).color.copy(on ? c.pastHot : c.past);
    (this.past.material as THREE.LineBasicMaterial).opacity = on ? 1 : 0.6;
    (this.future.material as THREE.LineBasicMaterial).color.copy(on ? c.futureHot : c.future);
  }

  /** Phase labels with world positions (float64), for the HTML label layer. */
  phaseLabels(spin: Spin): { text: string; x: number; y: number; z: number }[] {
    const res = this.res;
    if (!res || !this.ticks.visible) return [];
    return res.phases.map((p) => {
      const o = p.index * 3;
      const v = this.tmp.set(this.buf.pos[o], this.buf.pos[o + 1], this.buf.pos[o + 2]);
      if (res.frame === 'fixed') this.tmp.set(spin.cos * v.x - spin.sin * v.y, spin.sin * v.x + spin.cos * v.y, v.z);
      else this.tmp.set(v.x + this.shift[0], v.y + this.shift[1], v.z + this.shift[2]);
      return { text: p.name, x: this.tmp.x, y: this.tmp.y, z: this.tmp.z };
    });
  }

  private fillTicks(res: PathResult): void {
    for (let i = 0; i < PATH_MAX_PHASES; i++) {
      const p = res.phases[i];
      if (p) this.tickPos.setXYZ(i, this.buf.pos[p.index * 3], this.buf.pos[p.index * 3 + 1], this.buf.pos[p.index * 3 + 2]);
      this.tickSize.setX(i, p ? 8 : 0);
    }
    this.tickSize.needsUpdate = true;
  }

  private hide(): PathStatus {
    this.past.visible = this.future.visible = this.ticks.visible = false;
    return OFF;
  }
}
