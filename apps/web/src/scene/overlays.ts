import * as THREE from 'three';
import { EARTH, cross, fixedToGeodetic, geodeticToFixed, norm, type EntityGraph, type EntityRecord, type StateVector } from '@eio/core';
import { SHELL_THRESHOLD_KM } from '../lib/deepspace';
import { orbitPeriodSec } from '../lib/orbit';
import { RelPositions, type RenderFrame } from './relative';

const RE = EARTH.radiusKm;
const ORBIT_POINTS = 240;
const TRACK_POINTS = 160;
const TRAIL_POINTS = 56;
const FOOTPRINT_POINTS = 96;
/** Lines above the ground stay this far off it (the mesh is inscribed in the ellipsoid, so it never pokes above). */
const SURFACE_LIFT_KM = 0.5;
const DEFAULT_TRAIL_SEC = 900;

interface Line {
  obj: THREE.Line;
  pos: RelPositions;
  color: THREE.BufferAttribute | null;
  /** points currently drawn */
  n: number;
}

function makeLine<T extends THREE.Line>(Ctor: new (g: THREE.BufferGeometry, m: THREE.Material) => T, n: number, color: THREE.Color, opacity: number, fixed: boolean, vertexColors = false): Line {
  const pos = new RelPositions(n, fixed);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', pos.attr);
  let col: THREE.BufferAttribute | null = null;
  if (vertexColors) {
    col = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    g.setAttribute('color', col);
  }
  const m = new THREE.LineBasicMaterial({ color: vertexColors ? 0xffffff : color, vertexColors, transparent: true, opacity, depthWrite: false });
  const obj = new Ctor(g, m);
  obj.frustumCulled = false;
  obj.visible = false;
  return { obj, pos, color: col, n: 0 };
}

/**
 * Orbit line, trail, visibility footprint and ground track for one entity. All vertices are float64 world positions
 * re-based on the camera every frame (`uploadFrame`), so the lines do not wobble when the camera is metres from them.
 */
export class EntityOverlay {
  private readonly orbit: Line;
  private readonly trail: Line;
  private readonly footprint: Line;
  private readonly track: Line;
  private orbitT = -Infinity;
  private trackT = -Infinity;
  private orbitWall = -Infinity;
  private trackWall = -Infinity;
  private period: number | null = null;

  constructor(world: THREE.Object3D, private color: THREE.Color) {
    this.orbit = makeLine(THREE.Line, ORBIT_POINTS + 1, color, 0.55, false);
    this.trail = makeLine(THREE.Line, TRAIL_POINTS, color, 0.95, false, true);
    this.footprint = makeLine(THREE.LineLoop, FOOTPRINT_POINTS, color, 0.45, false);
    this.track = makeLine(THREE.Line, TRACK_POINTS, color, 0.9, true, true);
    this.footprint.n = FOOTPRINT_POINTS;
    world.add(this.orbit.obj, this.trail.obj, this.footprint.obj, this.track.obj);
  }

  /** True while this overlay draws a closed-orbit line (the path overlay stays out of the way then). */
  get hasOrbit(): boolean {
    return this.orbit.obj.visible;
  }

  dispose(): void {
    for (const l of [this.orbit, this.trail, this.footprint, this.track]) {
      l.obj.removeFromParent();
      l.obj.geometry.dispose();
      (l.obj.material as THREE.Material).dispose();
    }
  }

  /** Refill the GPU buffers relative to this frame's camera. Call once per frame after `update`. */
  uploadFrame(f: RenderFrame): void {
    for (const l of [this.orbit, this.trail, this.footprint, this.track]) if (l.obj.visible) l.pos.upload(f, l.n);
  }

  /** `full` adds trail and ground track (selected entity); otherwise orbit line and footprint only. */
  update(graph: EntityGraph, rec: EntityRecord, t: number, wall: number, full: boolean): void {
    const s = graph.stateIn(rec.id, t, 'EARTH:inertial');
    const r = s ? norm(s.r) : 0;
    const usable = !!s && r > RE + 50 && r < SHELL_THRESHOLD_KM;
    this.footprint.obj.visible = usable && (full || !!rec.render?.footprint);
    this.orbit.obj.visible = this.trail.obj.visible = this.track.obj.visible = false;
    if (!s || !usable) return;

    this.updateFootprint(s, r);
    const period = orbitPeriodSec(graph, rec, s);
    if (period !== this.period) {
      this.period = period;
      this.orbitT = this.trackT = -Infinity;
    }
    if (!period) return;

    // the orbit is a closed loop through the entity, so it stays valid until the entity has moved a fraction of a revolution
    if (Math.abs(t - this.orbitT) > (period * 1000) / 40 && wall - this.orbitWall > 200) {
      this.buildOrbit(graph, rec, t, period);
      this.orbitT = t;
      this.orbitWall = wall;
    }
    this.orbit.obj.visible = true;

    if (!full) return;
    this.updateTrail(graph, rec, t);
    if (Math.abs(t - this.trackT) > (period * 1000) / 80 || wall - this.trackWall > 3000) {
      this.buildTrack(graph, rec, t, period);
      this.trackT = t;
      this.trackWall = wall;
    }
    this.track.obj.visible = true;
  }

  private updateFootprint(s: StateVector, r: number): void {
    const lam = Math.acos(RE / r);
    const u = [s.r[0] / r, s.r[1] / r, s.r[2] / r] as [number, number, number];
    const e1 = cross(u, [0, 0, 1]);
    const n1 = norm(e1);
    const a = n1 < 1e-6 ? ([1, 0, 0] as [number, number, number]) : ([e1[0] / n1, e1[1] / n1, e1[2] / n1] as [number, number, number]);
    const b = cross(u, a);
    const pos = this.footprint.pos;
    const R = RE + SURFACE_LIFT_KM;
    for (let i = 0; i < FOOTPRINT_POINTS; i++) {
      const th = (i / FOOTPRINT_POINTS) * Math.PI * 2;
      const c = Math.cos(lam), sl = Math.sin(lam), ct = Math.cos(th), st = Math.sin(th);
      pos.setXYZ(i, R * (c * u[0] + sl * (ct * a[0] + st * b[0])), R * (c * u[1] + sl * (ct * a[1] + st * b[1])), R * (c * u[2] + sl * (ct * a[2] + st * b[2])));
    }
  }

  private buildOrbit(graph: EntityGraph, rec: EntityRecord, t: number, periodSec: number): void {
    const pos = this.orbit.pos;
    let n = 0;
    for (let i = 0; i <= ORBIT_POINTS; i++) {
      const s = graph.stateIn(rec.id, t + (i / ORBIT_POINTS) * periodSec * 1000, 'EARTH:inertial');
      if (s) pos.setXYZ(n++, s.r[0], s.r[1], s.r[2]);
    }
    this.orbit.n = n;
    this.orbit.obj.geometry.setDrawRange(0, n);
  }

  private updateTrail(graph: EntityGraph, rec: EntityRecord, t: number): void {
    const span = (rec.render?.trailSeconds ?? DEFAULT_TRAIL_SEC) * 1000;
    const pos = this.trail.pos, col = this.trail.color!;
    let n = 0;
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const f = i / (TRAIL_POINTS - 1);
      const s = graph.stateIn(rec.id, t - span * (1 - f), 'EARTH:inertial');
      if (!s) continue;
      const k = f * f;
      pos.setXYZ(n, s.r[0], s.r[1], s.r[2]);
      col.setXYZ(n++, this.color.r * k, this.color.g * k, this.color.b * k);
    }
    col.needsUpdate = true;
    this.trail.n = n;
    this.trail.obj.geometry.setDrawRange(0, n);
    this.trail.obj.visible = n > 1;
  }

  /** Sub-satellite path in Earth-fixed coordinates (rotated by the spin at upload time). */
  private buildTrack(graph: EntityGraph, rec: EntityRecord, t: number, periodSec: number): void {
    const span = Math.min(periodSec, 3 * 86400) * 1000;
    const t0 = t - 0.25 * span, t1 = t + 1.0 * span;
    const pos = this.track.pos, col = this.track.color!;
    let n = 0;
    for (let i = 0; i < TRACK_POINTS; i++) {
      const ts = t0 + (i / (TRACK_POINTS - 1)) * (t1 - t0);
      const s = graph.stateIn(rec.id, ts, 'EARTH:fixed');
      if (!s) continue;
      const g = fixedToGeodetic(s.r, EARTH);
      const p = geodeticToFixed({ lat: g.lat, lon: g.lon, alt: SURFACE_LIFT_KM }, EARTH);
      const k = ts < t ? 0.3 : 1 - 0.55 * ((ts - t) / (t1 - t));
      pos.setXYZ(n, p[0], p[1], p[2]);
      col.setXYZ(n++, this.color.r * k, this.color.g * k, this.color.b * k);
    }
    col.needsUpdate = true;
    this.track.n = n;
    this.track.obj.geometry.setDrawRange(0, n);
  }
}
