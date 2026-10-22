import * as THREE from 'three';
import type { EntityGraph, EntityRecord } from '@eio/core';
import {
  PATH_MAX_PHASES, makePathBuffers, nowIndex, pathStale, planPathWindow, samplePath, type PathPlan, type PathResult,
} from '../lib/paths';
import { GLYPH_ID } from './palette';

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
 * future, plus ticks at composite phase boundaries. Points come from `lib/paths.ts`; the two lines share one
 * position buffer and only their draw ranges move with the clock. Rebuilt only when the selection changes or
 * the time window has slid by a tenth of its length. Depth-tested like everything else, so the Earth hides the
 * far side of a path.
 */
export class PathOverlay {
  private readonly buf = makePathBuffers();
  private readonly position = new THREE.BufferAttribute(this.buf.pos, 3).setUsage(THREE.DynamicDrawUsage);
  private readonly past: THREE.Line;
  private readonly future: THREE.Line;
  private readonly ticks: THREE.Points;
  private readonly tickPos = new THREE.BufferAttribute(new Float32Array(PATH_MAX_PHASES * 3), 3);
  private readonly tickSize = new THREE.BufferAttribute(new Float32Array(PATH_MAX_PHASES), 1);
  private res: PathResult | null = null;
  private recKey: unknown = null;
  private builtAt = -Infinity;
  private builtWall = -Infinity;
  private parent: THREE.Object3D | null = null;
  private readonly tmp = new THREE.Vector3();

  constructor(private world: THREE.Object3D, private earth: THREE.Object3D, pointMaterial: THREE.Material, color: THREE.Color) {
    this.past = makeLine(this.position, color.clone().multiplyScalar(0.5), 0.6);
    this.future = makeLine(this.position, color.clone().lerp(new THREE.Color(1, 1, 1), 0.4), 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', this.tickPos);
    const col = new THREE.BufferAttribute(new Float32Array(PATH_MAX_PHASES * 3), 3);
    const glyph = new THREE.BufferAttribute(new Float32Array(PATH_MAX_PHASES).fill(GLYPH_ID.diamond), 1);
    const c = color.clone().lerp(new THREE.Color(1, 1, 1), 0.5);
    for (let i = 0; i < PATH_MAX_PHASES; i++) col.setXYZ(i, c.r, c.g, c.b);
    g.setAttribute('aColor', col);
    g.setAttribute('aGlyph', glyph);
    g.setAttribute('aSize', this.tickSize);
    this.ticks = new THREE.Points(g, pointMaterial);
    this.ticks.frustumCulled = false;
    this.ticks.renderOrder = 5;
    this.ticks.visible = false;
    for (const o of [this.past, this.future]) o.renderOrder = 3;
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

  /** Update for sim time `t`. `orbitHandled`: the entity already has the closed-orbit line/trail, so no path. */
  update(graph: EntityGraph, rec: EntityRecord, t: number, wall: number, orbitHandled: boolean): PathStatus {
    if (orbitHandled) return this.hide();
    const provider = graph.provider(rec.id);
    const key = rec.provider;
    const plan = planPathWindow(rec.provider, t, { validRange: provider?.validRange, trailSeconds: rec.render?.trailSeconds });
    if (!plan) return this.hide();

    if (key !== this.recKey || (pathStale(this.builtAt, t, this.res?.plan ?? plan) && wall - this.builtWall > MIN_REBUILD_WALL_MS)) {
      this.res = samplePath(graph, rec.id, plan, rec.provider, this.buf);
      this.recKey = key;
      this.builtAt = t;
      this.builtWall = wall;
      this.position.needsUpdate = true;
      this.attach(this.res.frame === 'fixed' ? this.earth : this.world);
      this.fillTicks(this.res);
    }
    const res = this.res;
    if (!res || res.count < 2 || !res.moving) return this.hide();

    const k = nowIndex(this.buf.times, res.count, t);
    this.past.visible = k >= 1;
    this.past.geometry.setDrawRange(0, Math.max(0, k + 1));
    this.future.visible = k < res.count - 1;
    const from = Math.max(0, k);
    this.future.geometry.setDrawRange(from, res.count - from);
    this.ticks.visible = res.phases.length > 0;
    return { active: true, compressed: res.compressed, frame: res.frame, plan: res.plan };
  }

  /** Visit every path point in world space (for FIT). The Earth group's matrix must be current. */
  worldPoints(visit: (x: number, y: number, z: number) => void): void {
    const res = this.res;
    if (!res || !this.past.visible && !this.future.visible) return;
    const fixed = res.frame === 'fixed';
    const step = Math.max(1, Math.floor(res.count / 120));
    for (let i = 0; i < res.count; i += step) {
      this.tmp.set(this.buf.pos[i * 3], this.buf.pos[i * 3 + 1], this.buf.pos[i * 3 + 2]);
      if (fixed) this.earth.localToWorld(this.tmp);
      visit(this.tmp.x, this.tmp.y, this.tmp.z);
    }
  }

  /** Phase labels with world positions, for the HTML label layer. */
  phaseLabels(): { text: string; x: number; y: number; z: number }[] {
    const res = this.res;
    if (!res || !this.ticks.visible) return [];
    return res.phases.map((p) => {
      this.tmp.set(this.buf.pos[p.index * 3], this.buf.pos[p.index * 3 + 1], this.buf.pos[p.index * 3 + 2]);
      if (res.frame === 'fixed') this.earth.localToWorld(this.tmp);
      return { text: p.name, x: this.tmp.x, y: this.tmp.y, z: this.tmp.z };
    });
  }

  private fillTicks(res: PathResult): void {
    for (let i = 0; i < PATH_MAX_PHASES; i++) {
      const p = res.phases[i];
      if (p) this.tickPos.setXYZ(i, this.buf.pos[p.index * 3], this.buf.pos[p.index * 3 + 1], this.buf.pos[p.index * 3 + 2]);
      this.tickSize.setX(i, p ? 8 : 0);
    }
    this.tickPos.needsUpdate = this.tickSize.needsUpdate = true;
  }

  private attach(parent: THREE.Object3D): void {
    if (this.parent === parent) return;
    this.parent = parent;
    parent.add(this.past, this.future, this.ticks);
  }

  private hide(): PathStatus {
    this.past.visible = this.future.visible = this.ticks.visible = false;
    return OFF;
  }
}
