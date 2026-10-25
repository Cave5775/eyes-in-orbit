import * as THREE from 'three';
import {
  DEG, EARTH, bodyOf, fixedToGeodetic, geodeticToFixed, gmstRad, isBodyEntity, sunDirectionEci,
  type EntityRecord, type IssArrays, type IssFix, type Launch, type Omm,
} from '@eio/core';
import { modelViewDirection } from '../lib/attitude';
import { bodyLineIds, bodyPickExtras, gatherWithBodies } from '../lib/body-scene';
import { EARTH_CENTRE, centreLabel, graphLookup, isEarthCentre, type Centre } from '../lib/frame';
import { refDisplay, refMinDistKm, refViewDistKm } from '../lib/ref-body';
import { NORTH_UP_AZ, MIN_ALT_KM, MIN_TARGET_DIST_KM, altitudeOf, boundingSphere, fitAngles, fitDistanceClamped, moveOnSphere, settleDistance, surfaceFitDistance, viewAnglesFor, type SurfaceFrame, type V3 } from '../lib/camera';
import { loadSurfacePref, saveSurfacePref, shouldAutoSurface } from '../lib/surface';
import { colorKeyOf, isIss, isSgp4, type ColorKey } from '../lib/entity';
import { NO_FILTERS, filtersActive, isHiddenRec, matchesFilters, sceneVisibility, type Filters, type Visibility } from '../lib/filters';
import { ELLIPSOID_K, makeOccluder, occlusionC2, sphereView } from '../lib/occlusion';
import { liftNearSurface } from '../lib/paths';
import { POPUP_MAX, SHOW_EXEMPT, SHOW_EXEMPT_MIN, pickMeta, type PickExtra, type PickSource } from '../lib/pick';
import { EARTH_SYSTEM_DEPTH_KM, EARTH_SYSTEM_REACH_KM, discGroups, hiddenByDisc, type DiscGroup } from '../lib/disc-hide';
import { inScope, inView, scopeRadius, type ScopeMode } from '../lib/scope';
import { BUCKETS, LABEL_SCAN_KEEP, LabelPlanner, apparentRadiusPx, bodyLabelOpacity, labelText, selectNearest, type LabelClass, type PlannedLabel } from '../lib/labels';
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
import { nearestOnPath, type PathHit } from '../lib/path-pick';
import { PropagatorClient } from './propagator-client';
import { RelPositions, RenderFrame } from './relative';
import { ModelLayer, type ModelFrame } from './models/ModelLayer';
import { IssArrayTracker, arraySources, issJoints, type ArraySources, type IssJoints } from '../lib/arrays';

// Colours and sizes are authored in display space; skip three's linear workflow.
THREE.ColorManagement.enabled = false;

const RE = EARTH.radiusKm;
/** a launch vehicle, stage or capsule is "in flight" (exempt from the small-disc hiding) once it is this high above the Earth's surface, km; on the pad it hides like the rest */
const IN_FLIGHT_KM = 10;
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
   * A click found more than one object within the cluster radius (lib/pick.ts): ids highest in the hierarchy first, then
   * newest (the first is what a plain click would have selected), `total` counts all of them (the list is capped), x/y are
   * the cursor in CSS px inside the scene container. Several drawn bodies under the cursor (an Earth and a Moon dot) list
   * here too. Zoomed out, objects over a small distant body are not drawn nor pickable, so such a click finds the body alone
   * and calls onPick. onPick is not called for a click that opens the list.
   */
  onPickMany?(ids: string[], total: number, x: number, y: number): void;
  /**
   * The cursor is on the selected launch's drawn trajectory (a planned flight with real sample times) and nothing above it
   * in the pick order is: `tMs` is the sim time of the nearest point of the line, `x`/`y` the cursor and `sx`/`sy` that point,
   * CSS px inside the scene container. Called while it holds (the cursor moves), once with null when it ends.
   */
  onPathHover?(h: { id: string; tMs: number; x: number; y: number; sx: number; sy: number } | null): void;
  /** A click landed on that trajectory (and on no object, popup or body above it): the caller seeks the clock to `tMs`. */
  onPathSeek?(h: { id: string; tMs: number }): void;
  /** Screen positions of the selected path's phase boundaries (called each frame while there are any, once more to clear). */
  onPathLabels?(labels: PathLabel[]): void;
  /**
   * The object labels to show this frame (lib/labels.ts): the first `n` entries of `labels`, top-left box corners in CSS px.
   * The array is reused between calls, so consume it synchronously. Called every frame while labels are on, and once with n = 0 when they go off.
   */
  onLabels?(labels: readonly PlannedLabel[], n: number): void;
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
  /** streamed close-up imagery over the base map: the tile level and how many of its tiles have arrived (null: not active) */
  detail: DetailStats | null;
  detailEnabled: boolean;
  /** surface-aligned camera mode */
  surface: boolean;
  /** selected path: window relative to now (ms, negative = past) */
  path: { pastMs: number; futureMs: number } | null;
  /** scope policy: objects drawn (in scope, not filtered out, in view, not behind the Earth) out of all that have a position */
  scope: { mode: ScopeMode; rendered: number; total: number };
  /** frame of reference (docs/frames.md): its short label (`Moon`, an entity's name), whether it is the Earth, and the lock */
  frame: { label: string; isDefault: boolean; locked: boolean };
  /** ids of entities whose 3D model is drawn this frame (camera within the model's LOD distance) */
  models: string[];
  /** ISS array pose in use while the ISS model is drawn: the source of each part and the joint angles (rad) */
  arrays: { sources: ArraySources; joints: IssJoints | null } | null;
}

/** What the surface-aligned camera is centred on: an entity, or a fixed point over the ground (`alt` km above the ellipsoid, 0 on it). */
type SurfaceSource = { kind: 'entity'; id: string } | { kind: 'latlon'; lat: number; lon: number; alt?: number };

/** Elevation of the surface camera on entry and after a fit, radians above the local horizon. */
const SURFACE_EL = 0.35;
/** Camera distance of the surface view of a ground point (a focused pad, the point under the view), km. */
const SURFACE_POINT_DIST_KM = 300;

interface PointSet {
  geo: THREE.BufferGeometry;
  points: THREE.Points;
  /** float64 world positions plus the camera-relative GPU copy */
  pos: RelPositions;
  color: THREE.BufferAttribute;
  size: THREE.BufferAttribute;
  glyph: THREE.BufferAttribute;
  /** 0/1/2 per point: scope policy (0: out of scope, not drawn nor pickable); 2 = in scope and exempt from the small-disc hiding (lib/disc-hide.ts) */
  show: THREE.BufferAttribute;
}

/** `exempt`: the whole set is drawn whatever lies under it (the highlight set): aShow starts at 2 (`SHOW_EXEMPT`). */
function makePointSet(n: number, material: THREE.Material, world?: Float64Array, fixed = false, exempt = false): PointSet {
  const geo = new THREE.BufferGeometry();
  const pos = new RelPositions(world ?? n, fixed);
  const color = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  const size = new THREE.BufferAttribute(new Float32Array(n), 1);
  const glyph = new THREE.BufferAttribute(new Float32Array(n), 1);
  const show = new THREE.BufferAttribute(new Float32Array(n).fill(exempt ? SHOW_EXEMPT : 1), 1);
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
  /** cones of the small, far bodies that hide the non-exempt points over them (lib/disc-hide.ts), rebuilt every frame in `prepareRender` */
  private discCones: DiscGroup[] = discGroups([], 45, 1);
  private rig: OrbitRig;
  private palette: Palette;
  private sun = new THREE.Vector3(1, 0, 0);
  private earthGroup = new THREE.Group();
  private atmo: THREE.Mesh;
  private celestial: CelestialLayer;
  /** ids of the body entities (`body-moon`): these are drawn by the CelestialLayer, not as points */
  private bodyIds = new Set<string>();
  /** body entities whose orbit line is drawn now (selected / frame centre and their children, see lib/body-scene.ts) and their key */
  private bodyLines: string[] = [];
  private bodyLineKey = '';
  /** frame of reference (an entity id): paths, trails and orbit lines are sampled relative to this centre (set by `setFrame`, independent of the camera) */
  private frameCentre: Centre = EARTH_CENTRE;
  private frameLocked = false;
  private earthMat: THREE.ShaderMaterial;
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
  /** the trajectory under the cursor (hover highlight, cursor, tooltip); null when none */
  private pathHover: (PathHit & { id: string }) | null = null;
  private pathStatus: PathStatus = { active: false, frame: 'inertial', plan: null };
  private hadPathLabels = false;
  // object labels (lib/labels.ts)
  private labelsOn = true;
  private hadLabels = false;
  private labelsDirty = true;
  private lastLabelScanAt = -Infinity;
  private readonly labelPlan = new LabelPlanner();
  private readonly labelM = new THREE.Matrix4();
  /** entities that ask for a label (`render.label`) and are not bodies; rebuilt after the catalogue changes */
  private labelFeatured: Set<string> | null = null;
  /** candidates found by the throttled scan: a point of the sat cloud or the dynamic set, projected again every frame */
  private labelCands: { sat: boolean; i: number; id: string; text: string; feat: boolean }[] = [];
  private labelCandN = 0;
  private labelKeys = new Float32Array(0);
  private labelIdx = new Int32Array(0);
  private readonly labelPick = new Int32Array(LABEL_SCAN_KEEP);
  private readonly labelCounts = new Int32Array(BUCKETS);
  /** per-frame inputs of `labelBody` (set by `updateLabels`) */
  private labelW = 0;
  private labelH = 0;
  /** the selected object has a position this frame (`updateHighlights`) */
  private selOk = false;
  private surfaceOn = false;
  private surfaceSrc: SurfaceSource | null = null;
  /** the user's remembered choice: false after they switched the surface view off, which stops it coming on by itself */
  private surfaceAuto = loadSurfacePref();
  private globeDist = 24000;
  private focusLatLon: { lat: number; lon: number } | null = null;
  /** Earth-fixed point the free (unfollowed) camera target is pinned to after a FIT of ground-level objects */
  private groundLock: [number, number, number] | null = null;
  private launches: Launch[] = [];
  private filters: Filters = NO_FILTERS;
  // scope policy (see lib/scope.ts)
  private scopeMode: ScopeMode = 'auto';
  /** the selection's related objects (parent, children, pad, linked probes ...): never scoped out */
  private related: ReadonlySet<string> = new Set();
  /** 1 where an active filter lets the object through: never scoped out */
  private satKeep = new Uint8Array(0);
  private dynKeep = new Uint8Array(0);
  /** 1 = a launch vehicle, stage or capsule: drawn with aShow = 2 while in flight, never hidden over a small body's disc (set in `applyAppearance`, `refreshScope` checks the altitude) */
  private satExempt = new Uint8Array(0);
  private dynExempt = new Uint8Array(0);
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
  /** the focus entity the camera follows while `follow` (any entity, a body too; a followed model may be approached closer than a plain point) */
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
    // keep their order from a 3 km altitude hover out to deep space without a per-frame near/far dance
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setClearColor(this.palette.bg, 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = 'scene-canvas';

    this.camera.up.set(0, 0, 1);
    this.rig = new OrbitRig(this.camera, this.renderer.domElement);
    this.rig.onGroundPan = (east, north, frame) => this.panSurface(east, north, frame);
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
    this.hi = makePointSet(4, this.pointMat, undefined, false, true);
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
    let bodiesChanged = false;
    for (const rec of map.values()) {
      const prev = this.recs.get(rec.id);
      if (prev === rec) continue;
      this.recs.set(rec.id, rec);
      if (prev && isBodyEntity(prev) && !isBodyEntity(rec)) {
        this.bodyIds.delete(rec.id);
        bodiesChanged = true;
      }
      if (isBodyEntity(rec)) {
        // a celestial body: drawn by the CelestialLayer, never a point; in the graph so worldPos, the frame and the orbit line work
        this.bodyIds.add(rec.id);
        if (prev && !isBodyEntity(prev)) {
          if (isSgp4(prev)) gone.push(rec.id);
          dynChanged = true;
        }
        this.satSet.delete(rec.id);
        graph.upsert(rec);
        bodiesChanged = true;
      } else if (rec.provider?.type === 'sgp4') {
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
      else if (this.bodyIds.delete(id)) bodiesChanged = true;
      else dynChanged = true;
    }
    this.pickMetaCache = null; // ranks and creation times for picking, rebuilt on the next click
    if (bodiesChanged) this.celestial.setBodies([...this.recs.values()].filter(isBodyEntity));
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
    const hiddenChanged = f.hidden !== this.filters.hidden;
    this.filters = f;
    if (hiddenChanged) this.refreshHints(); // a hidden group keeps no orbit line or footprint
    this.applyAppearance();
  }

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
    // the surface camera was centred on the deselected object: nothing left to look at, back to the globe (a view already
    // let go of its object, by panning, has a point of its own and stays)
    if (!id && this.surfaceOn && this.surfaceSrc?.kind === 'entity') this.setSurfaceMode(false);
  }

  /**
   * Frame of reference (state `frame` / `frameLocked`): orbit lines, trails and paths are sampled relative to `centre`.
   * Independent of the camera; `focus({centre})` moves the camera. The overlays rebuild when the centre changes.
   */
  setFrame(centre: Centre, locked = false): void {
    this.frameCentre = centre;
    this.frameLocked = locked;
    this.ensureCentreInGraph();
  }

  /** The centre entity needs a live provider in the graph to be looked up (the selection and hints are put there too). */
  private ensureCentreInGraph(): void {
    const rec = this.recs.get(this.frameCentre);
    if (rec && graph.get(rec.id) !== rec) graph.upsert(rec);
  }

  setFollow(follow: boolean): void {
    if (follow !== this.follow) this.groundLock = null;
    if (!follow && this.follow) {
      this.freeTarget.copy(this.rig.target).sub(this.rig.pan);
    }
    this.follow = follow;
    if (this.surfaceOn) {
      if (!follow && this.surfaceSrc?.kind === 'entity') this.freezeSurfaceSource();
      else if (follow && this.selectedId && this.recs.has(this.selectedId) && !this.bodyIds.has(this.selectedId)) this.surfaceSrc = { kind: 'entity', id: this.selectedId };
    }
  }

  /** The entity the camera is following now (the focus), if any. */
  private followedRec(): EntityRecord | undefined {
    return this.follow && this.followId ? this.recs.get(this.followId) : undefined;
  }

  /** Registry id of the body the camera is following (a followed body entity), else undefined. Derived, so it can never be stale. */
  private followedBody(): string | undefined {
    const rec = this.followedRec();
    return rec && bodyOf(rec);
  }

  /**
   * One-shot camera request from the store (`selectObject`, `resetView`, `focusLaunch`): an entity (a body is one like any
   * other) is followed, a ground point is followed, neither is the home view (free camera over the Earth).
   */
  focus(req: FocusRequest): void {
    this.groundLock = null;
    if (req.id) {
      const rec = this.recs.get(req.id);
      if (rec) this.focusEntity(rec, req);
    } else if (req.lat !== undefined && req.lon !== undefined) {
      const lat = req.lat * DEG, lon = req.lon * DEG;
      this.followId = null;
      this.focusLatLon = { lat, lon };
      this.followFn = (out, t) => {
        this.fixedToWorld(geodeticToFixed({ lat, lon, alt: 0 }, EARTH), out, t);
        return true;
      };
      if (this.surfaceOn) this.surfaceSrc = { kind: 'latlon', lat, lon };
      this.follow = true;
      if (!this.surfaceOn && this.followFn(this.tmp, clock.now())) this.rig.flyTo(viewFor(this.tmp));
      this.applyAutoSurface(req);
    } else {
      if (this.surfaceOn) this.setSurfaceMode(false);
      this.followFn = null;
      this.followId = null;
      this.focusLatLon = null;
      this.freeTarget.set(0, 0, 0);
      this.follow = false;
      this.rig.flyTo({ dist: Math.max(20000, Math.min(this.rig.dist, 60000)), az: this.rig.az, el: this.rig.el * 0.6 });
    }
  }

  /**
   * Centre the view on an entity and follow it (they move). A body: leave the surface view, pivot on it at the distance that
   * frames the whole body, and everything is seen relative to it. Any other entity: the usual fly-to and, near the Earth, the
   * surface orientation (`applyAutoSurface`, skipped for the internal refocuses that pass no request).
   */
  private focusEntity(rec: EntityRecord, req?: FocusRequest): void {
    const id = rec.id;
    if (graph.get(id) !== rec) graph.upsert(rec);
    this.followId = id;
    this.focusLatLon = null;
    this.followFn = (out, t) => this.worldPos(id, t, out);
    this.follow = true;
    const body = bodyOf(rec);
    if (body !== undefined) {
      if (this.surfaceOn) this.setSurfaceMode(false);
      const sun = sunDirectionEci(clock.now());
      this.rig.flyTo({ dist: refViewDistKm(body), az: Math.atan2(sun[1], sun[0]) + 0.5, el: 0.35 });
      return;
    }
    if (this.surfaceOn) this.surfaceSrc = { kind: 'entity', id };
    else if (this.followFn(this.tmp, clock.now())) this.rig.flyTo(viewFor(this.tmp));
    if (req) this.applyAutoSurface(req);
  }

  // ------------------------------------------------------------------ camera modes and fit

  get surfaceMode(): boolean {
    return this.surfaceOn;
  }

  /** The user's S / SURFACE: switch the view, and remember the choice so the surface view neither comes back nor stays away by itself. */
  toggleSurface(): void {
    const on = !this.surfaceOn;
    this.setSurfaceMode(on);
    if (this.surfaceOn === on) {
      this.surfaceAuto = on;
      saveSurfacePref(on);
    }
  }

  /**
   * The surface view is Earth-only: not while the camera follows a body other than the Earth (the focus entity, read from
   * `followId`, so it is never a stale body), nor while the frame of reference is such a body (any other entity as the frame
   * is fine). The one place to adapt for other bodies.
   */
  private surfaceAvailable(): boolean {
    const followed = this.followedRec();
    if (followed && isBodyEntity(followed) && !isEarthCentre(followed.id)) return false;
    return isEarthCentre(this.frameCentre) || !this.bodyIds.has(this.frameCentre);
  }

  /**
   * Surface-aligned camera: centred on the selected object, a launch pad being focused or the point under the view
   * centre, with the local vertical up and north-up, so the horizon is level and the Earth blocks the stars below it.
   * Leaving flies back to the globe view of the same place.
   */
  setSurfaceMode(on: boolean): void {
    if (on === this.surfaceOn) return;
    if (on) {
      if (!this.surfaceAvailable()) return;
      const src = this.pickSurfaceSource();
      if (!src) return;
      this.globeDist = this.rig.dist;
      this.surfaceSrc = src;
      const dist = this.surfaceDist(src);
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
      if (this.bodyIds.has(rec.id)) continue; // the bodies are scenery here: the Sun on its shell would make FIT VISIBLE a deep-space view
      if (!matchesFilters(rec, this.filters) || isHiddenRec(rec, this.filters)) continue;
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
    const dist = view?.dist ?? fitDistanceClamped(radius, this.camera.fov, this.camera.aspect, FIT_MARGIN, MIN_TARGET_DIST_KM);
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

  private fixedToWorld(f: ArrayLike<number>, out: THREE.Vector3, t = clock.now()): void {
    const g = gmstRad(t);
    out.set(f[0] * Math.cos(g) - f[1] * Math.sin(g), f[0] * Math.sin(g) + f[1] * Math.cos(g), f[2]);
  }

  /** Where a fresh surface view centres: the followed object, the focused pad, else the ground point under the view centre. */
  private pickSurfaceSource(): SurfaceSource | null {
    const id = this.follow ? this.followId ?? (this.focusLatLon ? null : this.selectedId) : null;
    // a followed body (the Earth) is no object to stand on: the ground point under the view centre is used instead
    if (id && !this.bodyIds.has(id) && this.worldPos(id, clock.now(), this.tmp)) return { kind: 'entity', id };
    if (this.follow && this.focusLatLon) return { kind: 'latlon', ...this.focusLatLon };
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const c = this.camera.position;
    const b = c.dot(dir);
    const disc = b * b - (c.lengthSq() - RE * RE);
    const p = disc > 0 && -b - Math.sqrt(disc) > 0 ? c.clone().addScaledVector(dir, -b - Math.sqrt(disc)) : c.clone();
    return this.latLonOfWorld(p, false);
  }

  /** Geodetic latitude/longitude of a world point as a surface source; `keepAlt` keeps its height, else the source is on the ground. */
  private latLonOfWorld(p: THREE.Vector3, keepAlt: boolean): SurfaceSource | null {
    if (p.lengthSq() < 1) return null;
    const g = -gmstRad(clock.now());
    const fx = p.x * Math.cos(g) - p.y * Math.sin(g), fy = p.x * Math.sin(g) + p.y * Math.cos(g);
    const geo = fixedToGeodetic([fx, fy, p.z], EARTH);
    return { kind: 'latlon', lat: geo.lat, lon: geo.lon, alt: keepAlt ? Math.max(0, geo.alt) : 0 };
  }

  /** Pin an entity source to where the object is now, at its current height, so the view stays put over the rotating ground. */
  private freezeSurfaceSource(): void {
    const src = this.surfaceSrc;
    if (src?.kind !== 'entity' || !this.worldPos(src.id, clock.now(), this.tmp)) return;
    const ll = this.latLonOfWorld(this.tmp, true);
    if (ll) this.surfaceSrc = ll;
  }

  /** Height of an entity above the ellipsoid now, km, or null when it has no position. */
  private entityAltKm(id: string): number | null {
    return this.worldPos(id, clock.now(), this.tmp) ? altitudeOf([this.tmp.x, this.tmp.y, this.tmp.z]) : null;
  }

  /** Surface camera distance that frames an object together with the ground below it, or null when it has no position. */
  private surfaceFitDist(id: string): number | null {
    const alt = this.entityAltKm(id);
    return alt === null ? null : surfaceFitDistance(alt, this.camera.fov, this.camera.aspect);
  }

  /** Camera distance on entering the surface view of `src`: the object's fit, or a regional view of a ground point. */
  private surfaceDist(src: SurfaceSource | null): number {
    return (src?.kind === 'entity' ? this.surfaceFitDist(src.id) : null) ?? SURFACE_POINT_DIST_KM;
  }

  /**
   * End of focus(): decide whether the camera should be in the surface orientation for what was just focused. Entering
   * (or staying) is the default for anything near the Earth (`shouldAutoSurface`); a deep-space object, or a non-Earth
   * frame, takes the camera back to the globe view; a user who switched the surface view off keeps the globe view.
   * Internal refocuses (`nonce` 0: FIT in the surface view, MODEL) frame their own view and are left alone.
   */
  private applyAutoSurface(req: FocusRequest): void {
    if (req.nonce === 0) return;
    const id = req.id;
    const rec = id ? this.recs.get(id) ?? null : null;
    const alt = id ? this.entityAltKm(id) : 0;
    const want = shouldAutoSurface(rec, alt, { pref: this.surfaceAuto, earthCentred: this.surfaceAvailable() });
    if (!this.surfaceOn) {
      if (want) this.setSurfaceMode(true);
    } else if (want) {
      // another object (or pad): same view direction, refit distance for it
      this.rig.flyTo({ dist: this.surfaceDist(this.surfaceSrc), az: this.rig.az, el: this.rig.el });
    } else {
      this.setSurfaceMode(false);
      if (this.followFn?.(this.tmp, clock.now())) this.rig.flyTo(viewFor(this.tmp));
    }
  }

  /**
   * FIT of one entity while in surface view: stay in the view, follow the entity and refit so the object and the ground below
   * it are on screen. False when the entity has no position (the caller falls back to the globe fit).
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

  /**
   * A pan drag in surface view: slide the target along the ground. A followed object is let go first and the target stays
   * where the object was, at its height, over the rotating ground; the drag then moves it along the sphere at that height.
   */
  private panSurface(eastKm: number, northKm: number, frame: SurfaceFrame): void {
    if (!this.surfaceOn) return;
    if (this.follow) {
      this.setFollow(false);
      this.cb.onFollowChange?.(false);
    }
    this.freezeSurfaceSource();
    const src = this.surfaceSrc;
    if (src?.kind !== 'latlon') return;
    // slide the target over the sphere along the camera frame's own axes: a great-circle move crosses the poles, where
    // stepping latitude/longitude cannot (and where the longitude change per km blows up)
    if (!this.surfaceTarget(this.tmp, clock.now())) return;
    const move: V3 = [
      frame.e[0] * eastKm + frame.n[0] * northKm,
      frame.e[1] * eastKm + frame.n[1] * northKm,
      frame.e[2] * eastKm + frame.n[2] * northKm,
    ];
    const p = moveOnSphere([this.tmp.x, this.tmp.y, this.tmp.z], move);
    const ll = this.latLonOfWorld(this.tmp.set(p[0], p[1], p[2]), false);
    if (ll?.kind === 'latlon') this.surfaceSrc = { kind: 'latlon', lat: ll.lat, lon: ll.lon, alt: src.alt };
  }

  /** World position of the surface camera's target at sim time `t`: the object itself, or a point over the ground. Null when its source has no position. */
  private surfaceTarget(out: THREE.Vector3, t: number): boolean {
    const src = this.surfaceSrc;
    if (!src) return false;
    if (src.kind === 'entity') return this.worldPos(src.id, t, out);
    this.fixedToWorld(geodeticToFixed({ lat: src.lat, lon: src.lon, alt: src.alt ?? 0 }, EARTH), out, t);
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
      detail: this.detail.stats,
      detailEnabled: this.detail.enabled,
      surface: this.surfaceOn,
      path: this.pathStatus.active && plan ? { pastMs: plan.t0 - now, futureMs: plan.t1 - now } : null,
      scope: { mode: this.scopeMode, ...this.scopeCounts },
      frame: { label: centreLabel(this.frameCentre, (id) => this.recs.get(id)), isDefault: isEarthCentre(this.frameCentre), locked: this.frameLocked },
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
   * Earth map: the single high-resolution file (`npm run assets`, 8192 px) when it exists, else the procedural shading
   * stays (there is no lower-resolution fallback; close views use the streamed DETAIL tiles). A map wider than the GPU's
   * maximum texture size is scaled down to that size rather than dropped, so a small GPU still gets the best map it can
   * hold. A missing file shows up as a failed load (the dev server answers with its HTML page).
   */
  private loadEarthTexture(): void {
    const max = this.renderer.capabilities.maxTextureSize;
    const apply = (tex: THREE.Texture) => {
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      this.earthMat.uniforms.uTex.value?.dispose?.();
      this.earthMat.uniforms.uTex.value = tex;
      this.earthMat.uniforms.uHasTex.value = 1;
    };
    new THREE.TextureLoader().load(
      '/textures/earth-hires.jpg',
      (tex) => {
        if (this.disposed) return tex.dispose();
        const img = tex.image as HTMLImageElement;
        if (img.width <= max) {
          console.info(`[earth] using earth-hires.jpg (${img.width} x ${img.height})`);
          return apply(tex);
        }
        // too wide for this GPU: scale down to the limit (keeping the aspect ratio) instead of dropping the map
        const canvas = document.createElement('canvas');
        canvas.width = max;
        canvas.height = Math.max(1, Math.round((max * img.height) / img.width));
        canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
        tex.dispose();
        console.info(`[earth] using earth-hires.jpg scaled from ${img.width} to ${max} px (GPU texture limit)`);
        apply(new THREE.CanvasTexture(canvas));
      },
      undefined,
      () => console.info('[earth] earth-hires.jpg is missing: procedural Earth (run npm run assets, then reload the page)'),
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
    for (const rec of this.recs.values()) if (!isSgp4(rec) && rec.provider && !this.bodyIds.has(rec.id)) ids.push(rec.id);
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
    const vis = (rec: EntityRecord | undefined, hidden = false): Visibility => (!rec || hidden ? 'hide' : sceneVisibility(rec, this.filters, rec.id === this.selectedId));
    // with a filter on, the objects it lets through ('show') are exempt from the scope policy
    const filtering = filtersActive(this.filters);
    const exemptRec = (rec: EntityRecord | undefined) => !!rec && colorKeyOf(rec) === 'vehicle';
    this.satKeep = new Uint8Array(this.propagator.ids.length);
    this.satExempt = new Uint8Array(this.propagator.ids.length);
    this.propagator.ids.forEach((id, i) => {
      const rec = this.recs.get(id);
      const v = vis(rec, id === this.selectedId);
      paint(this.sats, i, rec, v);
      if (filtering && v === 'show') this.satKeep[i] = 1;
      if (exemptRec(rec)) this.satExempt[i] = 1;
    });
    this.sats.color.needsUpdate = this.sats.size.needsUpdate = this.sats.glyph.needsUpdate = true;
    this.dynKeep = new Uint8Array(this.dynIds.length);
    this.dynExempt = new Uint8Array(this.dynIds.length);
    this.dynIds.forEach((id, i) => {
      const rec = this.recs.get(id);
      const v = vis(rec);
      paint(this.dyn, i, rec, v);
      this.dynBaseSize[i] = this.dyn.size.getX(i);
      if (filtering && v === 'show') this.dynKeep[i] = 1;
      if (exemptRec(rec)) this.dynExempt[i] = 1;
    });
    this.dyn.color.needsUpdate = this.dyn.size.needsUpdate = this.dyn.glyph.needsUpdate = true;
    this.scopeDirty = true;
    this.labelsDirty = true;
    this.labelFeatured = null;
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
      // body entities have their own rule (selected / followed / frame centre), below
      if ((rec.render?.orbitLine || rec.render?.footprint) && hinted < HINT_LIMIT && !this.bodyIds.has(rec.id) && !isHiddenRec(rec, this.filters)) {
        want.set(rec.id, false);
        hinted++;
        graph.upsert(rec);
      }
    }
    this.bodyLines = this.currentBodyLines();
    this.bodyLineKey = this.bodyLines.join(',');
    for (const id of this.bodyLines) want.set(id, false);
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
    const pathId = sel && !isSgp4(sel) && sel.provider && sel.provider.type !== 'geodetic' && !this.bodyIds.has(sel.id) ? sel.id : null;
    if (pathId !== this.pathOverlayId) {
      this.pathOverlay?.dispose();
      this.pathOverlay = null;
      this.pathOverlayId = pathId;
      this.setPathHover(null);
      this.pathStatus = { active: false, frame: 'inertial', plan: null };
      if (sel && pathId) this.pathOverlay = new PathOverlay(this.scene, this.pointMat, this.palette.colors[colorKeyOf(sel)]);
    }
  }

  /** Body entities that get an orbit line now (lib/body-scene.ts `bodyLineIds`). */
  private currentBodyLines(): string[] {
    if (this.bodyIds.size === 0) return [];
    return bodyLineIds(this.recs.values(), { selectedId: this.selectedId, frame: this.frameCentre });
  }

  // ------------------------------------------------------------------ geometry queries

  /**
   * World (ECI) position of an entity at sim time `t`, float64. A body entity is where its mesh is (`refDisplay`), so
   * focus, follow, frame and orbit lines agree.
   */
  private worldPos(id: string, t: number, out: THREE.Vector3): boolean {
    const rec = this.recs.get(id);
    const body = rec && bodyOf(rec);
    if (body !== undefined) {
      const d = refDisplay(body, t);
      out.set(d.r[0], d.r[1], d.r[2]);
      return true;
    }
    const s = graph.stateIn(id, t, 'EARTH:inertial');
    if (!s) return false;
    // a few-metre nudge for ground contact (shared with the path overlay)
    const r = liftNearSurface(s.r);
    out.set(r[0], r[1], r[2]);
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
    if (this.bodyIds.has(id)) return this.worldPos(id, clock.now(), out); // a drawn body (hover ring)
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
   * Every visible object near a screen point, highest in the hierarchy first, then newest (lib/pick.ts does the scan).
   * Points hidden behind the Earth (or the Moon and Sun, through `occ`), filtered out or out of scope are skipped, and so are
   * the non-exempt ones over a small, far body's disc (`discCones`, the point shader's own test): the click then finds the
   * body. A plain click uses the first entry, so it agrees with the popup's list; hover takes the nearest object (`nearestFirst`).
   */
  private pickMetaCache: ReturnType<typeof pickMeta> | null = null; // rank and creation time by id, rebuilt after a catalog change
  private pickAll(
    px: number, py: number, max: number, wantTotal = false, nearestFirst = false,
  ): { ids: string[]; total: number } {
    const meta = (this.pickMetaCache ??= pickMeta(this.recs.values()));
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
    // the drawn bodies (Earth, Moon, Sun, Mars) are listed only where no object is (lib/pick.ts `resolvePick`): the Earth's
    // disc must not turn a click on a satellite drawn over it into a choice popup when zoomed in
    const bodies = () => bodyPickExtras(this.celestial.bodies(), { origin: this.frameInfo.originV3, m, w, h, px, py, fovDeg: this.camera.fov });
    const cones = this.discCones;
    const r = gatherWithBodies(
      [source(this.sats, this.propagator.ids, 0), source(this.dyn, this.dynIds, 60)], extras, bodies, m, w, h, px, py,
      {
        max, wantTotal, nearestFirst, ranks: meta.ranks, created: meta.created, occluded: (x, y, z) => this.occludedRel(x, y, z),
        discHidden: (x, y, z) => hiddenByDisc(x, y, z, cones),
      },
    );
    return { ids: r.items.map((i) => i.id), total: r.total };
  }

  /** What hover lands on: the nearest visible object, or the body whose disc the hidden objects are over. */
  private pick(px: number, py: number): string | null {
    return this.pickAll(px, py, 1, false, true).ids[0] ?? null;
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
      if (e.buttons) {
        this.setHover(null);
        this.setPathHover(null);
      }
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
      // one candidate selects it (a body too: objects over a small far body are hidden, so that click lands on the body); several open the choice popup
      const { ids, total } = this.pickAll(p.x, p.y, POPUP_MAX, true);
      // the trajectory is the lowest priority: below every object and the popup. Over a body alone (zoomed in, the Earth's
      // disc covers the view) it still wins, or a path over the globe could not be clicked
      if (ids.every((id) => this.bodyIds.has(id))) {
        const hit = this.pathHitAt(p.x, p.y);
        if (hit && this.cb.onPathSeek) {
          this.setHover(null);
          this.setPathHover(null);
          this.cb.onPathSeek({ id: hit.id, tMs: hit.tMs });
          return;
        }
      }
      if (ids.length === 1 || (ids.length > 1 && !this.cb.onPickMany)) this.cb.onPick(ids[0]);
      else if (ids.length > 1) {
        this.setHover(null);
        this.cb.onPickMany?.(ids, total, p.x, p.y);
      }
    };
    const onLeave = () => {
      this.mouse = null;
      this.setHover(null);
      this.setPathHover(null);
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

  /**
   * The selected launch path under a screen point, or null: nearest point of the drawn polyline within PATH_HIT_PX
   * (lib/path-pick.ts, in screen space, so it is right in any frame and view), not hidden behind a body.
   */
  private pathHitAt(px: number, py: number): (PathHit & { id: string }) | null {
    const po = this.pathOverlay, id = this.pathOverlayId;
    if (!po || !id || !this.pathStatus.active || !this.cb.onPathSeek) return null;
    const s = po.pickSamples();
    if (!s) return null;
    const m = new THREE.Matrix4().multiplyMatrices(this.rcam.projectionMatrix, this.rcam.matrixWorldInverse).elements;
    const hit = nearestOnPath({
      rel: s.rel, times: s.times, count: s.count, m, w: this.container.clientWidth, h: this.container.clientHeight, px, py,
      occluded: (x, y, z) => this.occludedRel(x, y, z),
    });
    return hit && { ...hit, id };
  }

  /** Hover state of the trajectory: highlight, pointer cursor and the callback (tooltip); called with null to clear. */
  private setPathHover(hit: (PathHit & { id: string }) | null, x = 0, y = 0): void {
    const was = this.pathHover;
    this.pathHover = hit;
    this.pathOverlay?.setHighlight(!!hit);
    if (hit || was) this.renderer.domElement.style.cursor = hit || this.hoverId ? 'pointer' : '';
    if (hit) this.cb.onPathHover?.({ id: hit.id, tMs: hit.tMs, x, y, sx: hit.sx, sy: hit.sy });
    else if (was) this.cb.onPathHover?.(null);
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
    let focusBody: string | undefined;
    if (this.surfaceOn) {
      anchored = this.surfaceTarget(this.anchor, t);
      if (!anchored) this.setSurfaceMode(false); // the anchored object lost its position: back to the globe
      // an object may be approached as in the globe view (the camera itself still stops MIN_ALT_KM above the ground)
      const src = this.surfaceSrc;
      this.rig.minDist = src?.kind === 'entity' ? this.models.defOf(src.id)?.minViewKm ?? MIN_TARGET_DIST_KM : MIN_ALT_KM;
    } else {
      anchored = this.follow && this.followFn ? this.followFn(this.anchor, t) : false;
      if (!anchored && this.groundLock) this.fixedToWorld(this.groundLock, this.freeTarget, t);
      // orbiting the Earth's centre: stop MIN_ALT_KM above the ground; orbiting an object: nearly touching it is fine
      const modelMin = anchored ? this.models.defOf(this.followId)?.minViewKm : undefined;
      focusBody = anchored ? this.followedBody() : undefined;
      const bodyMin = focusBody ? refMinDistKm(focusBody) : undefined;
      this.rig.minDist = anchored || this.freeTarget.lengthSq() > 1 ? bodyMin ?? modelMin ?? MIN_TARGET_DIST_KM : RE + MIN_ALT_KM;
    }
    this.rig.update(anchored ? this.anchor : null, this.freeTarget, wall);
    this.updateDetail(wall);

    this.prepareRender(gmst, t);
    this.updateModels(t);
    this.refreshScope(wall);

    if (this.mouse && wall - this.lastPickAt > 40 && !this.rig.flying) {
      this.lastPickAt = wall;
      const id = this.pick(this.mouse.x, this.mouse.y);
      // the trajectory under the cursor wins over a body (the Earth's disc covers the view) but never over an object
      const onPath = !this.previewId && (!id || this.bodyIds.has(id)) ? this.pathHitAt(this.mouse.x, this.mouse.y) : null;
      if (onPath) {
        if (this.hoverId) this.setHover(null);
      } else if (id || this.hoverId) this.setHover(id, this.mouse.x, this.mouse.y);
      this.setPathHover(onPath, this.mouse.x, this.mouse.y);
    }

    this.renderer.render(this.scene, this.rcam);
    this.updatePathLabels();
    this.updateLabels(wall);
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
    this.celestial.update(t, f.origin);

    const u = this.pointMat.uniforms;
    u.uOriginS.value.set(f.origin.x, f.origin.y, f.origin.z * ELLIPSOID_K);
    u.uC2.value = occlusionC2(f.originV3);
    u.uOccK.value = ELLIPSOID_K;
    // the displayed Moon and Sun hide what is behind them like the Earth does (shader uniforms, same maths as `this.occ`)
    // (the shader has uniforms for exactly two: [Moon, Sun]; every other drawn body, Mars, hides CPU-side points only)
    const shaderBodies = this.celestial.shaderSpheres();
    const sph = [u.uSph0.value, u.uSph1.value];
    for (let i = 0; i < 2; i++) {
      const sv = sphereView(f.originV3, shaderBodies[i]);
      sph[i].set(sv.x, sv.y, sv.z, sv.r);
      u.uSphC2.value.setComponent(i, sv.c2);
    }
    this.occ = makeOccluder(f.originV3, undefined, this.celestial.occluders());

    // small, far bodies hide the non-exempt points over their disc: one cone per drawn body (a uniform update, no buffer upload)
    const o = f.originV3;
    this.discCones = discGroups(
      this.celestial.bodies().map((b) => ({ rel: [b.c[0] - o[0], b.c[1] - o[1], b.c[2] - o[2]] as V3, radiusKm: b.radiusKm, k: b.k, reachKm: isEarthCentre(b.entityId) ? EARTH_SYSTEM_REACH_KM : 0, depthKm: isEarthCentre(b.entityId) ? EARTH_SYSTEM_DEPTH_KM : 0 })),
      this.camera.fov, this.container.clientHeight,
    );
    this.discCones.forEach((g, i) => {
      u.uGroup.value[i].set(g.x, g.y, g.z, g.sinR);
      u.uGroupD.value[i] = g.dist;
      u.uGroupE.value[i].set(g.shell, g.back);
    });

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
        return { r: liftNearSurface(s.r), v: s.v };
      },
      visibility: (id) => {
        const r = rec(id);
        return r ? sceneVisibility(r, this.filters, id === this.selectedId) : 'hide';
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
    const sel = this.selectedId, hov = this.hoverId, fol = this.followId;
    const f = this.frameInfo;
    const occluded = this.occ; // built by prepareRender this frame: the Earth, the Moon and the Sun
    const m = new THREE.Matrix4().multiplyMatrices(this.rcam.projectionMatrix, this.rcam.matrixWorldInverse).elements;
    let total = 0, rendered = 0;
    const tmp = this.tmp2;

    // `exemptFlags`: 1 = launch vehicle, stage or capsule. The selected, hovered and followed point, the ones a filter lets
    // through and the flagged ones in flight get aShow = 2, which the point shader and pickAll never hide over a small body's
    // disc; every other point (related, labelled, pads, ground stations) is scoped in by `keep` but hides over a small disc
    // like the cloud
    const scan = (set: PointSet, ids: readonly string[], bulk: boolean, keepFlags: Uint8Array | null, exemptFlags: Uint8Array | null) => {
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
        // an object the user filtered for is never hidden over a small disc, or a zoomed-out filter would show nothing
        const kept = keepFlags !== null && keepFlags[i] === 1;
        const exempt = id === sel || id === hov || id === fol || kept || (exemptFlags !== null && exemptFlags[i] === 1 && Math.hypot(w.x, w.y, w.z) > RE + IN_FLIGHT_KM);
        const v = inScope({ d, key: i, bulk, keep }, radius, mode) ? (exempt ? SHOW_EXEMPT : 1) : 0;
        if (show[i] !== v) {
          show[i] = v;
          changed = true;
        }
        if (v === 0 || size[i] <= 0) continue;
        const x = rel[i * 3], y = rel[i * 3 + 1], z = rel[i * 3 + 2];
        if (!inView(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[3] * x + m[7] * y + m[11] * z + m[15])) continue;
        if (!occluded(x, y, z) && (v === SHOW_EXEMPT || !hiddenByDisc(x, y, z, this.discCones))) rendered++;
      }
      if (changed) set.show.needsUpdate = true;
    };
    scan(this.sats, this.propagator.ids, true, this.satKeep, this.satExempt);
    scan(this.dyn, this.dynIds, false, this.dynKeep, this.dynExempt);
    scan(this.pads, this.launches.map((l) => l.entityId), false, null, null);
    this.scopeCounts = { rendered, total };

    // light overlays (orbit line, footprint) of entities that are scoped out are not drawn either
    this.overlayInScope.clear();
    for (const id of this.overlays.keys()) {
      const keep = id === sel || this.related.has(id) || this.bodyIds.has(id); // a body line is already limited to what is looked at
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
    this.selOk = ok;
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
    const centre = this.frameCentre;
    this.ensureCentreInGraph(); // the record may have been replaced by a refresh
    // the body lines depend on the selection and the frame: re-evaluate every frame (4 records)
    if (this.bodyIds.size && this.currentBodyLines().join(',') !== this.bodyLineKey) this.refreshHints();
    for (const [id, o] of this.overlays) {
      const rec = this.recs.get(id);
      if (!rec) continue;
      if (this.overlayInScope.get(id) === false) o.hide();
      else o.update(graph, rec, t, wall, this.fullOverlays.has(id), centre);
    }
    const po = this.pathOverlay, rec = this.pathOverlayId ? this.recs.get(this.pathOverlayId) : undefined;
    if (po && rec) this.pathStatus = po.update(graph, rec, t, wall, this.overlays.get(rec.id)?.hasOrbit ?? false, centre);
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

  // ------------------------------------------------------------------ object labels (lib/labels.ts decides, scene/LabelLayer.ts draws)

  /** Names next to objects (the LABELS toggle). Off: nothing is projected and nothing is drawn. */
  setLabelsEnabled(on: boolean): void {
    this.labelsOn = on;
    this.labelsDirty = true;
  }

  /** Ids with `render.label: true` that are not bodies (bodies have their own pass, `labelBody`). */
  private featuredIds(): Set<string> {
    let set = this.labelFeatured;
    if (!set) {
      set = this.labelFeatured = new Set();
      for (const rec of this.recs.values()) if (rec.render?.label === true && !this.bodyIds.has(rec.id)) set.add(rec.id);
    }
    return set;
  }

  /** Clip-space key of point `i` of `set` for the label scan: distance from the screen centre in NDC, or -1 when it is not drawn. */
  private labelKey(set: PointSet, i: number, m: ArrayLike<number>): number {
    if ((set.size.array as Float32Array)[i] <= 0 || (set.show.array as Float32Array)[i] < 0.5) return -1; // filtered out, scoped out, replaced by a model
    const wd = set.pos.world;
    if (wd[i * 3] === 0 && wd[i * 3 + 1] === 0 && wd[i * 3 + 2] === 0) return -1; // no position
    const rel = set.pos.attr.array as Float32Array;
    const x = rel[i * 3], y = rel[i * 3 + 1], z = rel[i * 3 + 2];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    if (!inView(cx, cy, cw) || this.occ(x, y, z) || this.discHiddenPoint(set, i, x, y, z)) return -1;
    return Math.hypot(cx / cw, cy / cw);
  }

  /** Is point `i` of `set` not drawn because it is over a small, far body (the shader's `aShow` test)? Its label goes with it. */
  private discHiddenPoint(set: PointSet, i: number, x: number, y: number, z: number): boolean {
    return (set.show.array as Float32Array)[i] < SHOW_EXEMPT_MIN && hiddenByDisc(x, y, z, this.discCones);
  }

  private addLabelCand(sat: boolean, i: number, id: string, feat: boolean): void {
    let c = this.labelCands[this.labelCandN];
    if (!c) c = this.labelCands[this.labelCandN] = { sat, i, id, text: '', feat };
    c.sat = sat;
    c.i = i;
    c.id = id;
    c.feat = feat;
    c.text = labelText(this.recs.get(id)?.name ?? id);
    this.labelCandN++;
  }

  /**
   * Which point objects may carry a label, ~7 times a second (positions are re-projected every frame by `updateLabels`).
   * With a filter active: the objects it lets through that are drawn, in view and not hidden behind a body; entities with
   * `render.label` always qualify, the others (satellites) are thinned to the `LABEL_SCAN_KEEP` nearest the screen centre
   * per point set. Without a filter: only the `render.label` entities.
   */
  private scanLabelCands(wall: number, m: ArrayLike<number>): void {
    if (!this.labelsDirty && wall - this.lastLabelScanAt < 150) return;
    this.labelsDirty = false;
    this.lastLabelScanAt = wall;
    this.labelCandN = 0;
    const feat = this.featuredIds();
    const sel = this.selectedId;
    if (!filtersActive(this.filters)) {
      for (const id of feat) {
        if (id === sel) continue;
        const si = this.satIndex.get(id);
        if (si !== undefined) {
          if (this.labelKey(this.sats, si, m) >= 0) this.addLabelCand(true, si, id, true);
          continue;
        }
        const di = this.dynIndex.get(id);
        if (di !== undefined && this.labelKey(this.dyn, di, m) >= 0) this.addLabelCand(false, di, id, true);
      }
      return;
    }
    const scan = (sat: boolean, set: PointSet, ids: readonly string[], keep: Uint8Array) => {
      const n = Math.min(ids.length, keep.length);
      if (this.labelKeys.length < n) {
        this.labelKeys = new Float32Array(n);
        this.labelIdx = new Int32Array(n);
      }
      let found = 0;
      for (let i = 0; i < n; i++) {
        if (keep[i] !== 1 || ids[i] === sel) continue;
        const key = this.labelKey(set, i, m);
        if (key < 0) continue;
        if (feat.has(ids[i])) this.addLabelCand(sat, i, ids[i], true);
        else {
          this.labelKeys[found] = key;
          this.labelIdx[found++] = i;
        }
      }
      const k = selectNearest(this.labelKeys, found, LABEL_SCAN_KEEP, 2, this.labelPick, this.labelCounts);
      for (let j = 0; j < k; j++) {
        const i = this.labelIdx[this.labelPick[j]];
        this.addLabelCand(sat, i, ids[i], false);
      }
    };
    scan(true, this.sats, this.propagator.ids, this.satKeep);
    scan(false, this.dyn, this.dynIds, this.dynKeep);
  }

  /** Every frame: project the labelled objects, let the planner choose and place them, hand the result to the DOM layer. */
  private updateLabels(wall: number): void {
    const cb = this.cb.onLabels;
    if (!cb) return;
    const plan = this.labelPlan;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!this.labelsOn || w < 1 || h < 1) {
      if (this.hadLabels) cb(plan.out, 0);
      this.hadLabels = false;
      return;
    }
    const m = this.labelM.multiplyMatrices(this.rcam.projectionMatrix, this.rcam.matrixWorldInverse).elements;
    this.scanLabelCands(wall, m);
    plan.begin();
    this.labelW = w;
    this.labelH = h;

    // bodies: their own pass (not points); the name fades as the disc grows
    this.celestial.eachBody(this.labelBody);

    const sel = this.selectedId, hov = this.hoverId;
    // the selection (drawn from the highlight set whatever it is); a selected body is a body label
    if (sel && this.selOk && !this.bodyIds.has(sel)) {
      const a = this.hi.pos.attr;
      this.projectLabel(a.getX(0), a.getY(0), a.getZ(0), sel, labelText(this.recs.get(sel)?.name ?? sel), 'selected', 14);
    }
    for (let n = 0; n < this.labelCandN; n++) {
      const c = this.labelCands[n];
      const set = c.sat ? this.sats : this.dyn;
      if ((c.sat ? this.propagator.ids[c.i] : this.dynIds[c.i]) !== c.id) continue; // the catalogue changed since the scan
      if ((set.size.array as Float32Array)[c.i] <= 0) continue;
      const rel = set.pos.attr.array as Float32Array;
      if (c.id !== hov && this.discHiddenPoint(set, c.i, rel[c.i * 3], rel[c.i * 3 + 1], rel[c.i * 3 + 2])) continue; // its icon is not drawn over a small body's disc
      this.projectLabel(rel[c.i * 3], rel[c.i * 3 + 1], rel[c.i * 3 + 2], c.id, c.text, c.id === hov ? 'hover' : c.feat ? 'featured' : 'satellite', 9);
    }
    const n = plan.plan(w, h);
    cb(plan.out, n);
    this.hadLabels = n > 0;
  }

  /** Add a label for the camera-relative point (x, y, z) unless it is out of view or behind a body. */
  private projectLabel(x: number, y: number, z: number, id: string, text: string, cls: LabelClass, dx: number): void {
    const m = this.labelM.elements;
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    if (!inView(cx, cy, cw) || this.occ(x, y, z)) return;
    this.labelPlan.add(id, text, cls, (cx / cw * 0.5 + 0.5) * this.labelW, (0.5 - cy / cw * 0.5) * this.labelH, dx);
  }

  /** One body for the label pass (a bound arrow function: no closure per frame). Only bodies whose entity says `render.label`. */
  private readonly labelBody = (entityId: string, c: readonly [number, number, number], radiusKm: number, k: number): void => {
    const rec = this.recs.get(entityId);
    if (rec?.render?.label !== true) return;
    const o = this.frameInfo.origin;
    const x = c[0] - o.x, y = c[1] - o.y, z = c[2] - o.z; // camera-relative, float64
    const dist = Math.hypot(x, y, z), r = radiusKm * k;
    const rpx = apparentRadiusPx(dist, r, this.camera.fov, this.labelH);
    const opacity = bodyLabelOpacity(rpx);
    if (opacity <= 0 || dist <= r * 1.02) return;
    // the centre is inside the body's own occluder sphere: test a point just in front of its near surface instead
    const s = 1 - (r * 1.02) / dist;
    if (this.occ(x * s, y * s, z * s)) return;
    const m = this.labelM.elements;
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    if (!inView(cx, cy, cw)) return;
    const cls: LabelClass = entityId === this.selectedId ? 'selected' : entityId === this.hoverId ? 'hover' : 'body';
    this.labelPlan.add(entityId, rec.name, cls, (cx / cw * 0.5 + 0.5) * this.labelW, (0.5 - cy / cw * 0.5) * this.labelH, Math.min(rpx, 120) + 7, opacity);
  };
}
