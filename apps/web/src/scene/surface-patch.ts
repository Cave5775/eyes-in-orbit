import * as THREE from 'three';
import { defaultBodies, mmgisLayer, type MmgisLayer } from '@eio/core';
import {
  MAX_IN_FLIGHT, MAX_TEXTURES, PATCH_LIFT_KM, STACK_LIFT_KM, ancestors, evictions, lonLatAlt, marsInReach, missionUnder, patchOpacity, requestsFor, selectTiles, standIn,
  texKey, textureBytes, tileGrid, uvRect, type TileDraw,
} from '../lib/map-tiles';
import { bodyAxes } from '../lib/traverse';
import { refPositionEci } from '../lib/ref-body';
import { SHADING } from './materials';

/**
 * The Mars surface patch: NASA's rover-map mosaics (MMGIS, core `MMGIS_LAYERS`, loaded straight from NASA's MMGIS server)
 * laid on the planet near Jezero and Gale while the camera is lower than 600 km over them (fading in down to 250 km). Which
 * tiles, their grids and the texture budget are lib/map-tiles.ts; this class only keeps the meshes and textures in step.
 *
 * Placement is the traverse's (lib/traverse.ts `bodyAxes`): one group carries the Mars body-fixed frame at this frame's sim time
 * (position = Mars centre minus the camera, in float64; rotation = the body-fixed axes); each tile is a child at its centre on
 * the sphere with float32 vertices relative to that centre, so what reaches the GPU is camera-relative (floating origin) and the
 * imagery and the traverse line cannot drift apart. The patch is lifted 3 m over the sphere (the globe's facets are under it),
 * a partly covering sharper layer 2 m more per step; the traverse line at 10 m stays on top. Lit like the Mars map.
 */

const SELECT_EVERY_MS = 120;
const RETRY_FAILED_MS = 60_000;
/** hidden this long, the patch gives its textures and meshes back */
const RELEASE_AFTER_MS = 30_000;

interface Tex {
  state: 'loading' | 'ready' | 'failed';
  tex: THREE.Texture | null;
  /** the image while it loads (its `src` is cleared to stop the download when the entry is dropped) */
  img: HTMLImageElement | null;
  at: number;
  used: number;
}

interface Drawn {
  draw: TileDraw;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
}

export interface PatchStats {
  mission: string | null;
  opacity: number;
  /** meshes drawn (leaves times their layer stacks) */
  drawn: number;
  /** of those, with their own texture (not a coarser stand-in or nothing yet) */
  sharp: number;
  textures: number;
  loading: number;
  /** GPU bytes of the resident textures, with mipmaps */
  gpuBytes: number;
}

function createPatchMaterial(sun: THREE.Vector3): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: null },
      uRect: { value: new THREE.Vector3(0, 0, 1) },
      uOpacity: { value: 1 },
      uLift: { value: PATCH_LIFT_KM },
      uSun: { value: sun },
      uShade: SHADING,
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform vec3 uRect; uniform float uLift;
      varying vec2 vUv; varying vec3 vN;
      void main() {
        vUv = uRect.xy + uv * uRect.z;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position + normal * uLift, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D uTex; uniform float uOpacity; uniform vec3 uSun; uniform float uShade;
      varying vec2 vUv; varying vec3 vN;
      void main() {
        #include <logdepthbuf_fragment>
        vec4 t = texture2D(uTex, vUv);
        if (t.a < 0.02) discard; // outside the mosaic: the layer below (or the globe) shows
        float d = dot(normalize(vN), normalize(uSun));
        float lit = smoothstep(-0.02, 0.35, d) * (0.15 + 0.95 * max(d, 0.0));
        gl_FragColor = vec4(mix(t.rgb, t.rgb * (0.012 + 1.05 * lit), uShade), t.a * uOpacity);
      }`,
    transparent: true,
    depthWrite: true,
  });
}

export class SurfacePatch {
  private readonly group = new THREE.Group();
  private readonly radiusKm = defaultBodies.get('MARS').radiusKm;
  private readonly sun = new THREE.Vector3(1, 0, 0);
  private readonly basis = new THREE.Matrix4();
  private readonly textures = new Map<string, Tex>();
  private readonly geometries = new Map<string, { g: THREE.BufferGeometry; used: number }>();
  private drawn = new Map<string, Drawn>();
  private draws: TileDraw[] = [];
  private lastSelect = -Infinity;
  private mission: string | null = null;
  private opacity = 0;
  private disposed = false;
  private hiddenSince: number | null = null;
  enabled = true;

  /** `tileUrl` gives the address of a tile (the server route, or a mock fixture), or null when there is none. */
  constructor(parent: THREE.Object3D, private readonly tileUrl: (layer: MmgisLayer, z: number, x: number, y: number) => string | null, private readonly maxAnisotropy = 8) {
    this.group.visible = false;
    parent.add(this.group);
  }

  /**
   * Place and refresh the patch for sim time `t`: `origin` = the camera's world position (float64), `dir` its view direction
   * (world), `fovDeg` / `aspect` / `viewportPx` the render camera's. Every frame; the tile choice is redone every 120 ms.
   */
  update(t: number, origin: THREE.Vector3, dir: THREE.Vector3, fovDeg: number, aspect: number, viewportPx: number, wall = performance.now()): void {
    // the camera at the Earth (or anywhere far from Mars) pays one ephemeris lookup, not the four conversions of bodyAxes
    const c = this.enabled ? refPositionEci('MARS', t) : null;
    if (!c || !marsInReach(Math.hypot(origin.x - c[0], origin.y - c[1], origin.z - c[2]), this.radiusKm)) return this.hide(wall);
    const axes = bodyAxes('MARS', t);
    if (!axes) return this.hide(wall);
    const { o, ex, ey, ez } = axes;
    // the camera in body-fixed km: the transpose of the axes applied to (camera - centre)
    const rx = origin.x - o[0], ry = origin.y - o[1], rz = origin.z - o[2];
    const cam: [number, number, number] = [rx * ex[0] + ry * ex[1] + rz * ex[2], rx * ey[0] + ry * ey[1] + rz * ey[2], rx * ez[0] + ry * ez[1] + rz * ez[2]];
    const g = lonLatAlt(cam, this.radiusKm);
    this.mission = missionUnder(g.lonDeg, g.latDeg, g.altKm, this.radiusKm);
    this.opacity = this.mission ? patchOpacity(g.altKm) : 0;
    if (!this.mission || this.opacity <= 0) return this.hide(wall);

    this.group.visible = true;
    this.hiddenSince = null;
    this.group.position.set(o[0] - origin.x, o[1] - origin.y, o[2] - origin.z);
    this.basis.set(ex[0], ey[0], ez[0], 0, ex[1], ey[1], ez[1], 0, ex[2], ey[2], ez[2], 0, 0, 0, 0, 1);
    this.group.quaternion.setFromRotationMatrix(this.basis);
    const s = refPositionEci('SUN', t);
    this.sun.set(s[0] - o[0], s[1] - o[1], s[2] - o[2]).normalize();

    if (wall - this.lastSelect >= SELECT_EVERY_MS) {
      this.lastSelect = wall;
      const d: [number, number, number] = [dir.x * ex[0] + dir.y * ex[1] + dir.z * ex[2], dir.x * ey[0] + dir.y * ey[1] + dir.z * ey[2], dir.x * ez[0] + dir.y * ez[1] + dir.z * ez[2]];
      this.draws = selectTiles(this.mission, { cam, dir: d, fovDeg, aspect, viewportPx, radiusKm: this.radiusKm });
      this.syncMeshes(wall);
      this.request(wall);
    }
    for (const { draw, mesh } of this.drawn.values()) this.bind(draw, mesh, wall);
  }

  private hide(wall: number): void {
    this.group.visible = false;
    this.hiddenSince ??= wall;
    if (wall - this.hiddenSince > RELEASE_AFTER_MS && (this.drawn.size || this.textures.size)) this.release();
  }

  /** Free every mesh, geometry and texture (the next update starts over). */
  private release(): void {
    for (const d of this.drawn.values()) {
      d.mesh.removeFromParent();
      d.mesh.material.dispose();
    }
    for (const g of this.geometries.values()) g.g.dispose();
    for (const t of this.textures.values()) this.drop(t);
    this.drawn.clear();
    this.geometries.clear();
    this.textures.clear();
    this.draws = [];
    this.lastSelect = -Infinity;
  }

  /** One mesh per draw: new ones built, gone ones removed (their geometry stays cached, the material is freed). */
  private syncMeshes(wall: number): void {
    const next = new Map<string, Drawn>();
    for (const draw of this.draws) {
      const have = this.drawn.get(draw.key);
      if (have) {
        have.draw = draw;
        next.set(draw.key, have);
        continue;
      }
      const mesh = new THREE.Mesh(this.geometry(draw, wall), createPatchMaterial(this.sun));
      mesh.material.uniforms.uLift.value = PATCH_LIFT_KM + STACK_LIFT_KM * draw.stack;
      // drawn over the globe, coarse layers first, before the traverse line (renderOrder 3)
      mesh.renderOrder = 1 + Math.min(draw.stack, 1);
      const grid = this.geometries.get(`${draw.z}/${draw.x}/${draw.y}`)!;
      mesh.position.set(grid.g.userData.centre[0], grid.g.userData.centre[1], grid.g.userData.centre[2]);
      this.group.add(mesh);
      next.set(draw.key, { draw, mesh });
    }
    for (const [k, d] of this.drawn) {
      if (next.has(k)) continue;
      d.mesh.removeFromParent();
      d.mesh.material.dispose();
    }
    this.drawn = next;
    // geometries: keep those in use, drop the least recently used beyond twice the texture budget
    const inUse = new Set(this.draws.map((d) => `${d.z}/${d.x}/${d.y}`));
    for (const k of evictions(this.geometries, inUse, MAX_TEXTURES * 2)) {
      this.geometries.get(k)!.g.dispose();
      this.geometries.delete(k);
    }
  }

  private geometry(d: TileDraw, wall: number): THREE.BufferGeometry {
    const key = `${d.z}/${d.x}/${d.y}`;
    const have = this.geometries.get(key);
    if (have) {
      have.used = wall;
      return have.g;
    }
    const grid = tileGrid(d.z, d.x, d.y, this.radiusKm);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(grid.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(grid.normal, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(grid.uv, 2));
    g.setIndex(new THREE.BufferAttribute(grid.index, 1));
    g.computeBoundingSphere();
    g.userData.centre = grid.centre;
    this.geometries.set(key, { g, used: wall });
    return g;
  }

  /** Start the missing textures, largest leaves first; drop the least recently used beyond the budget. */
  private request(wall: number): void {
    const state = (k: string) => this.textures.get(k)?.state;
    const own = this.draws.map((d) => texKey(d.layer, d.tz, d.tx, d.ty));
    // the coarse stand-ins first (few, shared, quick to show something), then the tiles themselves, largest first
    const wanted = [...this.draws.map((d) => standIn(d, state)).filter((k): k is string => !!k), ...own];
    let loading = 0;
    for (const t of this.textures.values()) if (t.state === 'loading') loading++;
    const held = (k: string) => {
      const t = this.textures.get(k);
      return !!t && (t.state !== 'failed' || wall - t.at < RETRY_FAILED_MS);
    };
    for (const k of requestsFor(wanted, held, loading, MAX_IN_FLIGHT)) this.load(k, wall);
    const keep = new Set(wanted);
    for (const { draw } of this.drawn.values()) {
      for (const [z, x, y] of ancestors(draw.layer, draw.tz, draw.tx, draw.ty)) keep.add(texKey(draw.layer, z, x, y));
    }
    for (const k of evictions(this.textures, keep, MAX_TEXTURES)) {
      const t = this.textures.get(k);
      if (t) this.drop(t);
      this.textures.delete(k);
    }
  }

  private load(key: string, wall: number): void {
    const [mission, id, z, x, y] = key.split('/');
    const layer = mmgisLayer(mission, id);
    const url = layer ? this.tileUrl(layer, Number(z), Number(x), Number(y)) : null;
    const entry: Tex = { state: url ? 'loading' : 'failed', tex: null, img: null, at: wall, used: wall };
    this.textures.set(key, entry);
    if (!url) return;
    const img = new Image();
    img.crossOrigin = 'anonymous'; // NASA answers with Access-Control-Allow-Origin: *; WebGL needs a CORS-clean image
    entry.img = img;
    img.onload = () => {
      if (this.disposed || this.textures.get(key) !== entry) return;
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.NoColorSpace; // display-space colours, like every map in the scene
      tex.anisotropy = this.maxAnisotropy;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      entry.tex = tex;
      entry.state = 'ready';
    };
    img.onerror = () => {
      entry.state = 'failed';
      entry.at = performance.now();
    };
    img.src = url;
  }

  /** Free a texture, or stop its download. */
  private drop(t: Tex): void {
    t.tex?.dispose();
    if (t.img && t.state === 'loading') {
      t.img.onload = t.img.onerror = null;
      t.img.src = '';
    }
    t.img = null;
  }

  /** Give a mesh its own texture, or the nearest coarser one of its layer while that loads; hidden when there is neither. */
  private bind(d: TileDraw, mesh: Drawn['mesh'], wall: number): void {
    const u = mesh.material.uniforms;
    u.uOpacity.value = this.opacity;
    let found: [number, number, number, Tex] | null = null;
    const own = this.textures.get(texKey(d.layer, d.tz, d.tx, d.ty));
    if (own?.state === 'ready') found = [d.tz, d.tx, d.ty, own];
    else {
      for (const [z, x, y] of ancestors(d.layer, d.tz, d.tx, d.ty)) {
        const t = this.textures.get(texKey(d.layer, z, x, y));
        if (t?.state === 'ready') {
          found = [z, x, y, t];
          break;
        }
      }
    }
    mesh.visible = !!found;
    if (!found) return;
    const [z, x, y, t] = found;
    t.used = wall;
    if (u.uTex.value !== t.tex) u.uTex.value = t.tex;
    const r = uvRect(d.z, d.x, d.y, z, x, y);
    (u.uRect.value as THREE.Vector3).set(r[0], r[1], r[2]);
  }

  get stats(): PatchStats {
    let ready = 0, loading = 0, sharp = 0;
    for (const t of this.textures.values()) {
      if (t.state === 'ready') ready++;
      else if (t.state === 'loading') loading++;
    }
    for (const { draw } of this.drawn.values()) if (this.textures.get(texKey(draw.layer, draw.tz, draw.tx, draw.ty))?.state === 'ready') sharp++;
    return { mission: this.group.visible ? this.mission : null, opacity: this.group.visible ? this.opacity : 0, drawn: this.group.visible ? this.drawn.size : 0, sharp, textures: ready, loading, gpuBytes: textureBytes(ready) };
  }

  dispose(): void {
    this.disposed = true;
    this.release();
    this.group.removeFromParent();
  }
}
