import * as THREE from 'three';
import type { EntityRecord } from '@eio/core';
import { sunInBody } from '../../lib/arrays';
import { basisToQuaternion, forwardBasis, lvlhBasis, rocketForward, sunlitFraction, type Basis } from '../../lib/attitude';
import type { V3 } from '../../lib/camera';
import { modelLod, ringHiddenFor } from '../../lib/model-lod';
import { modelDef } from './registry';
import type { ModelDef, ModelInstance, ModelUpdate } from './types';

const KM_PER_M = 1e-3;
/** Sun and earthshine strengths. three's lights give albedo * I * cos / pi, so PI is "full white at normal incidence". */
const SUN_I = 3.3;
const AMBIENT_I = 1.2;
const EARTHSHINE_I = 1.1;

export interface ModelFrame {
  /** simulation time, ms */
  t: number;
  /** logical camera position (float64 world, km) */
  camera: THREE.Vector3;
  fovRad: number;
  viewportPx: number;
  /** unit vector toward the Sun, inertial */
  sunDir: V3;
  /** cheap world position of an entity (point buffers); false when it has none */
  approx(id: string, out: THREE.Vector3): boolean;
  /** exact display position and velocity (km, km/s) at `t` */
  resolve(id: string, t: number): { r: V3; v?: V3 } | null;
  /** from the query (lib/query.ts `classify`) and HIGHLIGHT: `hide` = not drawn, `dim` = drawn dimmed */
  visibility(id: string): 'show' | 'dim' | 'hide';
  /** passes the scope policy (selection, related objects and filter exemptions included) */
  inScope(id: string): boolean;
  /** size of the entity's point sprite, CSS pixels */
  spritePx(id: string): number;
  /** measured attitude of the entity relative to LVLH as a quaternion [w, x, y, z] (body to LVLH), when one applies */
  attitude?(id: string): readonly number[] | undefined;
  /** joint angles (rad) for a model that has articulated parts, or undefined to leave them */
  joints?(id: string, def: ModelDef, t: number, sunBody: V3): Record<string, number> | undefined;
}

interface Entry {
  id: string;
  def: ModelDef;
  holder: THREE.Group;
  inst: ModelInstance | null;
  /** model is in the scene this frame */
  active: boolean;
  spriteHidden: boolean;
  ringHidden: boolean;
  screenPx: number;
  dim: boolean;
  /** camera-relative position, km (for picking) */
  rel: THREE.Vector3;
  /** lighting inputs from the last drawn frame */
  light: { sunlit: number; nadir: V3; day: number } | null;
}

/**
 * Draws 3D models for the few entities whose `render.model` names a registered builder, in the floating-origin pipeline:
 * positions are float64 on the CPU and the model is placed camera-relative (km), scaled from metres, and oriented from the
 * entity's state (LVLH for stations and satellites, velocity-aligned for stages). A model exists only while the camera is
 * within its LOD distance; with none in range the per-frame cost is one cheap distance test per model entity.
 */
export class ModelLayer {
  readonly group = new THREE.Group();
  private entries = new Map<string, Entry>();
  private sunLight = new THREE.DirectionalLight(0xfff4e4, SUN_I);
  private earthLight = new THREE.DirectionalLight(0x9cc4ff, 0);
  private ambient = new THREE.AmbientLight(0xaab8d8, AMBIENT_I);
  /** ids whose point sprite is replaced by the model / whose selection ring is hidden */
  readonly spriteHidden = new Set<string>();
  readonly ringHidden = new Set<string>();
  private tmp = new THREE.Vector3();
  private q = new THREE.Quaternion();

  constructor(scene: THREE.Scene) {
    this.group.add(this.sunLight, this.earthLight, this.ambient);
    scene.add(this.group);
  }

  /** Reconcile with the catalog: one entry per entity whose `render.model` is registered. */
  setEntities(recs: Iterable<EntityRecord>): void {
    const seen = new Set<string>();
    for (const rec of recs) {
      const def = modelDef(rec.render?.model);
      if (!def) continue;
      seen.add(rec.id);
      const have = this.entries.get(rec.id);
      if (have && have.def === def) continue;
      if (have) this.drop(have);
      const holder = new THREE.Group();
      holder.scale.setScalar(KM_PER_M);
      this.entries.set(rec.id, { id: rec.id, def, holder, inst: null, active: false, spriteHidden: false, ringHidden: false, screenPx: 0, dim: false, rel: new THREE.Vector3(), light: null });
    }
    for (const [id, e] of this.entries) if (!seen.has(id)) this.drop(e), this.entries.delete(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  defOf(id: string | null | undefined): ModelDef | undefined {
    return id ? this.entries.get(id)?.def : undefined;
  }

  /** Models currently drawn (for the HUD). */
  get activeIds(): string[] {
    return [...this.entries.values()].filter((e) => e.active).map((e) => e.id);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Update visibility, placement and pose. Returns true when the set of hidden sprites or rings changed. */
  update(f: ModelFrame): boolean {
    let changed = false;
    let lit: { dist: number; sunlit: number; nadir: V3; day: number } | null = null;
    for (const e of this.entries.values()) {
      const was = { sprite: e.spriteHidden, ring: e.ringHidden };
      this.step(e, f);
      if (e.active && e.light) {
        const d = e.rel.length();
        if (!lit || d < lit.dist) lit = { dist: d, ...e.light };
      }
      if (was.sprite !== e.spriteHidden) {
        changed = true;
        if (e.spriteHidden) this.spriteHidden.add(e.id);
        else this.spriteHidden.delete(e.id);
      }
      if (was.ring !== e.ringHidden) {
        if (e.ringHidden) this.ringHidden.add(e.id);
        else this.ringHidden.delete(e.id);
      }
    }
    this.group.visible = lit !== null;
    if (lit) {
      this.sunLight.position.set(f.sunDir[0], f.sunDir[1], f.sunDir[2]);
      this.sunLight.intensity = SUN_I * lit.sunlit;
      this.earthLight.position.set(lit.nadir[0], lit.nadir[1], lit.nadir[2]);
      this.earthLight.intensity = EARTHSHINE_I * lit.day;
    }
    return changed;
  }

  private step(e: Entry, f: ModelFrame): void {
    const off = () => {
      if (e.active) {
        this.group.remove(e.holder);
        e.active = false;
      }
      e.spriteHidden = false;
      e.ringHidden = false;
      e.screenPx = 0;
    };
    const lodKm = e.def.lodKm;
    if (!f.approx(e.id, this.tmp)) return off();
    const far = this.tmp.distanceTo(f.camera);
    if (far > lodKm * 1.5 && !e.active) return off(); // the common case: nothing to do
    const vis = f.visibility(e.id);
    if (vis === 'hide' || !f.inScope(e.id)) return off();
    const st = f.resolve(e.id, f.t);
    if (!st) return off();
    // camera-relative position in float64; only this small difference reaches the GPU
    e.rel.set(st.r[0] - f.camera.x, st.r[1] - f.camera.y, st.r[2] - f.camera.z);
    const lod = modelLod({
      distKm: e.rel.length(),
      diameterKm: 2 * e.def.radiusM * KM_PER_M,
      lodKm,
      fovRad: f.fovRad,
      viewportPx: f.viewportPx,
      spritePx: f.spritePx(e.id),
      wasModel: e.active,
      wasSpriteHidden: e.spriteHidden,
    });
    if (!lod.model) return off();

    if (!e.inst) e.inst = e.def.build();
    if (!e.active) {
      e.holder.add(e.inst.root);
      this.group.add(e.holder);
      e.active = true;
    }
    e.spriteHidden = lod.hideSprite;
    e.ringHidden = ringHiddenFor(lod.screenPx, e.ringHidden);
    e.screenPx = lod.screenPx;

    const basis = this.basisOf(e.def, st.r, st.v);
    // measured attitude relative to LVLH (body to LVLH, [w, x, y, z]), when the caller has a verified one
    const att = e.def.attitude === 'lvlh' ? f.attitude?.(e.id) : undefined;
    if (basis) {
      const [qx, qy, qz, qw] = basisToQuaternion(basis);
      e.holder.quaternion.set(qx, qy, qz, qw);
      if (att) e.holder.quaternion.multiply(this.q.set(att[1], att[2], att[3], att[0]));
    }
    e.holder.position.copy(e.rel);
    const rl = Math.hypot(st.r[0], st.r[1], st.r[2]) || 1;
    const nadir: V3 = [-st.r[0] / rl, -st.r[1] / rl, -st.r[2] / rl];
    e.light = { sunlit: sunlitFraction(st.r, f.sunDir), nadir, day: Math.max(0, -(nadir[0] * f.sunDir[0] + nadir[1] * f.sunDir[1] + nadir[2] * f.sunDir[2])) };
    const sunBody = basis ? sunInBody(basis, f.sunDir, att) : f.sunDir;
    const u: ModelUpdate = { sunBody, joints: f.joints?.(e.id, e.def, f.t, sunBody) };
    e.inst.update(u);
    const dim = vis === 'dim';
    if (dim !== e.dim) {
      e.dim = dim;
      e.inst.setDim(dim);
    }
  }

  /** Body basis of a model for an inertial state (km, km/s): LVLH, or velocity-aligned for rocket stages. */
  basisOf(def: ModelDef, r: V3, v?: V3): Basis | null {
    const vel: V3 = v ?? [-r[1], r[0], 0]; // no velocity: pretend a prograde equatorial direction
    if (def.attitude === 'rocket') {
      const fwd = rocketForward(r, vel);
      return fwd ? forwardBasis(fwd, r) : null;
    }
    return lvlhBasis(r, vel);
  }

  /** Nearest drawn model under the screen point, if any. `m` is projection * view (column-major elements). */
  pick(px: number, py: number, m: ArrayLike<number>, w: number, h: number, minRadiusPx: number): string | null {
    let best: { id: string; d2: number } | null = null;
    for (const e of this.entries.values()) {
      if (!e.active) continue;
      const { x, y, z } = e.rel;
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw <= 0) continue;
      const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw * 0.5 + 0.5) * w;
      const sy = (1 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / cw * 0.5 + 0.5)) * h;
      const rad = Math.max(minRadiusPx, e.screenPx / 2);
      const d2 = (sx - px) ** 2 + (sy - py) ** 2;
      if (d2 <= rad * rad && (!best || d2 < best.d2)) best = { id: e.id, d2 };
    }
    return best?.id ?? null;
  }

  /** Projected on-screen diameter of an entity's model while drawn, else 0. */
  screenPx(id: string): number {
    return this.entries.get(id)?.screenPx ?? 0;
  }

  /** Model-space joint names of the entity's model once built (for tests and tooling). */
  jointsOf(id: string): readonly string[] {
    return this.entries.get(id)?.inst?.joints ?? [];
  }

  private drop(e: Entry): void {
    this.group.remove(e.holder);
    this.spriteHidden.delete(e.id);
    this.ringHidden.delete(e.id);
    e.inst?.dispose();
    e.inst = null;
    e.active = false;
  }

  dispose(): void {
    for (const e of this.entries.values()) this.drop(e);
    this.entries.clear();
    this.group.removeFromParent();
  }
}
