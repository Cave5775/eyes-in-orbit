import * as THREE from 'three';
import { EARTH, MOON, SUN, bodyOf, defaultBodies, isBodyEntity, type Body, type EntityRecord } from '@eio/core';
import { bodyFixedToInertial, fitMapSize, poleDirection } from '../lib/body-map';
import { BODY_TEXTURES, MAP_LOAD_PX, textureOf, type BodyTexture } from '../lib/body-textures';
import { MARKER_BELOW_PX, MARKER_SIZE_PX, bodyStyle, hexRgb } from '../lib/body-style';
import type { AssetCache } from '../lib/asset-cache';
import { BODY_SHAPES, MESH_LOAD_PX, baseEllipsoid, ellipsoidScale, meshWanted, type BodyShape, type MeshShape } from '../lib/body-shape';
import { bodyDiscRadiusPx, SHOW_EXEMPT } from '../lib/pick';
import { bodyShown } from '../lib/scope';
import { SUN_I, lightRig } from '../lib/shading';
import type { DrawnBody } from '../lib/body-scene';
import type { SceneBody } from '../lib/occlusion';
import { EARTH_SYSTEM_DEPTH_KM, EARTH_SYSTEM_REACH_KM } from '../lib/disc-hide';
import { isRegistryBody, refDisplay, refPositionEci, refRadiusKm } from '../lib/ref-body';
import { createBodyMaterial, createMapMaterial, createRingGeometry, createRingMaterial } from './materials';
import { MODEL_ASSETS, type LoadedGlb } from './models/glb';

/**
 * Bodies drawn with a map (file in /textures, `npm run assets`): a sphere of the body's equatorial radius (the flattening,
 * 1/169.8 for Mars, is ignored: the maps are sphere-based simple cylindrical) oriented by its IAU rotation. Until the file
 * has loaded (or when it is missing) the body keeps its tinted sphere. Only Mars is loaded eagerly like this; the other bodies
 * with a map (lib/body-textures.ts) load it lazily when their disc is big enough (`updateTextures`) and keep their flattening.
 */
function eagerMap(bodyId: string, table: Readonly<Record<string, BodyTexture>>): { body: Body; file: string } | undefined {
  const t = textureOf(bodyId, table);
  return t?.eager && defaultBodies.has(bodyId) ? { body: defaultBodies.get(bodyId), file: t.file } : undefined;
}

/** What the layer needs from the renderer and the loader; the defaults are for tests (no GPU). */
export interface MapEnv {
  maxTextureSize: () => number;
  maxAnisotropy: () => number;
  /** loads an image as a texture; `onError` also covers a response that is no image (the dev server answers a missing file with its HTML page) */
  loadTexture: (url: string, onLoad: (tex: THREE.Texture) => void, onError: () => void) => void;
  /**
   * The scene's point material (scene/materials.ts `createPointMaterial`): with it the layer draws a small marker glyph for a body
   * whose disc is under `MARKER_BELOW_PX` px (`updateMarkers`). Its occluder and cone uniforms are the scene's, so a marker is hidden
   * behind a body exactly as a satellite is. Absent (tests without a GPU): no markers.
   */
  pointMaterial?: THREE.Material;
  /** body maps by registry id (default `BODY_TEXTURES`, lib/body-textures.ts); `eager: true` loads at build; a test passes its own */
  textures?: Readonly<Record<string, BodyTexture>>;
  /** body shapes by registry id (default `BODY_SHAPES`, lib/body-shape.ts); a test passes its own */
  shapes?: Readonly<Record<string, BodyShape>>;
  /** where body meshes are loaded from (default `MODEL_ASSETS`, the cache the entity models use) */
  meshes?: AssetCache<LoadedGlb>;
}

const DEFAULT_ENV: MapEnv = {
  maxTextureSize: () => 4096,
  maxAnisotropy: () => 1,
  loadTexture: (url, onLoad, onError) => { new THREE.TextureLoader().load(url, onLoad, undefined, () => onError()); },
};

/** Sphere geometry as the Earth and Moon use it: local z = pole, +x = prime meridian at the map centre (u = 0.5), u growing east. */
export function createMapSphere(radiusKm: number, widthSegments = 128, heightSegments = 64): THREE.SphereGeometry {
  const g = new THREE.SphereGeometry(radiusKm, widthSegments, heightSegments);
  g.rotateX(Math.PI / 2);
  return g;
}

/** Bodies with a flattening under this are drawn as spheres (the Moon's 0.0012 is under a pixel at any distance a sphere would show it). */
const MIN_DRAWN_FLATTENING = 0.002;

/**
 * One body the layer knows: its entity, where it is displayed and (all but the Earth) its meshes. It IS the `SceneBody` the
 * occluders, the disc cones, the picker and the labels read (`CelestialLayer.bodies()`): a body added to the layer gets all of
 * them with no other code.
 */
interface Drawn extends SceneBody {
  entityId: string;
  bodyId: string;
  radiusKm: number;
  /** centre, km, and drawn-radius factor (always 1; set by `update`); `rel` = centre minus the camera (float64) */
  c: [number, number, number];
  rel: [number, number, number];
  k: number;
  /** meshes added to the scene (none for the Earth); `place` positions them relative to the camera */
  objects: THREE.Object3D[];
  /** set when the body leaves the layer (a map still loading is then dropped) */
  removed?: boolean;
  place?: (origin: THREE.Vector3, t: number) => void;
  /** a body with a detailed mesh (lib/body-shape.ts `MeshShape`): loaded while its disc is big enough, the sphere shows otherwise */
  mesh?: BodyMesh;
  /** a body with a lazily loaded surface map (lib/body-textures.ts) */
  tex?: BodyTex;
  /** glyph, label and pick area shown (lib/scope.ts `bodyShown`, set by `applyScope`); false for another planet's moon */
  shown: boolean;
}

/** The lazily loaded map of one body: requested while its disc is big, released (texture and material disposed) when it is small again. */
interface BodyTex {
  file: string;
  mesh: THREE.Mesh;
  sun: THREE.Vector3;
  /** the procedural material set aside while the map material is on the mesh */
  tinted: THREE.Material | null;
  held: boolean;
  /** bumped on every hold and drop: a load that finishes under an older number is discarded */
  gen: number;
  /** the normal correction of the procedural material (shared with the map material so the terminator does not jump at the swap) */
  inv2: THREE.Vector3;
  /** the file is not there (or no image): not asked for again this session */
  missing: boolean;
}

/** The mesh tier of one body: held (referenced in the cache) while its disc is big, attached to the scene once the file has loaded. */
interface BodyMesh {
  spec: MeshShape;
  held: boolean;
  /** the sphere drawn until the mesh is there (and again after it is dropped) */
  sphere: THREE.Mesh;
  group: THREE.Group | null;
  light: THREE.DirectionalLight | null;
  /** even light for the unshaded view (intensity 0 while the Sun lights the model) */
  ambient: THREE.AmbientLight | null;
}

/** The small glyphs of the bodies whose disc is too small to see (one `THREE.Points`, updated in place by `updateMarkers`). */
interface Markers {
  points: THREE.Points;
  pos: THREE.BufferAttribute;
  size: THREE.BufferAttribute;
  /** the bodies, in attribute order */
  bodies: Drawn[];
}

/**
 * The celestial bodies as the scene draws them, fed by the body ENTITIES (`setBodies`): a map keyed by registry id (each
 * entity's `bodyOf`, the one place the two meet here; the mesh to build depends on the body).
 * - the Moon (textured when /textures/moon.jpg loads, else procedural, IAU rotation) and the Sun (emissive disc and glow)
 *   look and sit exactly as before; Mars is a sphere with the USGS/Viking map (/textures/mars.jpg) on its IAU rotation, a tinted
 *   sphere until (or unless) it loads; any other registry body is a plain tinted sphere, both lit from the Sun's direction;
 * - the Earth is NOT drawn here (SceneController keeps its own mesh group); the layer only knows its centre, radius and
 *   flattening, so picking, labels, occluders and the disc cones see it with the others.
 * `bodies()` is the one list of what is drawn: the point shader's occluders (lib/occlusion.ts `OccluderSet`), the CPU
 * occlusion tests, the disc cones (lib/disc-hide.ts) and picking all derive from it.
 * Everything is drawn to scale at its true position (`refDisplay`, k = 1: the Sun at 1.5e8 km, Mars wherever it is). Like the
 * Earth they are placed camera-relative (float64 position minus the floating origin), so a camera 3,000 km from the Moon or 1.5e8 km from
 * the Earth sees them without float32 jitter.
 */
export class CelestialLayer {
  private readonly drawn = new Map<string, Drawn>();
  private readonly rot = new THREE.Matrix4();
  private disposed = false;
  private shaded = true;
  /** the bodies in layer order, rebuilt when the set changes (the objects are the `drawn` values, mutated by `update`) */
  private list: Drawn[] = [];
  /** `list` without the bodies `applyScope` hid (what picking sees) */
  private shownList: Drawn[] = [];
  private moonMat: THREE.ShaderMaterial | null = null;
  private markers: Markers | null = null;
  /** 'texture' once /textures/moon.jpg has loaded */
  mode: 'texture' | 'procedural' = 'procedural';

  private readonly env: MapEnv;

  constructor(private readonly scene: THREE.Scene, private readonly sunDir: THREE.Vector3, env: Partial<MapEnv> = {}) {
    this.env = { ...DEFAULT_ENV, ...env };
  }

  /** Sync with the body entities of the catalog (records that are not bodies, or name an unknown body, are ignored). */
  setBodies(recs: Iterable<EntityRecord>): void {
    const want = new Map<string, string>();
    for (const rec of recs) {
      if (!isBodyEntity(rec)) continue;
      const bodyId = bodyOf(rec);
      if (bodyId && isRegistryBody(bodyId)) want.set(bodyId, rec.id);
    }
    for (const [bodyId, d] of this.drawn) {
      if (want.has(bodyId)) continue;
      this.remove(d);
      this.drawn.delete(bodyId);
    }
    for (const [bodyId, entityId] of want) {
      const d = this.drawn.get(bodyId);
      if (d) d.entityId = entityId;
      else this.drawn.set(bodyId, this.create(bodyId, entityId));
    }
    this.list = [...this.drawn.values()];
    this.shownList = this.list.filter((d) => d.shown);
    this.buildMarkers();
  }

  /**
   * One marker per body, drawn through the scene's point shader (so a marker is hidden by the bodies in front of it like any
   * point) in a Points of its own: not part of any point set, so the scope policy never thins them, the disc cones skip them
   * (`aShow` = SHOW_EXEMPT) and they are not in the RENDERED count. Position and size are rewritten every frame; the colour is the body's style colour.
   */
  private buildMarkers(): void {
    this.disposeMarkers();
    const mat = this.env.pointMaterial;
    if (!mat || this.list.length === 0) return;
    const n = this.list.length;
    const geo = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    const size = new THREE.BufferAttribute(new Float32Array(n), 1);
    pos.setUsage(THREE.DynamicDrawUsage);
    size.setUsage(THREE.DynamicDrawUsage);
    const color = new Float32Array(n * 3);
    this.list.forEach((d, i) => {
      const c = hexRgb(bodyStyle(d.bodyId).color);
      for (let k = 0; k < 3; k++) color[i * 3 + k] = c[k] + (1 - c[k]) * 0.3; // a little paler than the disc: it must read on black
    });
    geo.setAttribute('position', pos);
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geo.setAttribute('aSize', size);
    geo.setAttribute('aGlyph', new THREE.BufferAttribute(new Float32Array(n).fill(2), 1)); // the ring glyph
    geo.setAttribute('aShow', new THREE.BufferAttribute(new Float32Array(n).fill(SHOW_EXEMPT), 1));
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 7;
    this.scene.add(points);
    this.markers = { points, pos, size, bodies: [...this.list] };
  }

  private disposeMarkers(): void {
    this.markers?.points.removeFromParent();
    this.markers?.points.geometry.dispose();
    this.markers = null;
  }

  /**
   * Show the marker of each body whose disc radius is under `MARKER_BELOW_PX` px for a camera with vertical field of view `fovDeg` on
   * a viewport `viewportPx` high, hide the rest (size 0); call after `update`. The marker sits on the sight line to the body's
   * centre, 1.5 radii nearer the camera, so the body's own occluder slot never hides it, whereas a body in front of it does. No allocation.
   */
  updateMarkers(fovDeg: number, viewportPx: number): void {
    const m = this.markers;
    if (!m) return;
    const p = m.pos.array as Float32Array, s = m.size.array as Float32Array;
    for (let i = 0; i < m.bodies.length; i++) {
      const d = m.bodies[i];
      const dist = Math.hypot(d.rel[0], d.rel[1], d.rel[2]);
      const r = d.radiusKm * d.k;
      if (!d.shown || !(dist > 0) || !(bodyDiscRadiusPx(d.radiusKm, d.k, dist, fovDeg, viewportPx) < MARKER_BELOW_PX)) {
        s[i] = 0;
        continue;
      }
      const f = 1 - (1.5 * r) / dist;
      p[i * 3] = d.rel[0] * f;
      p[i * 3 + 1] = d.rel[1] * f;
      p[i * 3 + 2] = d.rel[2] * f;
      s[i] = MARKER_SIZE_PX;
    }
    m.pos.needsUpdate = true;
    m.size.needsUpdate = true;
  }

  private create(bodyId: string, entityId: string): Drawn {
    const d: Drawn = {
      entityId, bodyId, radiusKm: refRadiusKm(bodyId), c: [0, 0, 0], rel: [0, 0, 0], k: 1, objects: [], shown: true,
    };
    if (bodyId === 'EARTH') {
      // the one ellipsoid; its low orbits (LEO shell) and GEO belt are what the disc cone hides (lib/disc-hide.ts)
      d.radiusKm = EARTH.radiusKm;
      d.flattening = EARTH.flattening;
      d.reachKm = EARTH_SYSTEM_REACH_KM;
      d.depthKm = EARTH_SYSTEM_DEPTH_KM;
    }
    if (bodyId === 'MOON') this.buildMoon(d);
    else if (bodyId === 'SUN') this.buildSun(d);
    else if (bodyId !== 'EARTH') this.buildGeneric(d, eagerMap(bodyId, this.env.textures ?? BODY_TEXTURES));
    for (const o of d.objects) {
      o.frustumCulled = false; // positions are huge and re-derived every frame; three's bounding sphere would be stale
      this.scene.add(o);
    }
    return d;
  }

  private remove(d: Drawn): void {
    d.removed = true;
    if (d.mesh?.held) this.dropMesh(d, d.mesh);
    for (const o of d.objects) {
      o.removeFromParent();
      (o as THREE.Mesh).geometry?.dispose?.();
      const mat = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      (mat?.uniforms?.uTex?.value as THREE.Texture | null | undefined)?.dispose();
      mat?.dispose();
    }
    d.tex?.tinted?.dispose();
    if (d.bodyId === 'MOON') this.moonMat = null;
  }

  private buildMoon(d: Drawn): void {
    d.radiusKm = MOON.radiusKm;
    // same convention as the Earth: local z = pole, +x = prime meridian
    const mat = createMapMaterial(this.sunDir, null);
    this.moonMat = mat;
    const moon = new THREE.Mesh(createMapSphere(MOON.radiusKm), mat);
    d.objects.push(moon);
    d.place = (origin, t) => {
      const m = refDisplay('MOON', t);
      moon.position.set(m.r[0] - origin.x, m.r[1] - origin.y, m.r[2] - origin.z);
      moon.scale.setScalar(m.k);
      this.orient(moon, MOON, t);
      d.c = [m.r[0], m.r[1], m.r[2]];
      d.k = m.k;
    };
    this.loadMoonTexture(mat);
  }

  private buildSun(d: Drawn): void {
    d.radiusKm = SUN.radiusKm;
    const sun = new THREE.Mesh(
      new THREE.SphereGeometry(SUN.radiusKm, 64, 32),
      new THREE.MeshBasicMaterial({ color: 0xfff1cf, toneMapped: false }),
    );
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: radialGlow(),
        color: 0xffe2a8,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    glow.scale.setScalar(SUN.radiusKm * 9);
    d.objects.push(sun, glow);
    d.place = (origin, t) => {
      const s = refDisplay('SUN', t);
      sun.position.set(s.r[0] - origin.x, s.r[1] - origin.y, s.r[2] - origin.z);
      sun.scale.setScalar(s.k);
      glow.position.copy(sun.position);
      glow.scale.setScalar(SUN.radiusKm * 9 * s.k);
      d.c = [s.r[0], s.r[1], s.r[2]];
      d.k = s.k;
    };
  }

  /** Orient a mesh built by `createMapSphere` as `body` is at `t`: body-fixed to inertial is the transpose of the IAU inertial-to-fixed matrix. */
  private orient(mesh: THREE.Object3D, body: Body, t: number): void {
    const R = bodyFixedToInertial(body, t);
    this.rot.set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1);
    mesh.quaternion.setFromRotationMatrix(this.rot);
  }

  /**
   * Mars and any other registry body: a lit sphere in its style's colour (lib/body-style.ts: bands for the giants, albedo noise
   * for solid bodies), pole on z and oriented by the IAU rotation each frame. A body with a flattening (Jupiter, Saturn, Uranus,
   * Neptune, Ceres) is squashed along that pole by (1 - f) and exposes the pole in `SceneBody.pole` so the occluders, disc cones
   * and picks see the same ellipsoid. A style with rings (Saturn) adds a ring mesh in the equatorial plane (not in the occluder
   * list, so it hides and picks nothing). With a `map` (Mars) the sphere gets the Moon's treatment: the map as soon as it has
   * loaded (the flattening, 1/169.8, stays ignored as before).
   */
  private buildGeneric(d: Drawn, map?: { body: Body; file: string }): void {
    const style = bodyStyle(d.bodyId);
    const body = map ? map.body : defaultBodies.has(d.bodyId) ? defaultBodies.get(d.bodyId) : undefined;
    const sunFromBody = new THREE.Vector3(1, 0, 0);
    // a sourced shape (lib/body-shape.ts) replaces the registry flattening: the tier-2 ellipsoid, or the fallback under a mesh
    const shape = (this.env.shapes ?? BODY_SHAPES)[d.bodyId];
    const ell = baseEllipsoid(shape);
    const axes = !map && ell ? ellipsoidScale(ell.radiiKm, refRadiusKm(d.bodyId)) : null;
    const f = !map && !axes && body && body.flattening >= MIN_DRAWN_FLATTENING ? body.flattening : 0;
    const mat = createBodyMaterial(sunFromBody, style, axes ? [1 / (axes[0] * axes[0]), 1 / (axes[1] * axes[1]), 1 / (axes[2] * axes[2])] : [1, 1, 1 / ((1 - f) * (1 - f))]);
    if (map) d.radiusKm = map.body.radiusKm;
    const mesh = new THREE.Mesh(createMapSphere(d.radiusKm, 96, 48), mat);
    d.objects.push(mesh);
    if (f > 0 && body) {
      d.flattening = f;
      d.pole = poleDirection(body);
    }
    let ring: THREE.Mesh | null = null;
    if (style.rings) {
      ring = new THREE.Mesh(createRingGeometry(style.rings), createRingMaterial(sunFromBody, style.rings));
      d.objects.push(ring);
    }
    d.place = (origin, t) => {
      const m = refDisplay(d.bodyId, t);
      mesh.position.set(m.r[0] - origin.x, m.r[1] - origin.y, m.r[2] - origin.z);
      if (axes) mesh.scale.set(m.k * axes[0], m.k * axes[1], m.k * axes[2]);
      else mesh.scale.set(m.k, m.k, m.k * (1 - f));
      if (body) this.orient(mesh, body, t);
      if (f > 0 && body) d.pole = poleDirection(body, t);
      if (ring) {
        ring.position.copy(mesh.position);
        ring.scale.setScalar(m.k);
        ring.quaternion.copy(mesh.quaternion);
      }
      // the real direction to the Sun from the body (not the Earth's)
      const p = refPositionEci(d.bodyId, t), s = refPositionEci('SUN', t);
      sunFromBody.set(s[0] - p[0], s[1] - p[1], s[2] - p[2]).normalize();
      d.c = [m.r[0], m.r[1], m.r[2]];
      d.k = m.k;
      const bm = d.mesh;
      if (bm?.group) {
        // the loaded model replaces the sphere: same place, same IAU orientation, drawn at the body's mean radius
        bm.group.position.copy(mesh.position);
        bm.group.quaternion.copy(mesh.quaternion);
        bm.group.scale.setScalar(d.radiusKm * m.k);
        bm.light?.position.copy(sunFromBody);
      }
    };
    if (shape?.kind === 'mesh') d.mesh = { spec: shape, held: false, sphere: mesh, group: null, light: null, ambient: null };
    if (map) this.loadMapTexture(d, mesh, sunFromBody, map.file);
    else {
      const spec = textureOf(d.bodyId, this.env.textures ?? BODY_TEXTURES);
      if (spec && !spec.eager) d.tex = { file: spec.file, mesh, sun: sunFromBody, tinted: null, held: false, gen: 0, missing: false, inv2: mat.uniforms.uInv2.value as THREE.Vector3 };
    }
  }

  /**
   * Surface maps (lib/body-textures.ts): request a body's map while its disc is at least `MAP_LOAD_PX` px (kept until under 40 % of it)
   * and free it beyond, so only the bodies being looked at hold video memory. A missing file is asked for once. Call with `updateMeshes`.
   */
  private updateTextures(fovDeg: number, viewportPx: number): void {
    if (this.disposed) return;
    for (const d of this.list) {
      const t = d.tex;
      if (!t || t.missing) continue;
      const dist = Math.hypot(d.rel[0], d.rel[1], d.rel[2]);
      const px = bodyDiscRadiusPx(d.radiusKm, d.k, dist, fovDeg, viewportPx);
      const want = d.shown && meshWanted(px === Infinity ? 1e6 : px, MAP_LOAD_PX, t.held);
      if (want && !t.held) this.holdMap(d, t);
      else if (!want && t.held) this.dropMap(t);
    }
  }

  private holdMap(d: Drawn, t: BodyTex): void {
    t.held = true;
    const gen = ++t.gen;
    const tag = d.bodyId.toLowerCase();
    this.env.loadTexture(
      `/textures/${t.file}`,
      (tex) => {
        if (this.disposed || d.removed || !t.held || t.gen !== gen) return tex.dispose();
        const map = this.fitTexture(tex, t.file, tag);
        t.tinted = t.mesh.material as THREE.Material;
        t.mesh.material = createMapMaterial(t.sun, map, [t.inv2.x, t.inv2.y, t.inv2.z]);
      },
      () => {
        if (t.gen !== gen) return;
        t.missing = true;
        t.held = false;
        console.info(`[${tag}] ${t.file} is missing: keeping the procedural look (run npm run assets, then reload the page)`);
      },
    );
  }

  private dropMap(t: BodyTex): void {
    t.held = false;
    t.gen++;
    if (!t.tinted) return;
    const mat = t.mesh.material as THREE.ShaderMaterial;
    (mat.uniforms.uTex?.value as THREE.Texture | null | undefined)?.dispose();
    mat.dispose();
    t.mesh.material = t.tinted;
    t.tinted = null;
  }

  /**
   * The mesh tier (lib/body-shape.ts): for each body that names a glb, hold the file while the body's disc is at least
   * `loadPx` big (kept until under 40% of it) and let it go beyond; call after `update`, like `updateMarkers`. Nothing is requested
   * for a body that is never approached; a file that fails leaves the sphere (the cache retries after a minute). A body behind
   * the camera still counts by distance only: a disc that big and that near is on screen in practice.
   */
  updateMeshes(fovDeg: number, viewportPx: number): void {
    this.updateTextures(fovDeg, viewportPx);
    for (const d of this.list) {
      const bm = d.mesh;
      if (!bm) continue;
      const dist = Math.hypot(d.rel[0], d.rel[1], d.rel[2]);
      const px = bodyDiscRadiusPx(d.radiusKm, d.k, dist, fovDeg, viewportPx);
      const want = meshWanted(px === Infinity ? 1e6 : px, bm.spec.loadPx ?? MESH_LOAD_PX, bm.held);
      if (want && !bm.held) this.holdMesh(d, bm);
      else if (!want && bm.held) this.dropMesh(d, bm);
    }
  }

  private holdMesh(d: Drawn, bm: BodyMesh): void {
    const cache = this.env.meshes ?? MODEL_ASSETS;
    bm.held = true;
    const got = cache.acquire(bm.spec.url);
    if (got.value) this.attachMesh(d, bm, got.value);
    else {
      void got.ready.then(() => {
        const v = cache.peek(bm.spec.url);
        if (v && bm.held && !bm.group && !d.removed && !this.disposed) this.attachMesh(d, bm, v);
        else if (!v && cache.stateOf(bm.spec.url) === 'failed') console.info(`[${d.bodyId.toLowerCase()}] ${bm.spec.url} could not be loaded, keeping the sphere:`, cache.errorOf(bm.spec.url));
      });
    }
  }

  /** Sunlight shading on / off (View menu) for the loaded body models; the body shaders follow the shared uniform `SHADING`. */
  setShaded(on: boolean): void {
    this.shaded = on;
    for (const d of this.drawn.values()) if (d.mesh) this.applyShading(d.mesh);
  }

  private applyShading(bm: BodyMesh): void {
    const rig = lightRig(this.shaded, 1, 0); // a body model has no eclipse or earthshine term, only the Sun
    if (bm.light) bm.light.intensity = rig.sun;
    if (bm.ambient) bm.ambient.intensity = this.shaded ? 0 : rig.ambient;
  }

  private attachMesh(d: Drawn, bm: BodyMesh, glb: LoadedGlb): void {
    // the cloned graph shares the cache's geometry and materials; only the cache disposes them
    const group = new THREE.Group();
    const model = glb.scene.clone(true);
    model.traverse((o) => { o.frustumCulled = false; });
    group.add(model);
    // the glb's standard materials need a light: the Sun, from this body's own direction (set every frame in `place`)
    const light = new THREE.DirectionalLight(0xfff4e4, SUN_I);
    const ambient = new THREE.AmbientLight(0xffffff, 0);
    group.add(ambient);
    bm.group = group;
    bm.light = light;
    bm.ambient = ambient;
    this.scene.add(group, light);
    this.applyShading(bm);
    bm.sphere.visible = false;
  }

  private dropMesh(d: Drawn, bm: BodyMesh): void {
    (this.env.meshes ?? MODEL_ASSETS).release(bm.spec.url);
    bm.held = false;
    bm.group?.removeFromParent();
    bm.light?.removeFromParent();
    bm.group = null;
    bm.light = null;
    bm.ambient = null;
    bm.sphere.visible = true;
  }

  /**
   * The body's map from /textures: a map wider than the GPU's texture limit is scaled down to it (not dropped); a missing
   * or invalid file leaves the tinted sphere and says how to get the file.
   */
  private loadMapTexture(d: Drawn, mesh: THREE.Mesh, sun: THREE.Vector3, file: string): void {
    const tag = d.bodyId.toLowerCase();
    this.env.loadTexture(
      `/textures/${file}`,
      (tex) => {
        if (this.disposed || d.removed) return tex.dispose();
        const map = this.fitTexture(tex, file, tag);
        const tinted = mesh.material as THREE.Material;
        mesh.material = createMapMaterial(sun, map);
        tinted.dispose();
      },
      () => console.info(`[${tag}] ${file} is missing: tinted ${d.bodyId === 'MARS' ? 'Mars' : 'sphere'} (run npm run assets, then reload the page)`),
    );
  }

  /** A loaded map as the sphere uses it: scaled down to the GPU's texture limit, linear colour, anisotropic. */
  private fitTexture(tex: THREE.Texture, file: string, tag: string): THREE.Texture {
    const img = tex.image as { width: number; height: number };
    const max = this.env.maxTextureSize();
    const fit = fitMapSize(img.width, img.height, max);
    let map = tex;
    if (fit.scaled) {
      const canvas = document.createElement('canvas');
      canvas.width = fit.width;
      canvas.height = fit.height;
      canvas.getContext('2d')?.drawImage(img as CanvasImageSource, 0, 0, fit.width, fit.height);
      tex.dispose();
      map = new THREE.CanvasTexture(canvas);
      console.info(`[${tag}] using ${file} scaled from ${img.width} to ${max} px (GPU texture limit)`);
    } else console.info(`[${tag}] using ${file} (${img.width} x ${img.height})`);
    map.colorSpace = THREE.NoColorSpace;
    map.anisotropy = Math.min(8, this.env.maxAnisotropy());
    return map;
  }

  private loadMoonTexture(mat: THREE.ShaderMaterial): void {
    new THREE.TextureLoader().load(
      '/textures/moon.jpg',
      (tex) => {
        if (this.disposed || this.moonMat !== mat) return tex.dispose();
        tex.colorSpace = THREE.NoColorSpace;
        mat.uniforms.uTex.value = tex;
        mat.uniforms.uHasTex.value = 1;
        this.mode = 'texture';
      },
      undefined,
      () => undefined, // missing/invalid texture: procedural shading stays
    );
  }

  /**
   * Place every body for sim time `t`; `origin` is the camera in world space (the floating origin).
   */
  update(t: number, origin: THREE.Vector3): void {
    for (const d of this.drawn.values()) {
      if (d.place) d.place(origin, t);
      else {
        // the Earth: its own mesh group sits at the origin at true size
        d.c[0] = d.c[1] = d.c[2] = 0;
        d.k = 1;
      }
      d.rel[0] = d.c[0] - origin.x;
      d.rel[1] = d.c[1] - origin.y;
      d.rel[2] = d.c[2] - origin.z;
    }
  }

  /**
   * THE list of drawn bodies, Earth included, as at the last `update` (centre, camera-relative centre, radius, flattening,
   * system reach): the same array every call, no allocation. The point shader's occluders, the CPU occlusion, the disc cones,
   * picking and the labels all read it, so a body appears in all of them once it is here.
   */
  bodies(): readonly SceneBody[] {
    return this.list;
  }

  /**
   * Decide which bodies show their glyph, label and pick area (lib/scope.ts): `inScope(bodyId, entityId)` is the hierarchy rule
   * with the keeps, and a body out of scope still shows once its disc is big enough to see. Call after `update`, before
   * `updateMarkers`; no allocation unless the set changed (then `shownBodies` is rebuilt).
   */
  applyScope(inScope: (bodyId: string, entityId: string) => boolean, fovDeg: number, viewportPx: number): void {
    let changed = false;
    for (const d of this.list) {
      const shown = bodyShown(inScope(d.bodyId, d.entityId), bodyDiscRadiusPx(d.radiusKm, d.k, Math.hypot(d.rel[0], d.rel[1], d.rel[2]), fovDeg, viewportPx));
      if (shown !== d.shown) changed = true;
      d.shown = shown;
    }
    if (changed) this.shownList = this.list.filter((d) => d.shown);
  }

  /** The bodies that can be picked (`bodies()` minus those scoped out by `applyScope`): the same array until the set changes. */
  shownBodies(): readonly SceneBody[] {
    return this.shownList;
  }

  /**
   * Visit every SHOWN body (`applyScope`), Earth included, without allocating (the label pass runs every frame): entity id,
   * centre, true radius and drawn-radius factor (1).
   */
  eachBody(visit: (entityId: string, c: readonly [number, number, number], radiusKm: number, k: number) => void): void {
    for (const d of this.drawn.values()) if (d.shown) visit(d.entityId, d.c, d.radiusKm, d.k);
  }

  /** The Earth as the layer knows it (centre and radius), or null before the Earth entity has arrived. */
  earth(): DrawnBody | null {
    const d = this.drawn.get('EARTH');
    return d ? { entityId: d.entityId, c: d.c, radiusKm: EARTH.radiusKm, k: 1 } : null;
  }

  dispose(): void {
    this.disposed = true;
    this.disposeMarkers();
    for (const d of this.drawn.values()) {
      if (d.tex) {
        this.dropMap(d.tex);
        d.tex.missing = true;
      }
      for (const o of d.objects) {
        const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
        (m?.uniforms?.uTex?.value as THREE.Texture | null | undefined)?.dispose();
      }
      for (const o of d.objects) {
        const mat = (o as THREE.Sprite).material as THREE.SpriteMaterial | undefined;
        if (o instanceof THREE.Sprite) mat?.map?.dispose();
      }
    }
  }
}

/** Soft white-to-transparent disc for the Sun's glow. */
function radialGlow(): THREE.Texture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.12, 'rgba(255,255,255,0.45)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.12)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}
