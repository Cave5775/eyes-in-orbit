import * as THREE from 'three';
import { AssetCache, type AssetLoad } from '../../lib/asset-cache';

/**
 * glTF binary (.glb) models: the third tier of the model framework (docs/models.md). A model file is fetched and parsed once
 * (`MODEL_ASSETS`, shared by every entity and body that names it), normalised to a known size and centred, and handed out by
 * reference; instances clone only the scene graph and their materials, never the geometry or the textures.
 *
 * The loader (`three/addons` GLTFLoader) is imported when the first file is requested, so it is not in the page's first
 * download. Nothing here runs unless an entity or body actually names a mesh.
 */

/** A parsed, normalised model: `scene` is centred on its bounding sphere and scaled so that sphere has radius 1. */
export interface LoadedGlb {
  scene: THREE.Group;
  /** the bounding-sphere radius the file had before normalising, in the file's own units (for the log and tests) */
  nativeRadius: number;
}

/** Memory a parsed scene holds: attribute and index arrays plus 4 bytes a texel (and a third more for mipmaps) per texture. */
export function sceneBytes(root: THREE.Object3D): number {
  let bytes = 0;
  const seen = new Set<unknown>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    const g = m.geometry as THREE.BufferGeometry | undefined;
    if (g && !seen.has(g)) {
      seen.add(g);
      for (const a of Object.values(g.attributes)) bytes += (a as THREE.BufferAttribute).array.byteLength;
      bytes += g.index?.array.byteLength ?? 0;
    }
    for (const mat of ([] as THREE.Material[]).concat(m.material ?? [])) {
      for (const v of Object.values(mat)) {
        const t = v as THREE.Texture | null;
        if (t && (t as THREE.Texture).isTexture && !seen.has(t)) {
          seen.add(t);
          const img = t.image as { width?: number; height?: number } | undefined;
          bytes += Math.round((img?.width ?? 0) * (img?.height ?? 0) * 4 * (4 / 3));
        }
      }
    }
  });
  return bytes;
}

/** Centre `scene` on its bounding sphere and scale it to radius 1; returns the original radius (0 for an empty scene). */
export function normalizeScene(scene: THREE.Group): number {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  if (box.isEmpty()) return 0;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  if (!(sphere.radius > 0)) return 0;
  const holder = new THREE.Group();
  holder.add(...scene.children);
  holder.position.copy(sphere.center).multiplyScalar(-1);
  const out = new THREE.Group();
  out.add(holder);
  scene.add(out);
  out.scale.setScalar(1 / sphere.radius);
  return sphere.radius;
}

/** Free the geometry, materials and textures of a parsed scene. */
export function disposeScene(root: THREE.Object3D): void {
  const done = new Set<{ dispose(): void }>();
  const free = (d: { dispose(): void } | null | undefined) => {
    if (d && !done.has(d)) {
      done.add(d);
      d.dispose();
    }
  };
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    free(m.geometry);
    for (const mat of ([] as THREE.Material[]).concat(m.material ?? [])) {
      for (const v of Object.values(mat)) if (v && (v as THREE.Texture).isTexture) free(v as THREE.Texture);
      free(mat);
    }
  });
}

/** Parse glb bytes into a normalised scene. Rejects on anything that is not a glb (a dev server answers a missing file with its HTML page). */
export async function parseGlb(buf: ArrayBuffer): Promise<AssetLoad<LoadedGlb>> {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    new GLTFLoader().parse(buf, '', (g) => resolve(g as { scene: THREE.Group }), (e) => reject(e instanceof Error ? e : new Error(String((e as { message?: string }).message ?? e))));
  });
  const nativeRadius = normalizeScene(gltf.scene);
  if (!(nativeRadius > 0)) {
    disposeScene(gltf.scene);
    throw new Error('glb has no geometry');
  }
  return { value: { scene: gltf.scene, nativeRadius }, bytes: sceneBytes(gltf.scene) };
}

async function fetchGlb(url: string): Promise<AssetLoad<LoadedGlb>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return parseGlb(await res.arrayBuffer());
}

/** Bytes of parsed models kept (held ones are never evicted, so a scene may exceed this while it needs to). */
export const MODEL_BUDGET_BYTES = 256 * 1024 * 1024;

/** The one cache of parsed models, keyed by URL, shared by the entity models and the bodies. */
export const MODEL_ASSETS = new AssetCache<LoadedGlb>({
  loader: fetchGlb,
  dispose: (v) => disposeScene(v.scene),
  budgetBytes: MODEL_BUDGET_BYTES,
});
