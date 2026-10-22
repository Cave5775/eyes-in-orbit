import * as THREE from 'three';
import { EARTH, cross, fixedToGeodetic, geodeticToFixed, norm, type EntityGraph, type EntityRecord, type StateVector } from '@eio/core';
import { SHELL_THRESHOLD_KM } from '../lib/deepspace';
import { orbitPeriodSec } from '../lib/orbit';

const RE = EARTH.radiusKm;
const ORBIT_POINTS = 240;
const TRACK_POINTS = 160;
const TRAIL_POINTS = 56;
const FOOTPRINT_POINTS = 96;
const SURFACE_LIFT_KM = 10;
const DEFAULT_TRAIL_SEC = 900;

function makeLine<T extends THREE.Line>(Ctor: new (g: THREE.BufferGeometry, m: THREE.Material) => T, n: number, color: THREE.Color, opacity: number, vertexColors = false): T {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  if (vertexColors) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const m = new THREE.LineBasicMaterial({ color: vertexColors ? 0xffffff : color, vertexColors, transparent: true, opacity, depthWrite: false });
  const line = new Ctor(g, m);
  line.frustumCulled = false;
  line.visible = false;
  return line;
}

const posOf = (l: THREE.Line) => l.geometry.getAttribute('position') as THREE.BufferAttribute;
const colOf = (l: THREE.Line) => l.geometry.getAttribute('color') as THREE.BufferAttribute;

/** Orbit line, trail, visibility footprint and ground track for one entity. */
export class EntityOverlay {
  private readonly orbit: THREE.Line;
  private readonly trail: THREE.Line;
  private readonly footprint: THREE.LineLoop;
  private readonly track: THREE.Line;
  private orbitT = -Infinity;
  private trackT = -Infinity;
  private orbitWall = -Infinity;
  private trackWall = -Infinity;
  private period: number | null = null;

  constructor(world: THREE.Object3D, earth: THREE.Object3D, private color: THREE.Color) {
    this.orbit = makeLine(THREE.Line, ORBIT_POINTS + 1, color, 0.55);
    this.trail = makeLine(THREE.Line, TRAIL_POINTS, color, 0.95, true);
    this.footprint = makeLine(THREE.LineLoop, FOOTPRINT_POINTS, color, 0.45);
    this.track = makeLine(THREE.Line, TRACK_POINTS, color, 0.9, true);
    world.add(this.orbit, this.trail, this.footprint);
    earth.add(this.track);
  }

  dispose(): void {
    for (const o of [this.orbit, this.trail, this.footprint, this.track]) {
      o.removeFromParent();
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }

  /** `full` adds trail and ground track (selected entity); otherwise orbit line and footprint only. */
  update(graph: EntityGraph, rec: EntityRecord, t: number, wall: number, full: boolean): void {
    const s = graph.stateIn(rec.id, t, 'EARTH:inertial');
    const r = s ? norm(s.r) : 0;
    const usable = !!s && r > RE + 50 && r < SHELL_THRESHOLD_KM;
    this.footprint.visible = usable && (full || !!rec.render?.footprint);
    this.orbit.visible = this.trail.visible = this.track.visible = false;
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
    this.orbit.visible = true;

    if (!full) return;
    this.updateTrail(graph, rec, t);
    if (Math.abs(t - this.trackT) > (period * 1000) / 80 || wall - this.trackWall > 3000) {
      this.buildTrack(graph, rec, t, period);
      this.trackT = t;
      this.trackWall = wall;
    }
    this.track.visible = true;
  }

  private updateFootprint(s: StateVector, r: number): void {
    const lam = Math.acos(RE / r);
    const u = [s.r[0] / r, s.r[1] / r, s.r[2] / r] as [number, number, number];
    const e1 = cross(u, [0, 0, 1]);
    const n1 = norm(e1);
    const a = n1 < 1e-6 ? ([1, 0, 0] as [number, number, number]) : ([e1[0] / n1, e1[1] / n1, e1[2] / n1] as [number, number, number]);
    const b = cross(u, a);
    const pos = posOf(this.footprint);
    const R = RE + 4;
    for (let i = 0; i < FOOTPRINT_POINTS; i++) {
      const th = (i / FOOTPRINT_POINTS) * Math.PI * 2;
      const c = Math.cos(lam), sl = Math.sin(lam), ct = Math.cos(th), st = Math.sin(th);
      pos.setXYZ(i, R * (c * u[0] + sl * (ct * a[0] + st * b[0])), R * (c * u[1] + sl * (ct * a[1] + st * b[1])), R * (c * u[2] + sl * (ct * a[2] + st * b[2])));
    }
    pos.needsUpdate = true;
  }

  private buildOrbit(graph: EntityGraph, rec: EntityRecord, t: number, periodSec: number): void {
    const pos = posOf(this.orbit);
    let n = 0;
    for (let i = 0; i <= ORBIT_POINTS; i++) {
      const s = graph.stateIn(rec.id, t + (i / ORBIT_POINTS) * periodSec * 1000, 'EARTH:inertial');
      if (s) pos.setXYZ(n++, s.r[0], s.r[1], s.r[2]);
    }
    pos.needsUpdate = true;
    this.orbit.geometry.setDrawRange(0, n);
  }

  private updateTrail(graph: EntityGraph, rec: EntityRecord, t: number): void {
    const span = (rec.render?.trailSeconds ?? DEFAULT_TRAIL_SEC) * 1000;
    const pos = posOf(this.trail), col = colOf(this.trail);
    let n = 0;
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const f = i / (TRAIL_POINTS - 1);
      const s = graph.stateIn(rec.id, t - span * (1 - f), 'EARTH:inertial');
      if (!s) continue;
      const k = f * f;
      pos.setXYZ(n, s.r[0], s.r[1], s.r[2]);
      col.setXYZ(n++, this.color.r * k, this.color.g * k, this.color.b * k);
    }
    pos.needsUpdate = col.needsUpdate = true;
    this.trail.geometry.setDrawRange(0, n);
    this.trail.visible = n > 1;
  }

  /** Sub-satellite path in Earth-fixed coordinates; lives in the rotating Earth group. */
  private buildTrack(graph: EntityGraph, rec: EntityRecord, t: number, periodSec: number): void {
    const span = Math.min(periodSec, 3 * 86400) * 1000;
    const t0 = t - 0.25 * span, t1 = t + 1.0 * span;
    const pos = posOf(this.track), col = colOf(this.track);
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
    pos.needsUpdate = col.needsUpdate = true;
    this.track.geometry.setDrawRange(0, n);
  }
}
