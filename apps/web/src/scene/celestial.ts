import * as THREE from 'three';
import { EARTH, MARS, MOON, SUN, bodyOf, isBodyEntity, type Body, type EntityRecord } from '@eio/core';
import { bodyFixedToInertial, fitMapSize } from '../lib/body-map';
import type { DrawnBody } from '../lib/body-scene';
import type { SceneBody } from '../lib/occlusion';
import { EARTH_SYSTEM_DEPTH_KM, EARTH_SYSTEM_REACH_KM } from '../lib/disc-hide';
import { isRegistryBody, refDisplay, refPositionEci, refRadiusKm } from '../lib/ref-body';
import { createMapMaterial } from './materials';

/**
 * Bodies drawn with a map (file in /textures, `npm run assets`): a sphere of the body's equatorial radius (the flattening,
 * 1/169.8 for Mars, is ignored: the maps are sphere-based simple cylindrical) oriented by its IAU rotation. Until the file
 * has loaded (or when it is missing) the body keeps its tinted sphere.
 */
const BODY_MAPS: Record<string, { body: Body; file: string }> = { MARS: { body: MARS, file: 'mars.jpg' } };

/** What the layer needs from the renderer and the loader; the defaults are for tests (no GPU). */
export interface MapEnv {
  maxTextureSize: () => number;
  maxAnisotropy: () => number;
  /** loads an image as a texture; `onError` also covers a response that is no image (the dev server answers a missing file with its HTML page) */
  loadTexture: (url: string, onLoad: (tex: THREE.Texture) => void, onError: () => void) => void;
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

/** Colour of a body without a texture (linear display colours, authored directly): Mars is a rusty ochre. */
const BODY_TINT: Record<string, [number, number, number]> = { MARS: [0.74, 0.36, 0.2] };
const DEFAULT_TINT: [number, number, number] = [0.55, 0.55, 0.58];

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
  /** the bodies in layer order, rebuilt when the set changes (the objects are the `drawn` values, mutated by `update`) */
  private list: Drawn[] = [];
  private moonMat: THREE.ShaderMaterial | null = null;
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
  }

  private create(bodyId: string, entityId: string): Drawn {
    const d: Drawn = {
      entityId, bodyId, radiusKm: refRadiusKm(bodyId), c: [0, 0, 0], rel: [0, 0, 0], k: 1, objects: [],
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
    else if (bodyId !== 'EARTH') this.buildGeneric(d, BODY_MAPS[bodyId]);
    for (const o of d.objects) {
      o.frustumCulled = false; // positions are huge and re-derived every frame; three's bounding sphere would be stale
      this.scene.add(o);
    }
    return d;
  }

  private remove(d: Drawn): void {
    d.removed = true;
    for (const o of d.objects) {
      o.removeFromParent();
      (o as THREE.Mesh).geometry?.dispose?.();
      const mat = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      (mat?.uniforms?.uTex?.value as THREE.Texture | null | undefined)?.dispose();
      mat?.dispose();
    }
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
   * Mars and any other registry body: a tinted sphere, lit from where the Sun is as seen from that body. With a `map` (Mars)
   * the sphere gets the Moon's treatment: pole on z, oriented by the IAU rotation each frame, and the map as soon as it has loaded.
   */
  private buildGeneric(d: Drawn, map?: { body: Body; file: string }): void {
    const tint = BODY_TINT[d.bodyId] ?? DEFAULT_TINT;
    const sunFromBody = new THREE.Vector3(1, 0, 0);
    const mat = createBodyMaterial(sunFromBody, tint);
    if (map) d.radiusKm = map.body.radiusKm;
    const mesh = new THREE.Mesh(map ? createMapSphere(d.radiusKm) : new THREE.SphereGeometry(d.radiusKm, 64, 32), mat);
    d.objects.push(mesh);
    d.place = (origin, t) => {
      const m = refDisplay(d.bodyId, t);
      mesh.position.set(m.r[0] - origin.x, m.r[1] - origin.y, m.r[2] - origin.z);
      mesh.scale.setScalar(m.k);
      if (map) this.orient(mesh, map.body, t);
      // the real direction to the Sun from the body (not the Earth's)
      const p = refPositionEci(d.bodyId, t), s = refPositionEci('SUN', t);
      sunFromBody.set(s[0] - p[0], s[1] - p[1], s[2] - p[2]).normalize();
      d.c = [m.r[0], m.r[1], m.r[2]];
      d.k = m.k;
    };
    if (map) this.loadMapTexture(d, mesh, sunFromBody, map.file);
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
        const tinted = mesh.material as THREE.Material;
        mesh.material = createMapMaterial(sun, map);
        tinted.dispose();
      },
      () => console.info(`[${tag}] ${file} is missing: tinted ${d.bodyId === 'MARS' ? 'Mars' : 'sphere'} (run npm run assets, then reload the page)`),
    );
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

  /** Visit every body, Earth included, without allocating (the label pass runs every frame): entity id, centre, true radius and drawn-radius factor (1). */
  eachBody(visit: (entityId: string, c: readonly [number, number, number], radiusKm: number, k: number) => void): void {
    for (const d of this.drawn.values()) visit(d.entityId, d.c, d.radiusKm, d.k);
  }

  /** The Earth as the layer knows it (centre and radius), or null before the Earth entity has arrived. */
  earth(): DrawnBody | null {
    const d = this.drawn.get('EARTH');
    return d ? { entityId: d.entityId, c: d.c, radiusKm: EARTH.radiusKm, k: 1 } : null;
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.drawn.values()) {
      for (const o of d.objects) {
        const mat = (o as THREE.Sprite).material as THREE.SpriteMaterial | undefined;
        if (o instanceof THREE.Sprite) mat?.map?.dispose();
      }
    }
  }
}

/** Plain lit sphere without a texture: tint with a little banding, terminator as the Moon's (no scene lights are used). */
function createBodyMaterial(sun: THREE.Vector3, tint: [number, number, number]): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uSun: { value: sun }, uTint: { value: new THREE.Vector3(...tint) } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vL; varying vec3 vN;
      void main() {
        vL = normal;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uSun; uniform vec3 uTint;
      varying vec3 vL; varying vec3 vN;
      void main() {
        #include <logdepthbuf_fragment>
        float band = 0.88 + 0.12 * sin(vL.z * 9.0 + 2.5 * sin(vL.x * 6.0 + vL.y * 4.0));
        float d = dot(normalize(vN), normalize(uSun));
        float lit = smoothstep(-0.02, 0.35, d) * (0.15 + 0.95 * max(d, 0.0));
        gl_FragColor = vec4(uTint * band * (0.012 + 1.05 * lit), 1.0);
      }`,
  });
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
