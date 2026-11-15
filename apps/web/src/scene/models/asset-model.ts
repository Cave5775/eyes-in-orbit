import * as THREE from 'three';
import type { AssetCache } from '../../lib/asset-cache';
import { MODEL_ASSETS, type LoadedGlb } from './glb';
import type { AttitudeMode, ModelDef, ModelInstance } from './types';

/** What a glb-backed model needs on top of the usual `ModelDef` fields: where the file is. `radiusM` is the size it is drawn at. */
export interface AssetModelSpec {
  key: string;
  label: string;
  /** the .glb, served from the web app (`/models/<file>.glb`) or a CORS-enabled https URL */
  url: string;
  /** bounding radius the model is drawn at, metres: the file is normalised and scaled to this, so its own units do not matter */
  radiusM: number;
  lodKm: number;
  minViewKm: number;
  fitKm: number;
  attitude: AttitudeMode;
}

const DIM = 0.35;
let placeholderGeo: THREE.SphereGeometry | null = null;
let placeholderMat: THREE.MeshStandardMaterial | null = null;

/** A plain grey ball shown until the file has loaded (shared by every instance, never disposed: it is two small objects). */
function placeholder(radiusM: number): THREE.Mesh {
  placeholderGeo ??= new THREE.SphereGeometry(1, 12, 8);
  placeholderMat ??= new THREE.MeshStandardMaterial({ color: 0x9a9da3, metalness: 0.2, roughness: 0.7 });
  const m = new THREE.Mesh(placeholderGeo, placeholderMat);
  m.scale.setScalar(radiusM);
  return m;
}

/**
 * A `ModelDef` whose geometry comes from a glb file instead of a procedural builder; list it in `registry.ts` like any other
 * and nothing else changes (`EntityRecord.render.model` = its `key`). Scalability rules, all inherited from the framework:
 * - the file is only requested when the first instance is built, which `ModelLayer` does only when the camera is within `lodKm`
 *   of an entity that names it; with nothing near, no request is made;
 * - the parsed geometry and textures are shared by every instance (one Starlink bus for the whole constellation); an instance
 *   holds a cloned scene graph and its own materials (so `setDim` works per entity);
 * - `MODEL_ASSETS` keeps the parsed file while the byte budget allows and disposes it least recently used first;
 * - until the file arrives, or if it never does, a grey ball of the right size stands in: a missing file degrades, never breaks.
 */
export function assetModel(spec: AssetModelSpec, cache: AssetCache<LoadedGlb> = MODEL_ASSETS): ModelDef {
  const build = (): ModelInstance => {
    const root = new THREE.Group();
    const ball = placeholder(spec.radiusM);
    root.add(ball);
    const materials: { mat: THREE.Material & { color?: THREE.Color }; base: THREE.Color | null }[] = [];
    let disposed = false;
    let dim = false;
    const attach = (glb: LoadedGlb) => {
      if (disposed) return;
      const scene = glb.scene.clone(true);
      scene.scale.setScalar(spec.radiusM);
      // own materials (cheap: the textures and geometry stay shared), so one entity can be dimmed without the others
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const own = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone();
        m.material = own;
        for (const mat of ([] as THREE.Material[]).concat(own)) {
          const c = (mat as THREE.Material & { color?: THREE.Color }).color;
          materials.push({ mat, base: c ? c.clone() : null });
        }
      });
      root.remove(ball);
      root.add(scene);
      applyDim();
    };
    const applyDim = () => {
      for (const { mat, base } of materials) if (base && (mat as { color?: THREE.Color }).color) (mat as { color: THREE.Color }).color.copy(base).multiplyScalar(dim ? DIM : 1);
    };
    const got = cache.acquire(spec.url);
    if (got.value) attach(got.value);
    else {
      void got.ready.then(() => {
        const v = cache.peek(spec.url);
        if (v) attach(v);
        else if (cache.stateOf(spec.url) === 'failed') console.info(`[model ${spec.key}] ${spec.url} could not be loaded, keeping the placeholder:`, cache.errorOf(spec.url));
      });
    }
    return {
      root,
      joints: [],
      update: () => undefined,
      setDim(d) {
        dim = d;
        applyDim();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        cache.release(spec.url);
        for (const { mat } of materials) mat.dispose();
        materials.length = 0;
      },
    };
  };
  return { key: spec.key, label: spec.label, radiusM: spec.radiusM, lodKm: spec.lodKm, minViewKm: spec.minViewKm, fitKm: spec.fitKm, attitude: spec.attitude, build };
}
