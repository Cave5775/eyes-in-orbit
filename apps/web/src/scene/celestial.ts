import * as THREE from 'three';
import { EARTH, MOON, SUN, inertialToFixedMatrix, bodyOf, isBodyEntity, transpose, type EntityRecord } from '@eio/core';
import type { DrawnBody } from '../lib/body-scene';
import type { OccluderSphere } from '../lib/occlusion';
import { isRegistryBody, refDisplay, refPositionEci, refRadiusKm } from '../lib/ref-body';
import { createMoonMaterial } from './materials';

/** Colour of a body without a texture (linear display colours, authored directly): Mars is a rusty ochre. */
const BODY_TINT: Record<string, [number, number, number]> = { MARS: [0.74, 0.36, 0.2] };
const DEFAULT_TINT: [number, number, number] = [0.55, 0.55, 0.58];

const ZERO: [number, number, number] = [0, 0, 0];

/** One body the layer knows: its entity, where it is displayed and (all but the Earth) its meshes. */
interface Drawn {
  entityId: string;
  bodyId: string;
  radiusKm: number;
  /** centre, km, and drawn-radius factor (always 1; set by `update`) */
  c: [number, number, number];
  k: number;
  /** meshes added to the scene (none for the Earth); `place` positions them relative to the camera */
  objects: THREE.Object3D[];
  place?: (origin: THREE.Vector3, t: number) => void;
  /** sphere handed to the occlusion tests (centre, radius) */
  sphere: OccluderSphere;
}

/**
 * The celestial bodies as the scene draws them, fed by the body ENTITIES (`setBodies`): a map keyed by registry id (each
 * entity's `bodyOf`, the one place the two meet here; the mesh to build depends on the body).
 * - the Moon (textured when /textures/moon.jpg loads, else procedural, IAU rotation) and the Sun (emissive disc and glow)
 *   look and sit exactly as before; Mars (and any other registry body) is a plain tinted sphere lit from the Sun's direction;
 * - the Earth is NOT drawn here (SceneController keeps its own mesh group); the layer only knows its centre and radius, so
 *   picking, labels and occluders see it with the others.
 * Everything is drawn to scale at its true position (`refDisplay`, k = 1: the Sun at 1.5e8 km, Mars wherever it is). Like the
 * Earth they are placed camera-relative (float64 position minus the floating origin), so a camera 3,000 km from the Moon or 1.5e8 km from
 * the Earth sees them without float32 jitter.
 */
export class CelestialLayer {
  private readonly drawn = new Map<string, Drawn>();
  private readonly rot = new THREE.Matrix4();
  private disposed = false;
  /** shader spheres, always [Moon, Sun]; radius 0 (hides nothing) while a body is not in the layer */
  private readonly shader: [OccluderSphere, OccluderSphere] = [{ c: [0, 0, 0], r: 0 }, { c: [0, 0, 0], r: 0 }];
  private moonMat: THREE.ShaderMaterial | null = null;
  /** 'texture' once /textures/moon.jpg has loaded */
  mode: 'texture' | 'procedural' = 'procedural';

  constructor(private readonly scene: THREE.Scene, private readonly sunDir: THREE.Vector3) {}

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
    this.syncShaderSpheres();
  }

  private create(bodyId: string, entityId: string): Drawn {
    const d: Drawn = {
      entityId, bodyId, radiusKm: refRadiusKm(bodyId), c: [0, 0, 0], k: 1, objects: [], sphere: { c: ZERO, r: 0 },
    };
    if (bodyId === 'MOON') this.buildMoon(d);
    else if (bodyId === 'SUN') this.buildSun(d);
    else if (bodyId !== 'EARTH') this.buildGeneric(d);
    for (const o of d.objects) {
      o.frustumCulled = false; // positions are huge and re-derived every frame; three's bounding sphere would be stale
      this.scene.add(o);
    }
    return d;
  }

  private remove(d: Drawn): void {
    for (const o of d.objects) {
      o.removeFromParent();
      (o as THREE.Mesh).geometry?.dispose?.();
      const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
      mat?.dispose();
    }
    if (d.bodyId === 'MOON') this.moonMat = null;
  }

  private buildMoon(d: Drawn): void {
    d.radiusKm = MOON.radiusKm;
    // same convention as the Earth: local z = pole, +x = prime meridian
    const mg = new THREE.SphereGeometry(MOON.radiusKm, 128, 64);
    mg.rotateX(Math.PI / 2);
    const mat = createMoonMaterial(this.sunDir, null);
    this.moonMat = mat;
    const moon = new THREE.Mesh(mg, mat);
    d.objects.push(moon);
    d.place = (origin, t) => {
      const m = refDisplay('MOON', t);
      moon.position.set(m.r[0] - origin.x, m.r[1] - origin.y, m.r[2] - origin.z);
      moon.scale.setScalar(m.k);
      // body-fixed to inertial is the transpose of the IAU inertial-to-fixed matrix
      const R = transpose(inertialToFixedMatrix(MOON, t));
      this.rot.set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1);
      moon.quaternion.setFromRotationMatrix(this.rot);
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

  /** Mars and any other registry body: a tinted sphere, lit from where the Sun is as seen from that body. */
  private buildGeneric(d: Drawn): void {
    const tint = BODY_TINT[d.bodyId] ?? DEFAULT_TINT;
    const sunFromBody = new THREE.Vector3(1, 0, 0);
    const mat = createBodyMaterial(sunFromBody, tint);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(d.radiusKm, 64, 32), mat);
    d.objects.push(mesh);
    d.place = (origin, t) => {
      const m = refDisplay(d.bodyId, t);
      mesh.position.set(m.r[0] - origin.x, m.r[1] - origin.y, m.r[2] - origin.z);
      mesh.scale.setScalar(m.k);
      // the real direction to the Sun from the body (not the Earth's)
      const p = refPositionEci(d.bodyId, t), s = refPositionEci('SUN', t);
      sunFromBody.set(s[0] - p[0], s[1] - p[1], s[2] - p[2]).normalize();
      d.c = [m.r[0], m.r[1], m.r[2]];
      d.k = m.k;
    };
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
        d.c = [0, 0, 0];
        d.k = 1;
      }
      d.sphere.c = d.c;
      d.sphere.r = d.radiusKm * d.k;
    }
    this.syncShaderSpheres();
  }

  private syncShaderSpheres(): void {
    for (const [i, id] of ['MOON', 'SUN'].entries()) {
      const s = this.drawn.get(id)?.sphere;
      this.shader[i].c = s ? s.c : ZERO;
      this.shader[i].r = s ? s.r : 0;
    }
  }

  /**
   * Every drawn body except the Earth as at the last `update` (centre, radius): the
   * Moon and the Sun first, then the others (Mars) in registry order. The Earth has its own ellipsoid test in `makeOccluder`.
   */
  occluders(): readonly OccluderSphere[] {
    const out: OccluderSphere[] = [];
    for (const id of ['MOON', 'SUN']) {
      const d = this.drawn.get(id);
      if (d) out.push(d.sphere);
    }
    for (const [id, d] of this.drawn) if (id !== 'MOON' && id !== 'SUN' && id !== 'EARTH') out.push(d.sphere);
    return out;
  }

  /** The two spheres the point shader has uniforms for (its fixed layout, `uSph0` and `uSph1`): [Moon, Sun]. */
  shaderSpheres(): readonly [OccluderSphere, OccluderSphere] {
    return this.shader;
  }

  /** Every body in the layer, Earth included, as at the last `update` (for picking and labels). */
  bodies(): DrawnBody[] {
    return [...this.drawn.values()].map((d) => ({ entityId: d.entityId, c: d.c, radiusKm: d.radiusKm, k: d.k }));
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
