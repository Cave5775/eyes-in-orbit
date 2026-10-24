import * as THREE from 'three';
import {
  DEG, EARTH, fixedToGeodetic, geodeticToFixed, gmstRad, sunDirectionEci,
  type EntityRecord, type IssArrays, type IssFix, type Launch, type Omm,
} from '@eio/core';
import { modelViewDirection } from '../lib/attitude';
import { refDisplay, refMaxDistKm, refMinDistKm, refViewDistKm, type RefBody } from '../lib/ref-body';
import { NORTH_UP_AZ, MIN_ALT_KM, MIN_TARGET_DIST_KM, altitudeOf, boundingSphere, fitAngles, fitDistanceClamped, groundPoint, maxDistKm, panGround, settleDistance, surfaceFrame, surfaceLift, viewAnglesFor, type V3 } from '../lib/camera';
import { colorKeyOf, isIss, isSgp4, type ColorKey } from '../lib/entity';
import { NO_FILTERS, filtersActive, matchesFilters, sceneVisibility, type Filters, type Visibility } from '../lib/filters';
import { ELLIPSOID_K, makeOccluder, occlusionC2, sphereView } from '../lib/occlusion';
import { SHELL_THRESHOLD_KM, type DistanceScale } from '../lib/deepspace';
import { displayPosition } from '../lib/paths';
import { POPUP_MAX, gatherCandidates, type PickExtra, type PickSource } from '../lib/pick';
import { inScope, inView, scopeRadius, type ScopeMode } from '../lib/scope';
import type { FocusRequest } from '../state/store';
import { clock, graph } from '../state/runtime';
import { OrbitRig } from './controls';
import { createAtmosphereMaterial, createEarthMaterial, createPointMaterial, createStarMaterial } from './materials';
import { GLYPH_ID, POINT_SIZE, readPalette, type Palette } from './palette';
import type { DetailView } from '../lib/earth-detail';
import { CelestialLayer } from './celestial';
import { EarthDetail, type DetailStats } from './earth-detail';
import { EntityOverlay } from './overlays';
import { PathOverlay, type PathStatus } from './PathOverlay';
import { PropagatorClient } from './propagator-client';
import { RelPositions, RenderFrame } from './relative';
import { ModelLayer, type ModelFrame } from './models/ModelLayer';
import { IssArrayTracker, arraySources, issJoints, type ArraySources, type IssJoints } from '../lib/arrays';

// Colours and sizes are authored in display space; skip three's linear workflow.
THREE.ColorManagement.enabled = false;

const RE = EARTH.radiusKm;
const PICK_RADIUS_PX = 11;
const HINT_LIMIT = 6;
/** FIT never frames a smaller sphere than this: the camera cannot come closer than MIN_ALT_KM to the ground anyway, km. */
const MIN_FIT_RADIUS_KM = 1.5;
const FIT_MARGIN = 1.3;
/** Render camera clip planes. The scene uses a logarithmic depth buffer, so these only bound what is clipped, not depth precision. */
const NEAR_KM = 0.005;
const FAR_KM = 1e13;

export interface PathLabel {
  text: string;
  /** CSS pixels inside the scene container */
  x: number;
  y: number;
}

export interface SceneCallbacks {
  onPick(id: string): void;
  onHover(h: { id: string; x: number; y: number } | null): void;
  /**
   * A click found more than one object within the cluster radius (lib/pick.ts): ids nearest first (the first is what a
   * plain click would have selected), `total` counts all of them (the list is capped), x/y are the cursor in CSS px
   * inside the scene container. onPick is not called for that click.
   */
  onPickMany?(ids: string[], total: number, x: number, y: number): void;
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
  /** width in pixels of the Earth map in use (0: procedural) and the GPU's maximum texture size */
  earthPx: number;
  /** streamed close-up imagery over the base map: the tile level and how many of its tiles have arrived (null: not active) */
  detail: DetailStats | null;
  detailEnabled: boolean;
  maxTexturePx: number;
  shellSelected: boolean;
  /** surface-aligned camera mode */
  surface: boolean;
  /** selected path: window relative to now (ms, negative = past) and whether it is drawn on the compressed shell */
  path: { pastMs: number; futureMs: number; compressed: boolean } | null;
  /** scope policy: objects drawn (in scope, not filtered out, in view, not behind the Earth) out of all that have a position */
  scope: { mode: ScopeMode; rendered: number; total: number };
  distanceScale: DistanceScale;
  /** body the view is centred on ('EARTH' unless the camera is following the Moon or the Sun) */
  ref: RefBody;
  /** ids of entities whose 3D model is drawn this frame (camera within the model's LOD distance) */
  models: string[];
  /** ISS array pose in use while the ISS model is drawn: the source of each part and the joint angles (rad) */
  arrays: { sources: ArraySources; joints: IssJoints | null } | null;
}

/** Where the surface-aligned camera is anchored. */
type SurfaceSource = { kind: 'entity'; id: string } | { kind: 'latlon'; lat: number; lon: number; lift?: number };

/** Elevation of the surface camera on entry and after a fit, radians above the local horizon. */
const SURFACE_EL = 0.35;

interface PointSet {
  geo: THREE.BufferGeometry;
  points: THREE.Points;
  /** float64 world positions plus the camera-relative GPU copy */
  pos: RelPositions;
  color: THREE.BufferAttribute;
  size: THREE.BufferAttribute;
  glyph: THREE.BufferAttribute;
  /** 0/1 per point: scope policy (out of scope points are not drawn nor pickable) */
  show: THREE.BufferAttribute;
}

function makePointSet(n: number, material: THREE.Material, world?: Float64Array, fixed = false): PointSet {
  const geo = new THREE.BufferGeometry();
  const pos = new RelPositions(world ?? n, fixed);
  const color = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  const size = new THREE.BufferAttribute(new Float32Array(n), 1);
  const glyph = new THREE.BufferAttribute(new Float32Array(n), 1);
  const show = new THREE.BufferAttribute(new Float32Array(n).fill(1), 1);
  size.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', pos.attr);
  geo.setAttribute('aColor', color);
  geo.setAttribute('aSize', size);
  geo.setAttribute('aGlyph', glyph);
  geo.setAttribute('aShow', show);
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  return { geo, points, pos, color, size, glyph, show };
}

/** Distance (km) and angles at which a fly-to settles for a target at world position `p`. */
function viewFor(p: THREE.Vector3): { dist: number; az: number; el: number } {
  const r = p.length();
  const dist = settleDistance(r);
  const el = Math.max(-1.2, Math.min(1.2, Math.asin(r > 0 ? p.z / r : 0) + 0.3));
  return { dist, az: Math.atan2(p.y, p.x), el };
}

export class SceneController {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  /** The logical camera: float64 world position, driven by the rig, used for all CPU-side maths. */
  private camera = new THREE.PerspectiveCamera(45, 1, NEAR_KM, FAR_KM);
  /** What is actually rendered: same orientation and lens, but at the origin (floating origin, see `lib/floating-origin.ts`). */
  private rcam = new THREE.PerspectiveCamera(45, 1, NEAR_KM, FAR_KM);
  private frameInfo = new RenderFrame();
  /** Earth occlusion test for camera-relative points, rebuilt every frame */
  private occ: (x: number, y: number, z: number) => boolean = () => false;
  private rig: OrbitRig;
  private palette: Palette;
  private sun = new THREE.Vector3(1, 0, 0);
  private earthGroup = new THREE.Group();
  private atmo: THREE.Mesh;
  private celestial: CelestialLayer;
  /** the Moon or the Sun while the camera is centred on it (the followFn tracks its centre), else null */
  private bodyTarget: RefBody | null = null;
  private earthMat: THREE.ShaderMaterial;
  private earthMode: 'texture' | 'procedural' = 'procedural';
  private earthPx = 0;
  private detail = new EarthDetail();
  private lastDetailAt = 0;
  private detailDir = new THREE.Vector3();
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
  /** how objects beyond the deep-space threshold are placed: log-compressed shell (default) or at their real distance */
  private distScale: DistanceScale = 'compressed';
  // scope policy (see lib/scope.ts)
  private scopeMode: ScopeMode = 'auto';
  /** the selection's related objects (parent, children, pad, linked probes ...): never scoped out */
  private related: ReadonlySet<string> = new Set();
  /** 1 where an active filter lets the object through: never scoped out */
  private satKeep = new Uint8Array(0);
  private dynKeep = new Uint8Array(0);
  private scopeDirty = true;
  private lastScopeAt = -Infinity;
  private scopeCounts = { rendered: 0, total: 0 };
  /** overlays (orbit lines, footprints) of entities that are in scope */
  private overlayInScope = new Map<string, boolean>();
  /** 3D models of entities with `render.model`, drawn camera-relative while the camera is near them (scene/models/) */
  private models: ModelLayer;
  private modelFrame: ModelFrame;
  /** ISS array telemetry (SARJ / attitude from the feed), smoothed between its 1 Hz samples */
  private issTracker = new IssArrayTracker();
  private issSources: ArraySources = { sarj: 'STATIC', bga: 'STATIC', attitude: false };
  private issJointsNow: IssJoints | null = null;
  /** entity the camera follows, if any (a followed model may be approached closer than a plain point) */
  private followId: string | null = null;
  private selectedId: string | null = null;
  private hoverId: string | null = null;
  /** object the choice popup has highlighted: drawn with the hover ring, and hover from the mouse is suspended meanwhile */
  private previewId: string | null = null;
  private issFix: IssFix | undefined;
  /** world position of the followed thing at sim time `t` */
  private followFn: ((out: THREE.Vector3, t: number) => boolean) | null = null;
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
  /** the animation loop is running (resize may redraw synchronously) */
  private started = false;
  private ro: ResizeObserver;
  private cleanup: (() => void)[] = [];

  constructor(private container: HTMLElement, private cb: SceneCallbacks) {
    this.palette = readPalette();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // logarithmic depth: float depth precision is uniform in log(distance), so ground markers, trajectories and the Earth
    // keep their order from a 3 km altitude hover out to the deep-space shell without a per-frame near/far dance
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setClearColor(this.palette.bg, 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = 'scene-canvas';

    this.camera.up.set(0, 0, 1);
    this.rig = new OrbitRig(this.camera, this.renderer.domElement);
    this.rig.onGroundPan = (east, north) => this.panSurface(east, north);
    const sun0 = sunDirectionEci(clock.now());
    this.rig.az = Math.atan2(sun0[1], sun0[0]) + 0.5;
    this.rig.el = 0.35;

    this.pointMat = createPointMaterial(dpr);

    // stars follow the camera (they sit on the unit sphere around the render origin) and are pinned to the far plane
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

    // Earth: geometry is rotated so local axes are ECEF (z = north, +x = prime meridian); the group turns by GMST and is
    // positioned at minus the camera (floating origin). 512 x 256: facet sag stays near 0.12 km, so the surface the
    // markers stand on is the true ellipsoid to within a hundred metres.
    const eg = new THREE.SphereGeometry(RE, 512, 256);
    eg.rotateX(Math.PI / 2);
    this.earthMat = createEarthMaterial(this.sun, null);
    this.detail.texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.earthMat.uniforms.uDetail.value = this.detail.texture;
    this.earthMat.uniforms.uDetailBox.value = this.detail.box;
    const earth = new THREE.Mesh(eg, this.earthMat);
    earth.scale.z = 1 - EARTH.flattening;
    this.earthGroup.add(earth, this.buildGraticule());
    this.scene.add(this.earthGroup);
    this.loadEarthTexture();

    this.atmo = new THREE.Mesh(new THREE.SphereGeometry(RE * 1.02, 96, 64), createAtmosphereMaterial(this.sun));
    this.atmo.renderOrder = 1;
    this.scene.add(this.atmo);
    this.celestial = new CelestialLayer(this.scene, this.sun);

    this.sats = makePointSet(0, this.pointMat);
    this.dyn = makePointSet(0, this.pointMat);
    this.pads = makePointSet(0, this.pointMat, undefined, true);
    this.hi = makePointSet(4, this.pointMat);
    for (const set of [this.sats, this.dyn, this.pads, this.hi]) this.scene.add(set.points);
    this.sats.points.renderOrder = this.dyn.points.renderOrder = 5;
    this.pads.points.renderOrder = 4;
    this.hi.points.renderOrder = 6;

    this.models = new ModelLayer(this.scene);
    this.modelFrame = this.makeModelFrame();

    this.propagator.onLayout = (ids) => this.onLayout(ids);
    this.propagator.setClock(clock.snapshot());
    this.cleanup.push(clock.subscribe((s) => this.propagator.setClock(s)));

    this.attachPointerHandlers(this.renderer.domElement);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.started = true;
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
    // entities with a registered 3D model need an exact main-thread state even when SGP4 (the worker only fills the cloud)
    this.models.setEntities(this.recs.values());
    for (const rec of this.recs.values()) if (this.models.has(rec.id)) graph.upsert(rec);
    if (dynChanged) this.rebuildDyn();
    this.refreshHints();
    this.applyAppearance();
  }

  setFilters(f: Filters): void {
    this.filters = f;
    this.applyAppearance();
  }

  /**
   * `compressed` (default): objects beyond 2,000,000 km sit on a log-compressed shell. `true`: probes are drawn at their
   * real geocentric positions (up to ~2.5e10 km), their paths at true scale too, and the camera may zoom out to 1e11 km.
   * Markers keep their screen size; the floating origin and the logarithmic depth buffer carry the range.
   */
  /** Turn the streamed close-up imagery on or off (off: the base map only, no tile requests). */
  setDetailEnabled(on: boolean): void {
    this.detail.enabled = on;
    this.lastDetailAt = 0;
  }

  /** A few times a second: tell the detail layer where the camera is looking and how close. */
  private updateDetail(wall: number): void {
    if (wall - this.lastDetailAt < 250) return;
    this.lastDetailAt = wall;
    this.detail.update(this.detailView());
    this.earthMat.uniforms.uDetailOn.value = this.detail.on;
  }

  /** The surface point under the view centre (ray against the Earth sphere), its distance and the screen scale; null looking at space. */
  private detailView(): DetailView | null {
    const dir = this.camera.getWorldDirection(this.detailDir);
    const c = this.camera.position;
    const b = c.dot(dir);
    const disc = b * b - (c.lengthSq() - RE * RE);
    if (disc <= 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t <= 0) return null;
    const g = -gmstRad(clock.now());
    const x = c.x + dir.x * t, y = c.y + dir.y * t, z = c.z + dir.z * t;
    const geo = fixedToGeodetic([x * Math.cos(g) - y * Math.sin(g), x * Math.sin(g) + y * Math.cos(g), z], EARTH);
    return {
      latDeg: geo.lat / DEG, lonDeg: geo.lon / DEG, groundDistKm: t, fovDeg: this.camera.fov,
      viewportPx: this.renderer.domElement.height, aspect: this.camera.aspect,
    };
  }

  setDistanceScale(scale: DistanceScale): void {
    if (scale === this.distScale) return;
    this.distScale = scale;
    this.rig.maxDist = maxDistKm(scale);
    this.scopeDirty = true;
    // whatever the camera was framing out there has moved: follow it with a fresh view, or fall back to the Earth
    if (this.bodyTarget && refDisplay(this.bodyTarget, clock.now(), 'compressed').k !== 1) {
      this.focusBody(this.bodyTarget); // the Sun moved between its shell and its true place (and changed size with it)
    } else if (this.follow && this.followFn?.(this.anchor, clock.now())) {
      if (this.anchor.length() > SHELL_THRESHOLD_KM * 0.5) this.rig.flyTo(viewFor(this.anchor));
    } else if (!this.follow && this.freeTarget.length() > SHELL_THRESHOLD_KM * 0.5) {
      this.freeTarget.set(0, 0, 0);
      this.groundLock = null;
      this.rig.pan.set(0, 0, 0);
      this.rig.flyTo({ dist: 24000, az: this.rig.az, el: this.rig.el * 0.6 });
    }
    this.rig.dist = Math.min(this.rig.dist, this.rig.maxDist);
  }

  get distanceScale(): DistanceScale {
    return this.distScale;
  }

  /** Scope policy: `auto` draws only what is relevant to the camera focus, `all` draws everything the filters allow. */
  setScopeMode(mode: ScopeMode): void {
    this.scopeMode = mode;
    this.scopeDirty = true;
  }

  /** Ids that scope never removes besides the selection: its related objects. */
  setRelated(ids: Iterable<string>): void {
    this.related = new Set(ids);
    this.scopeDirty = true;
  }

  setLaunches(launches: Launch[]): void {
    this.launches = launches.filter((l) => l.pad);
    const n = this.launches.length;
    this.scene.remove(this.pads.points);
    this.pads.geo.dispose();
    // ECEF positions, rotated by the Earth's spin and re-based on the camera every frame
    this.pads = makePointSet(n, this.pointMat, undefined, true);
    this.pads.points.renderOrder = 4;
    this.scene.add(this.pads.points);
    this.launches.forEach((l, i) => {
      const p = geodeticToFixed({ lat: l.pad!.latitude * DEG, lon: l.pad!.longitude * DEG, alt: 0 }, EARTH);
      this.pads.pos.setXYZ(i, p[0], p[1], p[2]);
      this.pads.glyph.setX(i, GLYPH_ID.ring);
    });
    this.updatePadAppearance();
    this.scopeDirty = true;
  }

  setIssFix(fix: IssFix | undefined): void {
    this.issFix = fix;
  }

  /** Live ISS array telemetry; the model's SARJ and attitude follow it while fresh, verified and at live time. */
  setIssArrays(arrays: IssArrays | undefined): void {
    this.issTracker.push(arrays, Date.now());
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
    if (req.body && req.body !== 'EARTH') {
      this.focusBody(req.body);
      return;
    }
    this.bodyTarget = null;
    if (req.id) {
      const rec = this.recs.get(req.id);
      if (!rec) return;
      graph.upsert(rec);
      const id = req.id;
      this.followId = id;
      this.focusLatLon = null;
      this.followFn = (out, t) => this.worldPos(id, t, out);
      if (this.surfaceOn) this.surfaceSrc = { kind: 'entity', id };
    } else if (req.lat !== undefined && req.lon !== undefined) {
      const lat = req.lat * DEG, lon = req.lon * DEG;
      this.followId = null;
      this.focusLatLon = { lat, lon };
      this.followFn = (out, t) => {
        this.fixedToWorld(geodeticToFixed({ lat, lon, alt: 0 }, EARTH), out, t);
        return true;
      };
      if (this.surfaceOn) this.surfaceSrc = { kind: 'latlon', lat, lon };
    } else {
      if (this.surfaceOn) this.setSurfaceMode(false);
      this.followFn = null;
      this.followId = null;
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
    if (this.followFn?.(this.tmp, clock.now())) this.rig.flyTo(viewFor(this.tmp));
  }

  /** Centre the view on the Moon or the Sun and follow it (they move); everything is then seen relative to that body. */
  private focusBody(body: RefBody): void {
    if (this.surfaceOn) this.setSurfaceMode(false);
    this.followId = null;
    this.focusLatLon = null;
    this.bodyTarget = body;
    this.followFn = (out, t) => {
      const p = refDisplay(body, t, this.distScale).r;
      out.set(p[0], p[1], p[2]);
      return true;
    };
    this.follow = true;
    this.cb.onFollowChange?.(true);
    const sun = sunDirectionEci(clock.now());
    this.rig.flyTo({ dist: refViewDistKm(body, refDisplay(body, clock.now(), this.distScale).k), az: Math.atan2(sun[1], sun[0]) + 0.5, el: 0.35 });
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
      if (this.bodyTarget) return; // surface views are Earth-only for now
      const src = this.pickSurfaceSource();
      if (!src) return;
      this.globeDist = this.rig.dist;
      this.surfaceSrc = src;
      let dist = 300;
      if (src.kind === 'entity') dist = this.surfaceFitDist(src.id) ?? dist;
      this.rig.switchMode('surface');
      this.rig.az = NORTH_UP_AZ;
      this.rig.el = SURFACE_EL;
      this.rig.dist = dist;
      this.surfaceOn = true;
    } else {
      // globe view of the same place: from outside along the ground point's direction, at the globe distance we left
      const t = this.rig.target;
      const look = viewAnglesFor([t.x, t.y, t.z], 1);
      const followed = this.follow && !!this.followFn && this.followFn(this.anchor, clock.now());
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
    // surface view of one object: refit inside the surface view instead of leaving it for the globe
    if (this.surfaceOn && ids.length === 1 && !opts.points?.length && this.fitSurface(ids[0])) return true;
    // an entity with a 3D model and nothing else to frame: show the model (following it), not a 3,200 km view of a dot
    if (ids.length === 1 && !opts.points?.length && this.viewModel(ids[0])) return true;
    const pts: number[] = [];
    const v = new THREE.Vector3();
    for (const id of ids) {
      if (this.fitPos(id, v)) pts.push(v.x, v.y, v.z);
    }
    for (const p of opts.points ?? []) {
      this.fixedToWorld(geodeticToFixed({ lat: p.latDeg * DEG, lon: p.lonDeg * DEG, alt: 0 }, EARTH), v);
      pts.push(v.x, v.y, v.z);
    }
    let withPath = false;
    if (opts.includePath !== false && this.selectedId && ids.includes(this.selectedId) && this.pathStatus.active) {
      this.pathOverlay?.worldPoints(this.frameInfo.spin, (x, y, z) => pts.push(x, y, z));
      withPath = true;
    }
    return this.frameSphere(pts, !withPath);
  }

  /** Does the entity have a registered 3D model (drawn when the camera is near)? */
  hasModel(id: string | null | undefined): boolean {
    return !!id && this.models.has(id);
  }

  /**
   * Fly to the entity's 3D model and follow it: the model's own framing distance (ISS 260 m), seen from behind, beside and
   * above on the sunlit side. False when the entity has no model or no state. Leaves the surface view.
   */
  viewModel(id: string): boolean {
    const def = this.models.defOf(id);
    const rec = this.recs.get(id);
    if (!def || !rec) return false;
    const t = clock.now();
    if (!graph.get(id)) graph.upsert(rec);
    const st = graph.stateIn(id, t, 'EARTH:inertial');
    if (!st) return false;
    if (this.surfaceOn) this.setSurfaceMode(false);
    this.focus({ id, nonce: 0 });
    const basis = this.models.basisOf(def, st.r, st.v);
    const s = sunDirectionEci(t);
    const dir = basis ? modelViewDirection(basis, [s[0], s[1], s[2]]) : ([s[0], s[1], s[2]] as V3);
    this.rig.flyTo({ dist: def.fitKm, az: Math.atan2(dir[1], dir[0]), el: Math.asin(Math.max(-1, Math.min(1, dir[2]))) });
    this.cb.onFollowChange?.(true);
    return true;
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
    const dist = view?.dist ?? fitDistanceClamped(radius, this.camera.fov, this.camera.aspect, FIT_MARGIN, MIN_TARGET_DIST_KM, this.distScale);
    const look = view ?? fitAngles(c, radius);
    this.follow = false;
    this.bodyTarget = null;
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

  private fixedToWorld(f: ArrayLike<number>, out: THREE.Vector3, t = clock.now()): void {
    const g = gmstRad(t);
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

  /** Pin an entity source to where its sub-point is now (keeping the target's height), so the view stays put on the rotating ground. */
  private freezeSurfaceSource(): void {
    const src = this.surfaceSrc;
    if (src?.kind !== 'entity' || !this.worldPos(src.id, clock.now(), this.tmp)) return;
    const lift = surfaceLift(altitudeOf([this.tmp.x, this.tmp.y, this.tmp.z]));
    const ll = this.latLonOfWorld(this.tmp);
    if (ll?.kind === 'latlon') this.surfaceSrc = { kind: 'latlon', lat: ll.lat, lon: ll.lon, lift };
  }

  /** Surface camera distance that frames the ground and the entity above it, or null when it has no position. */
  private surfaceFitDist(id: string): number | null {
    if (!this.worldPos(id, clock.now(), this.tmp)) return null;
    return surfaceFrame(altitudeOf([this.tmp.x, this.tmp.y, this.tmp.z]), this.camera.fov, this.camera.aspect).dist;
  }

  /**
   * FIT of one entity while in surface view: stay in the view, follow the entity and refit so the ground and the object are
   * both on screen. False when the entity has no position (the caller falls back to the globe fit).
   */
  private fitSurface(id: string): boolean {
    const rec = this.recs.get(id);
    if (!rec?.provider) return false;
    if (!graph.get(id)) graph.upsert(rec);
    const dist = this.surfaceFitDist(id);
    if (dist === null) return false;
    this.focus({ id, nonce: 0 });
    this.cb.onFollowChange?.(true);
    this.rig.flyTo({ dist, az: this.rig.az, el: SURFACE_EL });
    return true;
  }

  /** A pan drag in surface view: slide the ground target over the Earth. A followed object is let go first. */
  private panSurface(eastKm: number, northKm: number): void {
    if (!this.surfaceOn) return;
    if (this.follow) {
      this.setFollow(false);
      this.cb.onFollowChange?.(false);
    }
    this.freezeSurfaceSource();
    const src = this.surfaceSrc;
    if (src?.kind !== 'latlon') return;
    this.surfaceSrc = { ...src, ...panGround(src.lat, src.lon, eastKm, northKm) };
  }

  /** World position of the surface camera's ground target at sim time `t`, or null when its source has no position. */
  private surfaceTarget(out: THREE.Vector3, t: number): boolean {
    const src = this.surfaceSrc;
    if (!src) return false;
    if (src.kind === 'entity') {
      if (!this.worldPos(src.id, t, out)) return false;
      // aim at the middle of the segment between the ground and the object, so a high object is framed vertically
      const p: V3 = [out.x, out.y, out.z];
      const g = groundPoint(p, surfaceLift(altitudeOf(p)));
      out.set(g[0], g[1], g[2]);
      return true;
    }
    this.fixedToWorld(geodeticToFixed({ lat: src.lat, lon: src.lon, alt: src.lift ?? 0 }, EARTH), out, t);
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
      earthPx: this.earthPx,
      detail: this.detail.stats,
      detailEnabled: this.detail.enabled,
      maxTexturePx: this.renderer.capabilities.maxTextureSize,
      shellSelected: this.shellSelected,
      surface: this.surfaceOn,
      path: this.pathStatus.active && plan ? { pastMs: plan.t0 - now, futureMs: plan.t1 - now, compressed: this.pathStatus.compressed } : null,
      scope: { mode: this.scopeMode, ...this.scopeCounts },
      distanceScale: this.distScale,
      ref: this.bodyTarget ?? 'EARTH',
      models: this.models.activeIds,
      arrays: this.models.activeIds.some((id) => this.models.defOf(id)?.key === 'iss') ? { sources: this.issSources, joints: this.issJointsNow } : null,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    this.cleanup.forEach((fn) => fn());
    this.rig.destroy();
    this.propagator.dispose();
    this.models.dispose();
    this.celestial.dispose();
    this.detail.dispose();
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
      for (const [la, lo] of [[lat0, lon0], [lat1, lon1]]) pts.push(...geodeticToFixed({ lat: la * DEG, lon: lo * DEG, alt: 0.45 }, EARTH));
    };
    for (let lat = -60; lat <= 60; lat += 30) for (let lon = -180; lon < 180; lon += 1) seg(lat, lon, lat, lon + 1);
    for (let lon = -180; lon < 180; lon += 30) for (let lat = -90; lat < 90; lat += 1) seg(lat, lon, lat + 1, lon);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x9fc6e8, transparent: true, opacity: 0.1, depthWrite: false }));
    lines.renderOrder = 2;
    return lines;
  }

  /**
   * Earth map: the high-resolution file (`npm run assets`) when it exists, else the 2k one, else the procedural shading
   * stays. A map wider than the GPU's maximum texture size is scaled down to that size rather than dropped, so a small GPU
   * still gets the best map it can hold. A missing file shows up as a failed load (the dev server answers with its HTML page).
   */
  private loadEarthTexture(): void {
    const max = this.renderer.capabilities.maxTextureSize;
    const apply = (tex: THREE.Texture, px: number) => {
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      this.earthMat.uniforms.uTex.value?.dispose?.();
      this.earthMat.uniforms.uTex.value = tex;
      this.earthMat.uniforms.uHasTex.value = 1;
      this.earthMode = 'texture';
      this.earthPx = px;
    };
    const loadStandard = (why: string) => {
      console.info(`[earth] using earth.jpg: ${why}`);
      new THREE.TextureLoader().load('/textures/earth.jpg', (tex) => {
        if (this.disposed) tex.dispose();
        else apply(tex, (tex.image as { width: number }).width);
      }, undefined, () => console.info('[earth] earth.jpg is missing too: procedural Earth (run npm run assets)'));
    };
    new THREE.TextureLoader().load(
      '/textures/earth-hires.jpg',
      (tex) => {
        if (this.disposed) return tex.dispose();
        const img = tex.image as HTMLImageElement;
        if (img.width <= max) {
          console.info(`[earth] using earth-hires.jpg (${img.width} x ${img.height})`);
          return apply(tex, img.width);
        }
        // too wide for this GPU: scale down to the limit (keeping the aspect ratio) instead of falling back to 2k
        const canvas = document.createElement('canvas');
        canvas.width = max;
        canvas.height = Math.max(1, Math.round((max * img.height) / img.width));
        canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
        tex.dispose();
        console.info(`[earth] using earth-hires.jpg scaled from ${img.width} to ${max} px (GPU texture limit)`);
        apply(new THREE.CanvasTexture(canvas), max);
      },
      undefined,
      () => loadStandard('earth-hires.jpg is missing (run npm run assets, then reload the page)'),
    );
  }

  // ------------------------------------------------------------------ point sets

  private onLayout(ids: string[]): void {
    this.satIndex = new Map(ids.map((id, i) => [id, i]));
    this.scene.remove(this.sats.points);
    this.sats.geo.dispose();
    // the sat cloud shares the worker's float64 buffer: it is re-based on the camera every frame
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
      // a 3D model drawn for the entity replaces its sprite
      const replaced = !!rec && this.models.spriteHidden.has(rec.id);
      set.size.setX(i, vis === 'hide' || replaced ? 0 : POINT_SIZE[key] * (vis === 'dim' ? 0.7 : this.filters.launch ? 1.8 : 1));
    };
    const vis = (rec: EntityRecord | undefined, hidden = false): Visibility => (!rec || hidden ? 'hide' : sceneVisibility(rec, this.filters));
    // with a filter on, the objects it lets through ('show') are exempt from the scope policy
    const filtering = filtersActive(this.filters);
    this.satKeep = new Uint8Array(this.propagator.ids.length);
    this.propagator.ids.forEach((id, i) => {
      const rec = this.recs.get(id);
      const v = vis(rec, id === this.selectedId);
      paint(this.sats, i, rec, v);
      if (filtering && v === 'show') this.satKeep[i] = 1;
    });
    this.sats.color.needsUpdate = this.sats.size.needsUpdate = this.sats.glyph.needsUpdate = true;
    this.dynKeep = new Uint8Array(this.dynIds.length);
    this.dynIds.forEach((id, i) => {
      const rec = this.recs.get(id);
      const v = vis(rec);
      paint(this.dyn, i, rec, v);
      this.dynBaseSize[i] = this.dyn.size.getX(i);
      if (filtering && v === 'show') this.dynKeep[i] = 1;
    });
    this.dyn.color.needsUpdate = this.dyn.size.needsUpdate = this.dyn.glyph.needsUpdate = true;
    this.scopeDirty = true;
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
      this.overlays.set(id, new EntityOverlay(this.scene, this.palette.colors[colorKeyOf(rec)]));
    }
    this.fullOverlays = new Set([...want].filter(([, full]) => full).map(([id]) => id));

    // trajectory path for a selected entity that has no SGP4 orbit of its own
    const pathId = sel && !isSgp4(sel) && sel.provider && sel.provider.type !== 'geodetic' ? sel.id : null;
    if (pathId !== this.pathOverlayId) {
      this.pathOverlay?.dispose();
      this.pathOverlay = null;
      this.pathOverlayId = pathId;
      this.pathStatus = { active: false, compressed: false, frame: 'inertial', plan: null };
      if (sel && pathId) this.pathOverlay = new PathOverlay(this.scene, this.pointMat, this.palette.colors[colorKeyOf(sel)]);
    }
  }

  // ------------------------------------------------------------------ geometry queries

  /** World (ECI, display-compressed) position of an entity at sim time `t`, float64. */
  private worldPos(id: string, t: number, out: THREE.Vector3): boolean {
    const s = graph.stateIn(id, t, 'EARTH:inertial');
    if (!s) return false;
    // deep-space shell compression, else a few-metre nudge for ground contact (shared with the path overlay)
    const { r, compressed } = displayPosition(s.r, this.distScale);
    out.set(r[0], r[1], r[2]);
    this.lastCompressed = compressed;
    return true;
  }

  /** Last computed world position of any point (for the hover marker and FIT). */
  private pointPos(id: string, out: THREE.Vector3): boolean {
    const si = this.satIndex.get(id);
    if (si !== undefined) {
      const w = this.sats.pos.world;
      if (w[si * 3] === 0 && w[si * 3 + 1] === 0 && w[si * 3 + 2] === 0) return false;
      out.set(w[si * 3], w[si * 3 + 1], w[si * 3 + 2]);
      return true;
    }
    const di = this.dynIndex.get(id);
    if (di === undefined || this.dyn.size.getX(di) === 0) return false;
    const w = this.dyn.pos.world;
    out.set(w[di * 3], w[di * 3 + 1], w[di * 3 + 2]);
    return true;
  }

  /** Earth between the camera and the camera-relative point `rel`? */
  private occludedRel(x: number, y: number, z: number): boolean {
    return this.occ(x, y, z);
  }

  /**
   * Every visible object near a screen point, nearest first (lib/pick.ts does the scan). Points hidden behind the Earth
   * (or the Moon and Sun, through `occ`), filtered out or out of scope are skipped. Hover and a plain click use the
   * first entry, so they always agree with the popup's list.
   */
  private pickAll(px: number, py: number, max: number, wantTotal = false): { ids: string[]; total: number } {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const m = new THREE.Matrix4().multiplyMatrices(this.rcam.projectionMatrix, this.rcam.matrixWorldInverse).elements;
    const source = (set: PointSet, ids: readonly string[], bias: number): PickSource => ({
      ids, rel: set.pos.attr.array as Float32Array, world: set.pos.world, size: set.size.array as Float32Array, show: set.show.array as Float32Array, bias,
    });
    const extras: PickExtra[] = [];
    // a drawn 3D model is pickable as a whole (its sprite is hidden)
    const model = this.models.pick(px, py, m, w, h, PICK_RADIUS_PX);
    if (model) extras.push({ id: model, d2: 0 });
    // the selected entity is drawn from the highlight set, not the sat cloud
    if (this.selectedId && this.hi.size.getX(1) > 0) {
      const a = this.hi.pos.attr;
      const p = new THREE.Vector3(a.getX(1), a.getY(1), a.getZ(1));
      const rel: [number, number, number] = [p.x, p.y, p.z];
      p.project(this.rcam);
      const dx = (p.x * 0.5 + 0.5) * w - px, dy = (1 - (p.y * 0.5 + 0.5)) * h - py;
      if (p.z < 1 && dx * dx + dy * dy <= PICK_RADIUS_PX * PICK_RADIUS_PX) extras.push({ id: this.selectedId, d2: dx * dx + dy * dy, rel });
    }
    const r = gatherCandidates(
      [source(this.sats, this.propagator.ids, 0), source(this.dyn, this.dynIds, 60)], extras, m, w, h, px, py,
      { max, wantTotal, occluded: (x, y, z) => this.occludedRel(x, y, z) },
    );
    return { ids: r.items.map((i) => i.id), total: r.total };
  }

  /** The object a plain click or hover lands on: the nearest visible one. */
  private pick(px: number, py: number): string | null {
    return this.pickAll(px, py, 1).ids[0] ?? null;
  }

  /**
   * The choice popup's highlight (null: popup closed). The object gets the hover ring, the mouse hover is suspended while
   * a highlight is set (the popup is a sibling of the canvas, so the pointer leaving the canvas must not clear it).
   */
  setPreview(id: string | null): void {
    if (id === this.previewId) return;
    this.previewId = id;
    this.hoverId = id;
    this.scopeDirty = true; // the hovered object is exempt from scope thinning
    this.renderer.domElement.style.cursor = '';
    this.cb.onHover(null);
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
      // one candidate selects it; several open the choice popup (its first entry is what pick() returns)
      const { ids, total } = this.pickAll(p.x, p.y, POPUP_MAX, true);
      if (ids.length === 1 || (ids.length > 1 && !this.cb.onPickMany)) this.cb.onPick(ids[0]);
      else if (ids.length > 1) {
        this.setHover(null);
        this.cb.onPickMany?.(ids, total, p.x, p.y);
      }
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
    if (this.previewId) return; // the popup's highlight owns the hover ring
    this.hoverId = id;
    this.renderer.domElement.style.cursor = id ? 'pointer' : '';
    this.cb.onHover(id ? { id, x, y } : null);
  }

  /**
   * Container size changed (ResizeObserver, which runs after layout and before paint). `setSize` reallocates the drawing
   * buffer and so CLEARS it: if the next draw waited for the animation loop the browser would composite one blank
   * canvas per resize step (a flash on every step of a splitter drag). So the buffer is refilled synchronously here,
   * with the new aspect ratio, before the browser can paint. The canvas CSS size stays 100% of the container
   * (`updateStyle: false`), so until the buffer is refilled the browser at worst stretches the old one instead of
   * showing a mis-sized or empty canvas.
   */
  private resize(): void {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this.disposed && this.started) this.draw(performance.now());
  }

  // ------------------------------------------------------------------ frame loop

  private frame(): void {
    if (this.disposed) return;
    const wall = performance.now();
    this.fps += ((1000 / Math.max(1, wall - this.lastFrame)) - this.fps) * 0.05;
    this.lastFrame = wall;
    this.draw(wall);
  }

  /** Advance everything to the current sim time and render one frame. */
  private draw(wall: number): void {
    // ONE sim time for the whole frame: markers, followed anchor, overlays and the camera must all be evaluated at the
    // same instant, or at x600 a few milliseconds of skew between them is a visible wobble of the followed object
    const t = clock.now();

    const gmst = gmstRad(t);
    this.earthGroup.rotation.z = gmst;
    const s = sunDirectionEci(t);
    this.sun.set(s[0], s[1], s[2]);

    if (this.propagator.dirty) this.propagator.dirty = false;
    this.updateDyn(t);
    this.updateHighlights(t);
    this.updateOverlays(t, wall);

    // camera
    let anchored: boolean;
    if (this.surfaceOn) {
      anchored = this.surfaceTarget(this.anchor, t);
      if (!anchored) this.setSurfaceMode(false); // the anchored object lost its position: back to the globe
      this.rig.minDist = MIN_ALT_KM;
    } else {
      anchored = this.follow && this.followFn ? this.followFn(this.anchor, t) : false;
      if (!anchored && this.groundLock) this.fixedToWorld(this.groundLock, this.freeTarget, t);
      // orbiting the Earth's centre: stop MIN_ALT_KM above the ground; orbiting an object: nearly touching it is fine
      const modelMin = anchored ? this.models.defOf(this.followId)?.minViewKm : undefined;
      const bodyMin = anchored && this.bodyTarget ? refMinDistKm(this.bodyTarget, refDisplay(this.bodyTarget, t, this.distScale).k) : undefined;
      this.rig.minDist = anchored || this.freeTarget.lengthSq() > 1 ? bodyMin ?? modelMin ?? MIN_TARGET_DIST_KM : RE + MIN_ALT_KM;
    }
    this.rig.maxDist = refMaxDistKm(anchored && this.bodyTarget ? this.bodyTarget : 'EARTH', maxDistKm(this.distScale), this.distScale);
    this.rig.update(anchored ? this.anchor : null, this.freeTarget, wall);
    this.updateDetail(wall);

    this.prepareRender(gmst, t);
    this.updateModels(t);
    this.refreshScope(wall);

    if (this.mouse && wall - this.lastPickAt > 40 && !this.rig.flying) {
      this.lastPickAt = wall;
      const id = this.pick(this.mouse.x, this.mouse.y);
      if (id || this.hoverId) this.setHover(id, this.mouse.x, this.mouse.y);
    }

    this.renderer.render(this.scene, this.rcam);
    this.updatePathLabels();
  }

  /**
   * Floating origin: everything the GPU sees is camera-relative. Positions are subtracted in float64 here; the render
   * camera sits at the origin with the logical camera's orientation; the Earth and atmosphere objects are moved to minus
   * the camera position (their own vertices are static and only a few hundred metres of float32 noise at the surface).
   */
  private prepareRender(gmst: number, t: number): void {
    const cam = this.camera;
    const f = this.frameInfo;
    f.set(cam.position, gmst);

    const rc = this.rcam;
    rc.fov = cam.fov;
    rc.aspect = cam.aspect;
    rc.near = NEAR_KM;
    rc.far = FAR_KM;
    rc.updateProjectionMatrix();
    rc.position.set(0, 0, 0);
    rc.quaternion.copy(cam.quaternion);
    rc.updateMatrixWorld(true);

    this.earthGroup.position.copy(f.origin).negate();
    this.atmo.position.copy(f.origin).negate();
    this.celestial.update(t, f.origin, this.distScale);

    const u = this.pointMat.uniforms;
    u.uOriginS.value.set(f.origin.x, f.origin.y, f.origin.z * ELLIPSOID_K);
    u.uC2.value = occlusionC2(f.originV3);
    u.uOccK.value = ELLIPSOID_K;
    // the displayed Moon and Sun hide what is behind them like the Earth does (shader uniforms, same maths as `this.occ`)
    const bodies = this.celestial.occluders();
    const sph = [u.uSph0.value, u.uSph1.value];
    for (let i = 0; i < 2; i++) {
      const sv = sphereView(f.originV3, bodies[i]);
      sph[i].set(sv.x, sv.y, sv.z, sv.r);
      u.uSphC2.value.setComponent(i, sv.c2);
    }
    this.occ = makeOccluder(f.originV3, undefined, bodies);

    this.sats.pos.upload(f);
    this.dyn.pos.upload(f);
    this.pads.pos.upload(f);
    this.hi.pos.upload(f);
    this.overlays.forEach((o) => o.uploadFrame(f));
    this.pathOverlay?.uploadFrame(f);
  }

  private makeModelFrame(): ModelFrame {
    const rec = (id: string) => this.recs.get(id);
    return {
      t: 0,
      camera: this.camera.position,
      fovRad: 0,
      viewportPx: 1,
      sunDir: [1, 0, 0],
      approx: (id, out) => {
        const si = this.satIndex.get(id);
        const di = this.dynIndex.get(id);
        const set = si !== undefined ? this.sats : di !== undefined ? this.dyn : null;
        const i = si ?? di;
        if (!set || i === undefined) return false;
        const w = set.pos.world;
        if (w[i * 3] === 0 && w[i * 3 + 1] === 0 && w[i * 3 + 2] === 0) return false;
        out.set(w[i * 3], w[i * 3 + 1], w[i * 3 + 2]);
        return true;
      },
      resolve: (id, t) => {
        const s = graph.stateIn(id, t, 'EARTH:inertial');
        if (!s) return null;
        const { r, compressed } = displayPosition(s.r, this.distScale);
        return compressed ? null : { r, v: s.v };
      },
      visibility: (id) => {
        const r = rec(id);
        return r ? sceneVisibility(r, this.filters) : 'hide';
      },
      inScope: (id) => {
        if (this.scopeMode === 'all' || id === this.selectedId || this.related.has(id)) return true;
        const si = this.satIndex.get(id);
        if (si !== undefined) return this.sats.show.getX(si) > 0.5;
        const di = this.dynIndex.get(id);
        return di !== undefined && this.dyn.show.getX(di) > 0.5;
      },
      spritePx: (id) => {
        const r = rec(id);
        return r ? POINT_SIZE[colorKeyOf(r)] : 8;
      },
      attitude: (id) => (this.issSources.attitude && isIss(rec(id)) ? this.issTracker.arrays?.attitude : undefined),
      joints: (id, def, _t, sunBody) => {
        if (def.key !== 'iss' || !isIss(rec(id))) return undefined;
        const joints = issJoints({ sunBody, sarjLive: this.issTracker.sarj(Date.now()), sources: this.issSources });
        this.issJointsNow = joints;
        return joints;
      },
    };
  }

  /** Models near the camera: place camera-relative, pose from the state, and swap sprites out where the model takes over. */
  private updateModels(t: number): void {
    if (!this.models.size) return;
    const f = this.modelFrame;
    f.t = t;
    f.fovRad = (this.camera.fov * Math.PI) / 180;
    f.viewportPx = Math.max(1, this.container.clientHeight);
    const s = sunDirectionEci(t);
    f.sunDir = [s[0], s[1], s[2]];
    // a model is only drawn with a state, so the computed fallback is always available here
    this.issSources = arraySources(this.issTracker.arrays, { liveClock: clock.snapshot().mode === 'live', nowMs: Date.now(), haveState: true });
    if (this.models.update(f)) this.applyAppearance();
  }

  /**
   * Scope policy (lib/scope.ts), a few times a second and whenever its inputs change: sets each point's `aShow` flag
   * (distance from the camera focus, selection/related/filter exemptions) and tallies what is actually drawn for the HUD
   * (in scope, not filtered out, not behind the Earth, inside the view). The Earth's own occlusion stays exact per frame in
   * the point shader; here it is only counted.
   */
  private refreshScope(wall: number): void {
    if (!this.scopeDirty && wall - this.lastScopeAt < 125) return;
    this.scopeDirty = false;
    this.lastScopeAt = wall;
    const mode = this.scopeMode;
    const focus = this.rig.target;
    const radius = scopeRadius(this.rig.dist);
    const sel = this.selectedId, hov = this.hoverId;
    const f = this.frameInfo;
    const occluded = this.occ; // built by prepareRender this frame: the Earth, the Moon and the Sun
    const m = new THREE.Matrix4().multiplyMatrices(this.rcam.projectionMatrix, this.rcam.matrixWorldInverse).elements;
    let total = 0, rendered = 0;
    const tmp = this.tmp2;

    const scan = (set: PointSet, ids: readonly string[], bulk: boolean, keepFlags: Uint8Array | null) => {
      const show = set.show.array as Float32Array, size = set.size.array as Float32Array;
      const rel = set.pos.attr.array as Float32Array;
      let changed = false;
      for (let i = 0; i < ids.length; i++) {
        const w = set.pos.worldOf(i, f.spin, tmp);
        if (w.x === 0 && w.y === 0 && w.z === 0) continue; // no position (failed propagation, provider without a state)
        total++;
        const id = ids[i];
        const keep = id === sel || id === hov || this.related.has(id) || (keepFlags !== null && keepFlags[i] === 1);
        const d = Math.hypot(w.x - focus.x, w.y - focus.y, w.z - focus.z);
        const v = inScope({ d, key: i, bulk, keep }, radius, mode) ? 1 : 0;
        if (show[i] !== v) {
          show[i] = v;
          changed = true;
        }
        if (v === 0 || size[i] <= 0) continue;
        const x = rel[i * 3], y = rel[i * 3 + 1], z = rel[i * 3 + 2];
        if (!inView(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[3] * x + m[7] * y + m[11] * z + m[15])) continue;
        if (!occluded(x, y, z)) rendered++;
      }
      if (changed) set.show.needsUpdate = true;
    };
    scan(this.sats, this.propagator.ids, true, this.satKeep);
    scan(this.dyn, this.dynIds, false, this.dynKeep);
    scan(this.pads, this.launches.map((l) => l.entityId), false, null);
    this.scopeCounts = { rendered, total };

    // light overlays (orbit line, footprint) of entities that are scoped out are not drawn either
    this.overlayInScope.clear();
    for (const id of this.overlays.keys()) {
      const keep = id === sel || this.related.has(id);
      let d = 0;
      if (!keep && this.pointPos(id, tmp)) d = Math.hypot(tmp.x - focus.x, tmp.y - focus.y, tmp.z - focus.z);
      this.overlayInScope.set(id, inScope({ d, key: 0, bulk: false, keep }, radius, mode));
    }
  }

  private updateDyn(t: number): void {
    const pos = this.dyn.pos, size = this.dyn.size;
    const replaced = this.models.spriteHidden;
    for (let i = 0; i < this.dynIds.length; i++) {
      const ok = this.worldPos(this.dynIds[i], t, this.tmp);
      if (ok) pos.setXYZ(i, this.tmp.x, this.tmp.y, this.tmp.z);
      size.setX(i, ok && !(replaced.size && replaced.has(this.dynIds[i])) ? this.dynBaseSize[i] : 0);
    }
    size.needsUpdate = true;
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
    // a drawn 3D model replaces the sprite; a model larger than the ring is its own selection cue
    const replaced = !!sel && this.models.spriteHidden.has(sel.id);
    const ringOff = !!sel && this.models.ringHidden.has(sel.id);
    set(0, ok && !ringOff, 26, this.palette.accent, GLYPH_ID.ring);
    // sat-cloud points of the selected sat are hidden, so redraw it here at its exact position
    set(1, ok && !!sel && isSgp4(sel) && !replaced, POINT_SIZE[sel ? colorKeyOf(sel) : 'satellite'] + 3, c, GLYPH_ID.dot);

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
    hi.size.needsUpdate = hi.color.needsUpdate = hi.glyph.needsUpdate = true;
  }

  private updateOverlays(t: number, wall: number): void {
    for (const [id, o] of this.overlays) {
      const rec = this.recs.get(id);
      if (!rec) continue;
      if (this.overlayInScope.get(id) === false) o.hide();
      else o.update(graph, rec, t, wall, this.fullOverlays.has(id));
    }
    const po = this.pathOverlay, rec = this.pathOverlayId ? this.recs.get(this.pathOverlayId) : undefined;
    if (po && rec) this.pathStatus = po.update(graph, rec, t, wall, this.overlays.get(rec.id)?.hasOrbit ?? false, this.distScale);
  }

  /** Project the selected path's phase boundaries to the screen for the label layer. */
  private updatePathLabels(): void {
    const cb = this.cb.onPathLabels;
    if (!cb) return;
    const labels: PathLabel[] = [];
    if (this.pathStatus.active && this.pathOverlay) {
      const w = this.container.clientWidth, h = this.container.clientHeight;
      const o = this.frameInfo.origin;
      for (const l of this.pathOverlay.phaseLabels(this.frameInfo.spin)) {
        const p = this.tmp2.set(l.x - o.x, l.y - o.y, l.z - o.z); // camera-relative, float64 until here
        if (this.occludedRel(p.x, p.y, p.z)) continue;
        p.project(this.rcam);
        if (p.z > 1 || p.z < -1 || Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05) continue;
        labels.push({ text: l.text, x: (p.x * 0.5 + 0.5) * w, y: (1 - (p.y * 0.5 + 0.5)) * h });
      }
    }
    if (labels.length || this.hadPathLabels) cb(labels);
    this.hadPathLabels = labels.length > 0;
  }
}
