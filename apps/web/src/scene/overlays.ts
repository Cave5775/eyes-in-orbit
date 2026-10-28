import * as THREE from 'three';
import { EARTH, bodyEntityId, cross, fixedToGeodetic, geodeticToFixed, norm, type EntityGraph, type EntityRecord, type StateVector, type Vec3 } from '@eio/core';
import { dimmed } from '../lib/dim';
import {
  EARTH_CENTRE, centrePositionEci, framePathPoint, frameForRec, frameSampler, graphLookup, type Centre, type EntityLookup, type FrameSampler,
} from '../lib/frame';
import { chordSagKm } from '../lib/occlusion';
import { orbitPeriodSec } from '../lib/orbit';
import type { OrbitRole } from '../lib/orbit-lines';
import { NEAR_EARTH_LIMIT_KM } from '../lib/ref-body';
import { RelPositions, type RenderFrame } from './relative';

const RE = EARTH.radiusKm;
const ORBIT_POINTS = 240;
const TRACK_POINTS = 160;
const TRAIL_POINTS = 56;
const FOOTPRINT_POINTS = 96;
/** Lines above the ground stay this far off it (the mesh is inscribed in the ellipsoid, so it never pokes above). */
const SURFACE_LIFT_KM = 0.5;
const DEFAULT_TRAIL_SEC = 900;
/** Opacity of an orbit line. The selected entity's line is drawn in its colour, a child's dimmed (colour times `DIM.colour`, lib/dim.ts). */
const ORBIT_ALPHA = 0.9;
/** A trail never covers more than this fraction of a revolution, so it stays a tail and never turns into a second ellipse. */
const TRAIL_MAX_REVOLUTION = 1 / 6;

const ZERO3: readonly [number, number, number] = [0, 0, 0];

/**
 * How far the centre has moved since `ref` (its position when a line was built around it), km; zero when it has no position.
 */
function centreShift(centre: Centre, t: number, lookup: EntityLookup, ref: Vec3): [number, number, number] {
  const c = centrePositionEci(centre, t, lookup);
  return c ? [c[0] - ref[0], c[1] - ref[1], c[2] - ref[2]] : [0, 0, 0];
}

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
 * The role says how much is drawn (lib/orbit-lines.ts): the SELECTED entity gets everything, a CHILD of the selection only
 * its dimmed orbit line.
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
  private role: OrbitRole | null = null;
  /** frame centre (key) the orbit line was built for, and where that centre was then (Earth-inertial, km) */
  private centreKeyBuilt = '';
  private orbitRef: Vec3 | null = null;

  constructor(world: THREE.Object3D, private color: THREE.Color) {
    this.orbit = makeLine(THREE.Line, ORBIT_POINTS + 1, color, ORBIT_ALPHA, false);
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

  /**
   * The orbit LINE is the orbit round what the object orbits, whatever the frame is (orbit-line rule, docs/frames.md): its
   * primary body (a body entity's parent). A `child` draws nothing else. The `selected` entity adds its footprint and ground
   * track (Earth surface features of an Earth satellite, they ignore the frame) and its trail: the tail of its motion seen
   * from the frame of reference `centre` (lib/frame.ts), drawn only when that frame is not the primary body itself, where the
   * tail would just lie on the orbit line.
   */
  update(graph: EntityGraph, rec: EntityRecord, t: number, wall: number, role: OrbitRole, centre: Centre = EARTH_CENTRE): void {
    this.setRole(role);
    const selected = role === 'selected';
    const s = graph.stateIn(rec.id, t, 'EARTH:inertial');
    const r = s ? norm(s.r) : 0;
    // a body entity (Moon, Earth, Mars) has its orbit line only, where it has one (the Sun does not); an object needs a state
    // and, round the Earth, to be clear of the surface and inside the near-Earth limit
    const isBody = rec.provider?.type === 'body';
    const earthBound = !isBody && rec.bodyId === 'EARTH';
    const usable = !!s && (isBody ? !!rec.render?.orbitLine : !earthBound || (r > RE + 50 && r < NEAR_EARTH_LIMIT_KM));
    this.footprint.obj.visible = usable && earthBound && selected;
    this.orbit.obj.visible = this.trail.obj.visible = this.track.obj.visible = false;
    if (!s || !usable) return;

    if (this.footprint.obj.visible) this.updateFootprint(s, r);
    const period = orbitPeriodSec(graph, rec, s, t);
    const orbitCentre = bodyEntityId(rec.bodyId);
    if (period !== this.period || orbitCentre !== this.centreKeyBuilt) {
      this.period = period;
      this.centreKeyBuilt = orbitCentre;
      this.orbitT = this.trackT = this.orbitWall = -Infinity;
    }
    if (!period) return;

    const lookup = graphLookup(graph);
    // the orbit is a closed loop through the entity, so it stays valid until the entity has moved a fraction of a revolution
    if (Math.abs(t - this.orbitT) > (period * 1000) / 40 && wall - this.orbitWall > 200) {
      this.buildOrbit(graph, rec, t, period, frameSampler(orbitCentre, t, lookup));
      this.orbitT = t;
      this.orbitWall = wall;
    }
    // built around the centre as it was then: follow it
    this.orbit.pos.shift = this.orbitRef ? centreShift(orbitCentre, t, lookup, this.orbitRef) : ZERO3;
    this.orbit.obj.visible = this.orbit.n > 1;

    if (!selected || isBody) return;
    const trailCentre = frameForRec(centre, rec);
    if (trailCentre !== orbitCentre) this.updateTrail(graph, rec, t, period, frameSampler(trailCentre, t, lookup));
    if (!earthBound) return;
    if (Math.abs(t - this.trackT) > (period * 1000) / 80 || wall - this.trackWall > 3000) {
      this.buildTrack(graph, rec, t, period);
      this.trackT = t;
      this.trackWall = wall;
    }
    this.track.obj.visible = true;
  }

  /** Orbit line colour and opacity of the role: full for the selected entity, dimmed (as HIGHLIGHT dims) for a child. */
  private setRole(role: OrbitRole): void {
    if (role === this.role) return;
    this.role = role;
    const m = this.orbit.obj.material as THREE.LineBasicMaterial;
    const c = this.color;
    if (role === 'selected') m.color.copy(c);
    else m.color.setRGB(dimmed(c.r), dimmed(c.g), dimmed(c.b));
  }

  private updateFootprint(s: StateVector, r: number): void {
    const lam = Math.acos(RE / r);
    const u = [s.r[0] / r, s.r[1] / r, s.r[2] / r] as [number, number, number];
    const e1 = cross(u, [0, 0, 1]);
    const n1 = norm(e1);
    const a = n1 < 1e-6 ? ([1, 0, 0] as [number, number, number]) : ([e1[0] / n1, e1[1] / n1, e1[2] / n1] as [number, number, number]);
    const b = cross(u, a);
    const pos = this.footprint.pos;
    // lifted by the chord sag as well: the circle of a high satellite's footprint is a 96-gon with chords of hundreds of km
    const chordKm = 2 * RE * Math.sin(lam) * Math.sin(Math.PI / FOOTPRINT_POINTS);
    const R = RE + SURFACE_LIFT_KM + chordSagKm(chordKm);
    for (let i = 0; i < FOOTPRINT_POINTS; i++) {
      const th = (i / FOOTPRINT_POINTS) * Math.PI * 2;
      const c = Math.cos(lam), sl = Math.sin(lam), ct = Math.cos(th), st = Math.sin(th);
      pos.setXYZ(i, R * (c * u[0] + sl * (ct * a[0] + st * b[0])), R * (c * u[1] + sl * (ct * a[1] + st * b[1])), R * (c * u[2] + sl * (ct * a[2] + st * b[2])));
    }
  }

  /**
   * One revolution from `t`, each sample relative to the frame centre at its own time, drawn around the centre at `t`.
   * A heliocentric body (the Earth, Mars) is a plain circle round the Sun at `ref`, to scale like the Sun's mesh.
   */
  private buildOrbit(graph: EntityGraph, rec: EntityRecord, t: number, periodSec: number, inFrame?: FrameSampler): void {
    const pos = this.orbit.pos;
    this.orbitRef = inFrame?.ref ?? null;
    let n = 0;
    let prev: Vec3 | null = null;
    if (!inFrame || inFrame.ref) {
      for (let i = 0; i <= ORBIT_POINTS; i++) {
        const ts = t + (i / ORBIT_POINTS) * periodSec * 1000;
        const s = graph.stateIn(rec.id, ts, 'EARTH:inertial');
        if (!s) continue;
        // a step of a quarter of the radius or more is no orbit: the provider moved the entity elsewhere (a modeled orbit
        // that ends hands the launch vehicle back to its pad marker), so the line stops where the orbit does
        if (prev && norm(prev) > 1 && Math.hypot(s.r[0] - prev[0], s.r[1] - prev[1], s.r[2] - prev[2]) > 0.25 * norm(prev)) break;
        prev = s.r;
        let p = s.r;
        if (inFrame) {
          const c = inFrame.centreAt(ts);
          if (!c) continue;
          p = framePathPoint(p, c, inFrame.ref!);
        }
        pos.setXYZ(n++, p[0], p[1], p[2]);
      }
    }
    this.orbit.n = n;
    this.orbit.obj.geometry.setDrawRange(0, n);
  }

  private updateTrail(graph: EntityGraph, rec: EntityRecord, t: number, periodSec: number, inFrame?: FrameSampler): void {
    const span = Math.min(rec.render?.trailSeconds ?? DEFAULT_TRAIL_SEC, periodSec * TRAIL_MAX_REVOLUTION) * 1000;
    const pos = this.trail.pos, col = this.trail.color!;
    let n = 0;
    for (let i = 0; i < TRAIL_POINTS && (!inFrame || inFrame.ref); i++) {
      const f = i / (TRAIL_POINTS - 1);
      const ts = t - span * (1 - f);
      const s = graph.stateIn(rec.id, ts, 'EARTH:inertial');
      if (!s) continue;
      let p = s.r;
      if (inFrame) {
        const c = inFrame.centreAt(ts);
        if (!c) continue;
        p = framePathPoint(p, c, inFrame.ref!);
      }
      const k = f * f;
      pos.setXYZ(n, p[0], p[1], p[2]);
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
    // pass 1: ground points; pass 2: lift each by the sag of the chords next to it, so the straight segments between
    // widely spaced points (hundreds of km) stay above the Earth mesh instead of dipping under it as dashes
    const ground: { p: number[]; lat: number; lon: number; ts: number }[] = [];
    for (let i = 0; i < TRACK_POINTS; i++) {
      const ts = t0 + (i / (TRACK_POINTS - 1)) * (t1 - t0);
      const s = graph.stateIn(rec.id, ts, 'EARTH:fixed');
      if (!s) continue;
      const g = fixedToGeodetic(s.r, EARTH);
      ground.push({ p: geodeticToFixed({ lat: g.lat, lon: g.lon, alt: 0 }, EARTH), lat: g.lat, lon: g.lon, ts });
    }
    const chord = (a: number, b: number) => {
      if (a < 0 || b >= ground.length) return 0;
      const p = ground[a].p, q = ground[b].p;
      return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    };
    let n = 0;
    for (let i = 0; i < ground.length; i++) {
      const g = ground[i];
      const lift = SURFACE_LIFT_KM + Math.max(chordSagKm(chord(i - 1, i)), chordSagKm(chord(i, i + 1)));
      const p = geodeticToFixed({ lat: g.lat, lon: g.lon, alt: lift }, EARTH);
      const k = g.ts < t ? 0.3 : 1 - 0.55 * ((g.ts - t) / (t1 - t));
      pos.setXYZ(n, p[0], p[1], p[2]);
      col.setXYZ(n++, this.color.r * k, this.color.g * k, this.color.b * k);
    }
    col.needsUpdate = true;
    this.track.n = n;
    this.track.obj.geometry.setDrawRange(0, n);
  }
}
