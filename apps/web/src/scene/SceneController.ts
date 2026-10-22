import * as THREE from 'three';
import {
  DEG, EARTH, fixedToGeodetic, geodeticToFixed, gmstRad, sunDirectionEci,
  type EntityRecord, type IssFix, type Launch, type Omm,
} from '@eio/core';
import { NORTH_UP_AZ, MIN_ALT_KM, MIN_TARGET_DIST_KM, altitudeOf, boundingSphere, fitAngles, fitDistance, groundPoint, viewAnglesFor } from '../lib/camera';
import { colorKeyOf, isSgp4, type ColorKey } from '../lib/entity';
import { NO_FILTERS, matchesFilters, sceneVisibility, type Filters, type Visibility } from '../lib/filters';
import { GROUND_LIFT_KM, displayPosition } from '../lib/paths';
import type { FocusRequest } from '../state/store';
import { clock, graph } from '../state/runtime';
import { OrbitRig } from './controls';
import { createAtmosphereMaterial, createEarthMaterial, createPointMaterial, createStarMaterial } from './materials';
import { GLYPH_ID, POINT_SIZE, readPalette, type Palette } from './palette';
import { EntityOverlay } from './overlays';
import { PathOverlay, type PathStatus } from './PathOverlay';
import { PropagatorClient } from './propagator-client';

// Colours and sizes are authored in display space; skip three's linear workflow.
THREE.ColorManagement.enabled = false;

const RE = EARTH.radiusKm;
const PICK_RADIUS_PX = 11;
const HINT_LIMIT = 6;
/** FIT never frames a smaller sphere than this: the camera cannot come closer than MIN_ALT_KM to the ground anyway, km. */
const MIN_FIT_RADIUS_KM = 1.5;
const FIT_MARGIN = 1.3;

export interface PathLabel {
  text: string;
  /** CSS pixels inside the scene container */
  x: number;
  y: number;
}

export interface SceneCallbacks {
  onPick(id: string): void;
  onHover(h: { id: string; x: number; y: number } | null): void;
  /** Screen positions of the selected path's phase boundaries (called each frame while there are any, once more to clear). */
  onPathLabels?(labels: PathLabel[]): void;
  /** The scene changed follow mode by itself (FIT leaves the followed object). */
  onFollowChange?(follow: boolean): void;
  onSurfaceChange?(on: boolean): void;
}

export interface SceneStats {
  fps: number;
  distKm: number;
  /** camera height above the ellipsoid */
  altKm: number;
  satCount: number;
  dynCount: number;
  earth: 'texture' | 'procedural';
  shellSelected: boolean;
  /** surface-aligned camera mode */
  surface: boolean;
  /** selected path: window relative to now (ms, negative = past) and whether it is drawn on the compressed shell */
  path: { pastMs: number; futureMs: number; compressed: boolean } | null;
}

/** Where the surface-aligned camera is anchored. */
type SurfaceSource = { kind: 'entity'; id: string } | { kind: 'latlon'; lat: number; lon: number };

interface PointSet {
  geo: THREE.BufferGeometry;
  points: THREE.Points;
  pos: THREE.BufferAttribute;
  color: THREE.BufferAttribute;
  size: THREE.BufferAttribute;
  glyph: THREE.BufferAttribute;
}

function makePointSet(n: number, material: THREE.Material, positions?: Float32Array): PointSet {
  const geo = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(positions ?? new Float32Array(n * 3), 3);
  const color = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  const size = new THREE.BufferAttribute(new Float32Array(n), 1);
  const glyph = new THREE.BufferAttribute(new Float32Array(n), 1);
  pos.setUsage(THREE.DynamicDrawUsage);
  size.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', pos);
  geo.setAttribute('aColor', color);
  geo.setAttribute('aSize', size);
  geo.setAttribute('aGlyph', glyph);
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  return { geo, points, pos, color, size, glyph };
}

/** Distance (km) and angles at which a fly-to settles for a target at world position `p`. */
function viewFor(p: THREE.Vector3): { dist: number; az: number; el: number } {
  const r = p.length();
  const dist = r < 20000 ? 3200 : r < 2e6 ? r * 0.6 : r * 0.45;
  const el = Math.max(-1.2, Math.min(1.2, Math.asin(r > 0 ? p.z / r : 0) + 0.3));
  return { dist, az: Math.atan2(p.y, p.x), el };
}

export class SceneController {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 1, 1e7);
  private rig: OrbitRig;
  private palette: Palette;
  private sun = new THREE.Vector3(1, 0, 0);
  private earthGroup = new THREE.Group();
  private earthMat: THREE.ShaderMaterial;
  private earthMode: 'texture' | 'procedural' = 'procedural';
  private stars: THREE.Points;
  private pointMat: THREE.ShaderMaterial;
  private sats: PointSet;
  private dyn: PointSet;
  private pads: PointSet;
  private hi: PointSet;
  private dynIds: string[] = [];
  private dynIndex = new Map<string, number>();
  private dynBaseSize = new Float32Array(0);
  private satIndex = new Map<string, number>();
  private recs = new Map<string, EntityRecord>();
  private satSet = new Set<string>();
  private propagator = new PropagatorClient();
  private overlays = new Map<string, EntityOverlay>();
  private fullOverlays = new Set<string>();
  private pathOverlay: PathOverlay | null = null;
  private pathOverlayId: string | null = null;
  private pathStatus: PathStatus = { active: false, compressed: false, frame: 'inertial', plan: null };
  private hadPathLabels = false;
  private surfaceOn = false;
  private surfaceSrc: SurfaceSource | null = null;
  private globeDist = 24000;
  private focusLatLon: { lat: number; lon: number } | null = null;
  /** Earth-fixed point the free (unfollowed) camera target is pinned to after a FIT of ground-level objects */
  private groundLock: [number, number, number] | null = null;
  private launches: Launch[] = [];
  private filters: Filters = NO_FILTERS;
  private selectedId: string | null = null;
  private hoverId: string | null = null;
  private issFix: IssFix | undefined;
  private followFn: ((out: THREE.Vector3) => boolean) | null = null;
  private follow = false;
  private freeTarget = new THREE.Vector3();
  private anchor = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private mouse: { x: number; y: number } | null = null;
  private down: { x: number; y: number; t: number } | null = null;
  private lastPickAt = 0;
  private shellSelected = false;
  private lastCompressed = false;
  private fps = 60;
  private lastFrame = performance.now();
  private disposed = false;
  private ro: ResizeObserver;
  private cleanup: (() => void)[] = [];

  constructor(private container: HTMLElement, private cb: SceneCallbacks) {
    this.palette = readPalette();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setClearColor(this.palette.bg, 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = 'scene-canvas';

    this.camera.up.set(0, 0, 1);
    this.rig = new OrbitRig(this.camera, this.renderer.domElement);
    const sun0 = sunDirectionEci(clock.now());
    this.rig.az = Math.atan2(sun0[1], sun0[0]) + 0.5;
    this.rig.el = 0.35;

    this.pointMat = createPointMaterial(dpr);

    // stars follow the camera and sit on the far plane
    const NSTAR = 2600;
    let seed = 0x9e3779b9; // fixed seed (mulberry32): the same sky on every load
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let z = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
      return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
    };
    const sp = new Float32Array(NSTAR * 3), ss = new Float32Array(NSTAR), sb = new Float32Array(NSTAR);
    for (let i = 0; i < NSTAR; i++) {
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      sp.set([s * Math.cos(th), s * Math.sin(th), u], i * 3);
      ss[i] = 0.8 + rnd() * 1.6;
      sb[i] = 0.25 + rnd() * 0.75;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    sg.setAttribute('aSize', new THREE.BufferAttribute(ss, 1));
    sg.setAttribute('aBright', new THREE.BufferAttribute(sb, 1));
    this.stars = new THREE.Points(sg, createStarMaterial(dpr));
    this.stars.renderOrder = -10;
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    // Earth: geometry is rotated so local axes are ECEF (z = north, +x = prime meridian); the group turns by GMST
    // 256 x 160: facet sag stays under ~1 km, so the camera may come within MIN_ALT_KM of the ground without clipping through
    const eg = new THREE.SphereGeometry(RE, 256, 160);
    eg.rotateX(Math.PI / 2);
    this.earthMat = createEarthMaterial(this.sun, null);
    const earth = new THREE.Mesh(eg, this.earthMat);
    earth.scale.z = 1 - EARTH.flattening;
    this.earthGroup.add(earth, this.buildGraticule());
    this.scene.add(this.earthGroup);
    this.loadEarthTexture();

    const atmo = new THREE.Mesh(new THREE.SphereGeometry(RE * 1.02, 96, 64), createAtmosphereMaterial(this.sun));
    atmo.renderOrder = 1;
    this.scene.add(atmo);

    this.sats = makePointSet(0, this.pointMat);
    this.dyn = makePointSet(0, this.pointMat);
    this.pads = makePointSet(0, this.pointMat);
    this.hi = makePointSet(4, this.pointMat);
    for (const set of [this.sats, this.dyn, this.hi]) {
      set.points.renderOrder = 5;
      this.scene.add(set.points);
    }
    this.pads.points.renderOrder = 4;
    this.earthGroup.add(this.pads.points);
    this.hi.points.renderOrder = 6;

    this.propagator.onLayout = (ids) => this.onLayout(ids);
    this.propagator.setClock(clock.snapshot());
    this.cleanup.push(clock.subscribe((s) => this.propagator.setClock(s)));

    this.attachPointerHandlers(this.renderer.domElement);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ------------------------------------------------------------------ inputs from the app

  /** Reconcile with the entity catalog: new/changed SGP4 records go to the worker, the rest to the main-thread graph. */
  setEntities(map: Map<string, EntityRecord>): void {
    const upserts: { id: string; omm: Omm }[] = [];
    const gone: string[] = [];
    let dynChanged = false;
    for (const rec of map.values()) {
      const prev = this.recs.get(rec.id);
      if (prev === rec) continue;
      this.recs.set(rec.id, rec);
      if (rec.provider?.type === 'sgp4') {
        upserts.push({ id: rec.id, omm: rec.provider.omm });
        this.satSet.add(rec.id);
        if (prev && !isSgp4(prev)) dynChanged = true;
        graph.remove(rec.id); // re-added below only if selected or hinted
      } else {
        if (prev && isSgp4(prev)) gone.push(rec.id);
        this.satSet.delete(rec.id);
        graph.upsert(rec);
        dynChanged = true;
      }
    }
    for (const id of this.recs.keys()) {
      if (map.has(id)) continue;
      this.recs.delete(id);
      graph.remove(id);
      if (this.satSet.delete(id)) gone.push(id);
      else dynChanged = true;
    }
    this.propagator.remove(gone);
    this.propagator.upsert(upserts);
    if (dynChanged) this.rebuildDyn();
    this.refreshHints();
    this.applyAppearance();
  }

  setFilters(f: Filters): void {
    this.filters = f;
    this.applyAppearance();
  }

  setLaunches(launches: Launch[]): void {
    this.launches = launches.filter((l) => l.pad);
    const n = this.launches.length;
    this.earthGroup.remove(this.pads.points);
    this.pads.geo.dispose();
    this.pads = makePointSet(n, this.pointMat);
    this.pads.points.renderOrder = 4;
    this.earthGroup.add(this.pads.points);
    this.launches.forEach((l, i) => {
      const p = geodeticToFixed({ lat: l.pad!.latitude * DEG, lon: l.pad!.longitude * DEG, alt: GROUND_LIFT_KM }, EARTH);
      this.pads.pos.setXYZ(i, p[0], p[1], p[2]);
      this.pads.glyph.setX(i, GLYPH_ID.ring);
    });
    this.updatePadAppearance();
  }

  setIssFix(fix: IssFix | undefined): void {
    this.issFix = fix;
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    this.refreshHints();
    this.applyAppearance();
    this.updatePadAppearance();
    // the surface camera tracked the deselected object's sub-point: stay where it is, on the rotating ground
    if (!id && this.surfaceOn && this.surfaceSrc?.kind === 'entity') this.freezeSurfaceSource();
  }

  setFollow(follow: boolean): void {
    if (follow !== this.follow) this.groundLock = null;
    if (!follow && this.follow) {
      this.freeTarget.copy(this.rig.target).sub(this.rig.pan);
    }
    this.follow = follow;
    if (this.surfaceOn) {
      if (!follow && this.surfaceSrc?.kind === 'entity') this.freezeSurfaceSource();
      else if (follow && this.selectedId && this.recs.has(this.selectedId)) this.surfaceSrc = { kind: 'entity', id: this.selectedId };
    }
  }

  focus(req: FocusRequest): void {
    this.groundLock = null;
    if (req.id) {
      const rec = this.recs.get(req.id);
      if (!rec) return;
      graph.upsert(rec);
      const id = req.id;
      this.focusLatLon = null;
      this.followFn = (out) => this.worldPos(id, clock.now(), out);
      if (this.surfaceOn) this.surfaceSrc = { kind: 'entity', id };
    } else if (req.lat !== undefined && req.lon !== undefined) {
      const lat = req.lat * DEG, lon = req.lon * DEG;
      this.focusLatLon = { lat, lon };
      this.followFn = (out) => {
        this.fixedToWorld(geodeticToFixed({ lat, lon, alt: GROUND_LIFT_KM }, EARTH), out);
        return true;
      };
      if (this.surfaceOn) this.surfaceSrc = { kind: 'latlon', lat, lon };
    } else {
      if (this.surfaceOn) this.setSurfaceMode(false);
      this.followFn = null;
      this.focusLatLon = null;
      this.freeTarget.set(0, 0, 0);
      this.follow = false;
      this.rig.flyTo({ dist: Math.max(20000, Math.min(this.rig.dist, 60000)), az: this.rig.az, el: this.rig.el * 0.6 });
      return;
    }
    this.follow = true;
    if (this.surfaceOn) {
      this.rig.flyTo({ dist: this.rig.dist, az: this.rig.az, el: this.rig.el });
      return;
    }
    if (this.followFn?.(this.tmp)) this.rig.flyTo(viewFor(this.tmp));
  }

  // ------------------------------------------------------------------ camera modes and fit

  get surfaceMode(): boolean {
    return this.surfaceOn;
  }

  toggleSurface(): void {
    this.setSurfaceMode(!this.surfaceOn);
  }

  /**
   * Surface-aligned camera: orbits a ground point (the sub-point of the selected object, a launch pad being focused,
   * or the point under the view centre) with the local vertical up and north-up, so the horizon is level and the
   * Earth blocks the stars below it. Leaving flies back to the globe view of the same place.
   */
  setSurfaceMode(on: boolean): void {
    if (on === this.surfaceOn) return;
    if (on) {
      const src = this.pickSurfaceSource();
      if (!src) return;
      this.globeDist = this.rig.dist;
      this.surfaceSrc = src;
      let dist = 300;
      if (src.kind === 'entity' && this.worldPos(src.id, clock.now(), this.tmp)) {
        // an object high above its sub-point (ISS) needs a camera far enough back (and high enough) to see it and the ground
        dist = Math.min(60000, Math.max(300, (this.tmp.length() - RE) * 3.6));
      }
      this.rig.switchMode('surface');
      this.rig.az = NORTH_UP_AZ;
      this.rig.el = 0.35;
      this.rig.dist = dist;
      this.surfaceOn = true;
    } else {
      // globe view of the same place: from outside along the ground point's direction, at the globe distance we left
      const t = this.rig.target;
      const look = viewAnglesFor([t.x, t.y, t.z], 1);
      const followed = this.follow && !!this.followFn && this.followFn(this.anchor);
      this.rig.switchMode('globe');
      if (look) {
        this.rig.az = look.az;
        this.rig.el = look.el;
      }
      this.rig.dist = followed ? viewFor(this.anchor).dist : Math.max(this.globeDist, 20000);
      this.surfaceOn = false;
      this.surfaceSrc = null;
    }
    this.cb.onSurfaceChange?.(this.surfaceOn);
  }

  /**
   * Frame a set of entities: bounding sphere of their current display positions (plus `points` on the ground and,
   * for the selected entity, its drawn path), camera distance from the FOV, smooth fly-to. Leaves follow mode.
   * Returns false when none of the ids has a position.
   */
  fitEntities(ids: string[], opts: { points?: { latDeg: number; lonDeg: number }[]; includePath?: boolean } = {}): boolean {
    const pts: number[] = [];
    const v = new THREE.Vector3();
    for (const id of ids) {
      if (this.fitPos(id, v)) pts.push(v.x, v.y, v.z);
    }
    for (const p of opts.points ?? []) {
      this.fixedToWorld(geodeticToFixed({ lat: p.latDeg * DEG, lon: p.lonDeg * DEG, alt: GROUND_LIFT_KM }, EARTH), v);
      pts.push(v.x, v.y, v.z);
    }
    let withPath = false;
    if (opts.includePath !== false && this.selectedId && ids.includes(this.selectedId) && this.pathStatus.active) {
      this.earthGroup.updateMatrixWorld();
      this.pathOverlay?.worldPoints((x, y, z) => pts.push(x, y, z));
      withPath = true;
    }
    return this.frameSphere(pts, !withPath);
  }

  /** FIT VISIBLE: everything the current filters leave on screen. */
  fitVisible(): boolean {
    const pts: number[] = [];
    const v = new THREE.Vector3();
    for (const rec of this.recs.values()) {
      if (!matchesFilters(rec, this.filters)) continue;
      if (this.fitPos(rec.id, v)) pts.push(v.x, v.y, v.z);
    }
    return this.frameSphere(pts);
  }

  /** `mayBeSinglePoint`: when everything coincides (< 0.5 km) frame it like a plain selection instead of zooming to metres. */
  private frameSphere(pts: number[], mayBeSinglePoint = true): boolean {
    if (pts.length < 3) return false;
    if (this.surfaceOn) this.setSurfaceMode(false);
    const { c, r } = boundingSphere(pts);
    const radius = Math.max(r, MIN_FIT_RADIUS_KM);
    this.tmp.set(c[0], c[1], c[2]);
    // a single point (nothing to fit) gets the same view as selecting it, not an absurdly close one
    const view = mayBeSinglePoint && r < 0.5 ? viewFor(this.tmp) : null;
    const dist = view?.dist ?? Math.min(3e7, Math.max(MIN_TARGET_DIST_KM, fitDistance(radius, this.camera.fov, this.camera.aspect, FIT_MARGIN)));
    const look = view ?? fitAngles(c, radius);
    this.follow = false;
    this.freeTarget.set(c[0], c[1], c[2]);
    this.rig.pan.set(0, 0, 0);
    this.rig.flyTo({ dist, az: look?.az ?? this.rig.az, el: look?.el ?? this.rig.el });
    this.cb.onFollowChange?.(false); // before the lock below: setFollow(false) would otherwise clear it
    // a set that sits on the ground (booster, pad, landing zone) must turn with the Earth, or the Earth slides out from under the view
    this.groundLock = null;
    if (altitudeOf(c) < 150 && r < 200) {
      const g = -gmstRad(clock.now());
      this.groundLock = [c[0] * Math.cos(g) - c[1] * Math.sin(g), c[0] * Math.sin(g) + c[1] * Math.cos(g), c[2]];
    }
    return true;
  }

  /** Current display position of any entity: SGP4 from the propagator buffer, others from the graph. */
  private fitPos(id: string, out: THREE.Vector3): boolean {
    if (this.satIndex.has(id)) return this.pointPos(id, out);
    const rec = this.recs.get(id);
    if (!rec?.provider) return false;
    if (!graph.get(id)) graph.upsert(rec);
    return this.worldPos(id, clock.now(), out);
  }

  private fixedToWorld(f: ArrayLike<number>, out: THREE.Vector3): void {
    const g = gmstRad(clock.now());
    out.set(f[0] * Math.cos(g) - f[1] * Math.sin(g), f[0] * Math.sin(g) + f[1] * Math.cos(g), f[2]);
  }

  /** Where a fresh surface view anchors: the selected object's sub-point, the focused pad, else the point under the view centre. */
  private pickSurfaceSource(): SurfaceSource | null {
    if (this.follow && this.selectedId && this.worldPos(this.selectedId, clock.now(), this.tmp)) return { kind: 'entity', id: this.selectedId };
    if (this.follow && this.focusLatLon) return { kind: 'latlon', ...this.focusLatLon };
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const c = this.camera.position;
    const b = c.dot(dir);
    const disc = b * b - (c.lengthSq() - RE * RE);
    const p = disc > 0 && -b - Math.sqrt(disc) > 0 ? c.clone().addScaledVector(dir, -b - Math.sqrt(disc)) : c.clone();
    return this.latLonOfWorld(p);
  }

  private latLonOfWorld(p: THREE.Vector3): SurfaceSource | null {
    if (p.lengthSq() < 1) return null;
    const g = -gmstRad(clock.now());
    const fx = p.x * Math.cos(g) - p.y * Math.sin(g), fy = p.x * Math.sin(g) + p.y * Math.cos(g);
    const geo = fixedToGeodetic([fx, fy, p.z], EARTH);
    return { kind: 'latlon', lat: geo.lat, lon: geo.lon };
  }

  private freezeSurfaceSource(): void {
    const ground = this.surfaceTarget(this.tmp);
    this.surfaceSrc = (ground && this.latLonOfWorld(this.tmp)) || this.surfaceSrc;
  }

  /** World position of the surface camera's ground target, or null when its source has no position. */
  private surfaceTarget(out: THREE.Vector3): boolean {
    const src = this.surfaceSrc;
    if (!src) return false;
    if (src.kind === 'entity') {
      if (!this.worldPos(src.id, clock.now(), out)) return false;
      const g = groundPoint([out.x, out.y, out.z]);
      out.set(g[0], g[1], g[2]);
      return true;
    }
    this.fixedToWorld(geodeticToFixed({ lat: src.lat, lon: src.lon, alt: 0 }, EARTH), out);
    return true;
  }

  getStats(): SceneStats {
    const plan = this.pathStatus.plan;
    const now = clock.now();
    return {
      fps: this.fps,
      distKm: this.rig.dist,
      altKm: this.rig.altitudeKm,
      satCount: this.propagator.ids.length,
      dynCount: this.dynIds.length,
      earth: this.earthMode,
      shellSelected: this.shellSelected,
      surface: this.surfaceOn,
      path: this.pathStatus.active && plan ? { pastMs: plan.t0 - now, futureMs: plan.t1 - now, compressed: this.pathStatus.compressed } : null,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    this.cleanup.forEach((fn) => fn());
    this.rig.destroy();
    this.propagator.dispose();
    this.overlays.forEach((o) => o.dispose());
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ------------------------------------------------------------------ construction helpers

  private buildGraticule(): THREE.LineSegments {
    const pts: number[] = [];
    const seg = (lat0: number, lon0: number, lat1: number, lon1: number) => {
      for (const [la, lo] of [[lat0, lon0], [lat1, lon1]]) pts.push(...geodeticToFixed({ lat: la * DEG, lon: lo * DEG, alt: 3 }, EARTH));
    };
    for (let lat = -60; lat <= 60; lat += 30) for (let lon = -180; lon < 180; lon += 6) seg(lat, lon, lat, lon + 6);
    for (let lon = -180; lon < 180; lon += 30) for (let lat = -90; lat < 90; lat += 6) seg(lat, lon, lat + 6, lon);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x9fc6e8, transparent: true, opacity: 0.1, depthWrite: false }));
    lines.renderOrder = 2;
    return lines;
  }

  private loadEarthTexture(): void {
    new THREE.TextureLoader().load(
      '/textures/earth.jpg',
      (tex) => {
        if (this.disposed) return;
        tex.colorSpace = THREE.NoColorSpace;
        tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        this.earthMat.uniforms.uTex.value = tex;
        this.earthMat.uniforms.uHasTex.value = 1;
        this.earthMode = 'texture';
      },
      undefined,
      () => undefined, // missing/invalid texture: procedural shading stays
    );
  }

  // ------------------------------------------------------------------ point sets

  private onLayout(ids: string[]): void {
    this.satIndex = new Map(ids.map((id, i) => [id, i]));
    this.scene.remove(this.sats.points);
    this.sats.geo.dispose();
    this.sats = makePointSet(ids.length, this.pointMat, this.propagator.positions);
    this.sats.points.renderOrder = 5;
    this.scene.add(this.sats.points);
    this.applyAppearance();
  }

  private rebuildDyn(): void {
    const ids: string[] = [];
    for (const rec of this.recs.values()) if (!isSgp4(rec) && rec.provider) ids.push(rec.id);
    this.dynIds = ids;
    this.dynIndex = new Map(ids.map((id, i) => [id, i]));
    this.scene.remove(this.dyn.points);
    this.dyn.geo.dispose();
    this.dyn = makePointSet(ids.length, this.pointMat);
    this.dyn.points.renderOrder = 5;
    this.scene.add(this.dyn.points);
    this.dynBaseSize = new Float32Array(ids.length);
  }

  /** Colours, sizes and glyphs from entity metadata, filters and selection. */
  private applyAppearance(): void {
    const { colors } = this.palette;
    // 'dim' (launch highlight mode) keeps the point but darkens and shrinks it; with a launch selected its members are enlarged
    const paint = (set: PointSet, i: number, rec: EntityRecord | undefined, vis: Visibility) => {
      const key: ColorKey = rec ? colorKeyOf(rec) : 'satellite';
      const c = colors[key];
      const k = vis === 'dim' ? 0.3 : 1;
      set.color.setXYZ(i, c.r * k, c.g * k, c.b * k);
      set.glyph.setX(i, rec?.render?.glyph ? GLYPH_ID[rec.render.glyph] : 0);
      set.size.setX(i, vis === 'hide' ? 0 : POINT_SIZE[key] * (vis === 'dim' ? 0.7 : this.filters.launch ? 1.8 : 1));
    };
    const vis = (rec: EntityRecord | undefined, hidden = false): Visibility => (!rec || hidden ? 'hide' : sceneVisibility(rec, this.filters));
    this.propagator.ids.forEach((id, i) => {
      const rec = this.recs.get(id);
      paint(this.sats, i, rec, vis(rec, id === this.selectedId));
    });
    this.sats.color.needsUpdate = this.sats.size.needsUpdate = this.sats.glyph.needsUpdate = true;
    this.dynIds.forEach((id, i) => {
      const rec = this.recs.get(id);
      paint(this.dyn, i, rec, vis(rec));
      this.dynBaseSize[i] = this.dyn.size.getX(i);
    });
    this.dyn.color.needsUpdate = this.dyn.size.needsUpdate = this.dyn.glyph.needsUpdate = true;
  }

  private updatePadAppearance(): void {
    const sel = this.selectedId;
    const now = clock.now();
    this.launches.forEach((l, i) => {
      const isSel = l.entityId === sel;
      const soon = Date.parse(l.net) - now < 24 * 3600_000 && Date.parse(l.net) - now > -3600_000;
      const c = isSel ? this.palette.colors.vehicle : soon ? this.palette.accent : this.palette.colors.ground;
      this.pads.color.setXYZ(i, c.r, c.g, c.b);
      this.pads.size.setX(i, isSel ? 24 : soon ? 17 : 12);
    });
    this.pads.color.needsUpdate = this.pads.size.needsUpdate = true;
  }

  /** Keep overlays for the selected entity (full) and for entities hinting `orbitLine`/`footprint` (light). */
  private refreshHints(): void {
    const want = new Map<string, boolean>();
    let hinted = 0;
    for (const rec of this.recs.values()) {
      if ((rec.render?.orbitLine || rec.render?.footprint) && hinted < HINT_LIMIT) {
        want.set(rec.id, false);
        hinted++;
        graph.upsert(rec);
      }
    }
    const sel = this.selectedId ? this.recs.get(this.selectedId) : undefined;
    if (sel) {
      graph.upsert(sel);
      want.set(sel.id, true);
    }
    for (const [id, o] of this.overlays) {
      if (!want.has(id)) {
        o.dispose();
        this.overlays.delete(id);
      }
    }
    for (const id of want.keys()) {
      if (this.overlays.has(id)) continue;
      const rec = this.recs.get(id)!;
      this.overlays.set(id, new EntityOverlay(this.scene, this.earthGroup, this.palette.colors[colorKeyOf(rec)]));
    }
    this.fullOverlays = new Set([...want].filter(([, full]) => full).map(([id]) => id));

    // trajectory path for a selected entity that has no SGP4 orbit of its own
    const pathId = sel && !isSgp4(sel) && sel.provider && sel.provider.type !== 'geodetic' ? sel.id : null;
    if (pathId !== this.pathOverlayId) {
      this.pathOverlay?.dispose();
      this.pathOverlay = null;
      this.pathOverlayId = pathId;
      this.pathStatus = { active: false, compressed: false, frame: 'inertial', plan: null };
      if (sel && pathId) this.pathOverlay = new PathOverlay(this.scene, this.earthGroup, this.pointMat, this.palette.colors[colorKeyOf(sel)]);
    }
  }

  // ------------------------------------------------------------------ geometry queries

  /** World (ECI, display-compressed) position of an entity at sim time `t`. */
  private worldPos(id: string, t: number, out: THREE.Vector3): boolean {
    const s = graph.stateIn(id, t, 'EARTH:inertial');
    if (!s) return false;
    // deep-space shell compression, else nudge near-surface markers off the sphere (shared with the path overlay)
    const { r, compressed } = displayPosition(s.r);
    out.set(r[0], r[1], r[2]);
    this.lastCompressed = compressed;
    return true;
  }

  /** Last rendered world position of any point (for hover marker). */
  private pointPos(id: string, out: THREE.Vector3): boolean {
    const si = this.satIndex.get(id);
    if (si !== undefined) {
      const p = this.sats.pos;
      if (p.getX(si) === 0 && p.getY(si) === 0 && p.getZ(si) === 0) return false;
      out.set(p.getX(si), p.getY(si), p.getZ(si));
      return true;
    }
    const di = this.dynIndex.get(id);
    if (di === undefined || this.dyn.size.getX(di) === 0) return false;
    out.set(this.dyn.pos.getX(di), this.dyn.pos.getY(di), this.dyn.pos.getZ(di));
    return true;
  }

  private occluded(p: THREE.Vector3): boolean {
    const c = this.camera.position;
    const d = this.tmp.copy(p).sub(c);
    const len = d.length();
    d.divideScalar(len);
    const b = c.dot(d);
    const disc = b * b - (c.lengthSq() - RE * RE * 0.995);
    if (disc <= 0) return false;
    const t0 = -b - Math.sqrt(disc);
    return t0 > 0 && t0 < len;
  }

  /** Screen-space nearest visible point within a small radius; occluded-by-Earth points are skipped. */
  private pick(px: number, py: number): string | null {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const m = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).elements;
    const hits: { d2: number; id: string; x: number; y: number; z: number }[] = [];
    const scan = (set: PointSet, ids: string[], bias: number) => {
      const pos = set.pos.array as Float32Array, size = set.size.array as Float32Array;
      for (let i = 0; i < ids.length; i++) {
        if (size[i] === 0) continue;
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        if (x === 0 && y === 0 && z === 0) continue;
        const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (cw <= 0) continue;
        const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw * 0.5 + 0.5) * w;
        const sy = (1 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / cw * 0.5 + 0.5)) * h;
        const dx = sx - px, dy = sy - py;
        const r = Math.max(PICK_RADIUS_PX * 0.55, size[i] * 0.5 + 4);
        const d2 = dx * dx + dy * dy;
        if (d2 <= r * r) hits.push({ d2: d2 - bias, id: ids[i], x, y, z });
      }
    };
    scan(this.sats, this.propagator.ids, 0);
    scan(this.dyn, this.dynIds, 60);
    hits.sort((a, b) => a.d2 - b.d2);
    for (const hit of hits.slice(0, 8)) {
      if (!this.occluded(this.tmp.set(hit.x, hit.y, hit.z))) return hit.id;
    }
    // the selected entity is drawn from the highlight set, not the sat cloud
    if (this.selectedId && this.hi.size.getX(1) > 0) {
      const p = new THREE.Vector3(this.hi.pos.getX(1), this.hi.pos.getY(1), this.hi.pos.getZ(1)).project(this.camera);
      const dx = (p.x * 0.5 + 0.5) * w - px, dy = (1 - (p.y * 0.5 + 0.5)) * h - py;
      if (p.z < 1 && dx * dx + dy * dy <= PICK_RADIUS_PX * PICK_RADIUS_PX) return this.selectedId;
    }
    return null;
  }

  // ------------------------------------------------------------------ interaction

  private attachPointerHandlers(dom: HTMLElement): void {
    const rel = (e: PointerEvent) => {
      const r = dom.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onMove = (e: PointerEvent) => {
      this.mouse = e.buttons ? null : rel(e);
      if (e.buttons) this.setHover(null);
    };
    const onDown = (e: PointerEvent) => {
      this.down = { ...rel(e), t: performance.now() };
    };
    const onUp = (e: PointerEvent) => {
      const d = this.down;
      this.down = null;
      if (!d || e.button !== 0) return;
      const p = rel(e);
      if (Math.hypot(p.x - d.x, p.y - d.y) > 4 || performance.now() - d.t > 600) return;
      const id = this.pick(p.x, p.y);
      if (id) this.cb.onPick(id);
    };
    const onLeave = () => {
      this.mouse = null;
      this.setHover(null);
    };
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointerleave', onLeave);
    this.cleanup.push(() => {
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointerleave', onLeave);
    });
  }

  private setHover(id: string | null, x = 0, y = 0): void {
    this.hoverId = id;
    this.renderer.domElement.style.cursor = id ? 'pointer' : '';
    this.cb.onHover(id ? { id, x, y } : null);
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ frame loop

  private frame(): void {
    if (this.disposed) return;
    const wall = performance.now();
    this.fps += ((1000 / Math.max(1, wall - this.lastFrame)) - this.fps) * 0.05;
    this.lastFrame = wall;
    const t = clock.now();

    this.earthGroup.rotation.z = gmstRad(t);
    const s = sunDirectionEci(t);
    this.sun.set(s[0], s[1], s[2]);

    if (this.propagator.dirty) {
      this.sats.pos.needsUpdate = true;
      this.propagator.dirty = false;
    }
    this.updateDyn(t);
    this.updateHighlights(t);
    this.updateOverlays(t, wall);

    // camera
    let anchored: boolean;
    if (this.surfaceOn) {
      anchored = this.surfaceTarget(this.anchor);
      if (!anchored) this.setSurfaceMode(false); // the anchored object lost its position: back to the globe
      this.rig.minDist = MIN_ALT_KM;
    } else {
      anchored = this.follow && this.followFn ? this.followFn(this.anchor) : false;
      if (!anchored && this.groundLock) this.fixedToWorld(this.groundLock, this.freeTarget);
      // orbiting the Earth's centre: stop MIN_ALT_KM above the ground; orbiting an object: nearly touching it is fine
      this.rig.minDist = anchored || this.freeTarget.lengthSq() > 1 ? MIN_TARGET_DIST_KM : RE + MIN_ALT_KM;
    }
    this.rig.update(anchored ? this.anchor : null, this.freeTarget, wall);
    const dist = this.rig.dist;
    // near plane shrinks with the camera's height so the ground right below is not clipped, but never beyond the usual dist ratio
    const camAlt = altitudeOf([this.camera.position.x, this.camera.position.y, this.camera.position.z]);
    this.camera.near = Math.min(3000, Math.max(0.01, Math.min(dist * 0.0015, Math.max(camAlt, 0.5) * 0.3)));
    this.camera.far = dist + this.rig.target.length() + 6e6;
    this.camera.updateProjectionMatrix();
    this.stars.position.copy(this.camera.position);

    if (this.mouse && wall - this.lastPickAt > 40 && !this.rig.flying) {
      this.lastPickAt = wall;
      const id = this.pick(this.mouse.x, this.mouse.y);
      if (id || this.hoverId) this.setHover(id, this.mouse.x, this.mouse.y);
    }

    this.renderer.render(this.scene, this.camera);
    this.updatePathLabels();
  }

  private updateDyn(t: number): void {
    const pos = this.dyn.pos, size = this.dyn.size;
    for (let i = 0; i < this.dynIds.length; i++) {
      const ok = this.worldPos(this.dynIds[i], t, this.tmp);
      if (ok) pos.setXYZ(i, this.tmp.x, this.tmp.y, this.tmp.z);
      size.setX(i, ok ? this.dynBaseSize[i] : 0);
    }
    pos.needsUpdate = size.needsUpdate = true;
  }

  /** Selected ring + dot (exact main-thread position), hover ring, ISS live-fix marker. */
  private updateHighlights(t: number): void {
    const { hi, tmp } = this;
    const set = (i: number, ok: boolean, size: number, color: THREE.Color, glyph: number) => {
      hi.size.setX(i, ok ? size : 0);
      hi.color.setXYZ(i, color.r, color.g, color.b);
      hi.glyph.setX(i, glyph);
      if (ok) hi.pos.setXYZ(i, tmp.x, tmp.y, tmp.z);
    };
    const sel = this.selectedId ? this.recs.get(this.selectedId) : undefined;
    const ok = !!sel && this.worldPos(sel.id, t, tmp);
    this.shellSelected = ok && this.lastCompressed;
    const c = sel ? this.palette.colors[colorKeyOf(sel)] : this.palette.accent;
    set(0, ok, 26, this.palette.accent, GLYPH_ID.ring);
    // sat-cloud points of the selected sat are hidden, so redraw it here at its exact position
    set(1, ok && !!sel && isSgp4(sel), POINT_SIZE[sel ? colorKeyOf(sel) : 'satellite'] + 3, c, GLYPH_ID.dot);

    const hov = this.hoverId && this.hoverId !== this.selectedId ? this.pointPos(this.hoverId, tmp) : false;
    set(2, hov, 18, this.palette.colors.station, GLYPH_ID.ring);

    let fixOk = false;
    const fix = this.issFix;
    if (fix && clock.snapshot().mode === 'live' && Date.now() - fix.t < 20_000) {
      const f = geodeticToFixed({ lat: fix.latitude * DEG, lon: fix.longitude * DEG, alt: fix.altitudeKm }, EARTH);
      const g = gmstRad(t);
      tmp.set(f[0] * Math.cos(g) - f[1] * Math.sin(g), f[0] * Math.sin(g) + f[1] * Math.cos(g), f[2]);
      fixOk = true;
    }
    set(3, fixOk, 15, this.palette.colors.ground, GLYPH_ID.diamond);
    hi.pos.needsUpdate = hi.size.needsUpdate = hi.color.needsUpdate = hi.glyph.needsUpdate = true;
  }

  private updateOverlays(t: number, wall: number): void {
    for (const [id, o] of this.overlays) {
      const rec = this.recs.get(id);
      if (rec) o.update(graph, rec, t, wall, this.fullOverlays.has(id));
    }
    const po = this.pathOverlay, rec = this.pathOverlayId ? this.recs.get(this.pathOverlayId) : undefined;
    if (po && rec) this.pathStatus = po.update(graph, rec, t, wall, this.overlays.get(rec.id)?.hasOrbit ?? false);
  }

  /** Project the selected path's phase boundaries to the screen for the label layer. */
  private updatePathLabels(): void {
    const cb = this.cb.onPathLabels;
    if (!cb) return;
    const labels: PathLabel[] = [];
    if (this.pathStatus.active && this.pathOverlay) {
      this.earthGroup.updateMatrixWorld();
      const w = this.container.clientWidth, h = this.container.clientHeight;
      for (const l of this.pathOverlay.phaseLabels()) {
        const p = this.tmp2.set(l.x, l.y, l.z); // not `tmp`: occluded() works in it
        if (this.occluded(p)) continue;
        p.project(this.camera);
        if (p.z > 1 || p.z < -1 || Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05) continue;
        labels.push({ text: l.text, x: (p.x * 0.5 + 0.5) * w, y: (1 - (p.y * 0.5 + 0.5)) * h });
      }
    }
    if (labels.length || this.hadPathLabels) cb(labels);
    this.hadPathLabels = labels.length > 0;
  }
}
