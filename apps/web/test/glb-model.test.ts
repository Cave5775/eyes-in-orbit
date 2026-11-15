import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AssetCache } from '../src/lib/asset-cache';
import { assetModel } from '../src/scene/models/asset-model';
import { triangleGlb } from './glb-fixture';
import { disposeScene, normalizeScene, parseGlb, sceneBytes, type LoadedGlb } from '../src/scene/models/glb';

describe('parseGlb', () => {
  it('parses a glb, centres it on its bounding sphere and scales that sphere to radius 1', async () => {
    const r = await parseGlb(triangleGlb(10, [100, 0, 0]));
    const box = new THREE.Box3().setFromObject(r.value.scene);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    expect(r.value.nativeRadius).toBeCloseTo(Math.hypot(5, 5) / 1, 1); // the box of the triangle is 10 x 10 x 0: radius 7.07
    expect(sphere.radius).toBeCloseTo(1, 5);
    expect(Math.hypot(sphere.center.x, sphere.center.y, sphere.center.z)).toBeLessThan(1e-4);
    expect(r.bytes).toBe(36); // three float32 xyz
  });

  it('rejects a file that is not a glb (a dev server answers a missing file with its HTML page)', async () => {
    const html = new TextEncoder().encode('<!doctype html><html></html>').buffer as ArrayBuffer;
    await expect(parseGlb(html)).rejects.toBeTruthy();
  });

  it('normalizeScene reports 0 for an empty scene and sceneBytes counts geometry', () => {
    expect(normalizeScene(new THREE.Group())).toBe(0);
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
    expect(sceneBytes(g)).toBeGreaterThan(0);
    disposeScene(g);
  });
});

describe('assetModel', () => {
  const spec = { key: 'test-glb', label: 'Test', url: '/models/test.glb', radiusM: 50, lodKm: 1, minViewKm: 0.01, fitKm: 0.2, attitude: 'lvlh' as const };
  const mk = () => {
    let loads = 0, disposed = 0;
    const cache = new AssetCache<LoadedGlb>({
      loader: async () => {
        loads++;
        return parseGlb(triangleGlb());
      },
      dispose: (v) => {
        disposed++;
        disposeScene(v.scene);
      },
      budgetBytes: 1e9,
    });
    return { cache, stats: () => ({ loads, disposed }) };
  };

  it('is a registry-shaped ModelDef: a placeholder ball at once, the real mesh when the file has loaded', async () => {
    const { cache, stats } = mk();
    const def = assetModel(spec, cache);
    expect([def.key, def.radiusM, def.lodKm, def.attitude]).toEqual(['test-glb', 50, 1, 'lvlh']);
    expect(stats().loads).toBe(0); // defining it requests nothing
    const inst = def.build();
    expect(inst.root.children).toHaveLength(1);
    expect((inst.root.children[0] as THREE.Mesh).geometry).toBeInstanceOf(THREE.SphereGeometry);
    await cache.acquire(spec.url).ready;
    cache.release(spec.url);
    await new Promise((r) => setTimeout(r, 0));
    expect(inst.root.children).toHaveLength(1);
    expect(inst.root.children[0]).not.toBeInstanceOf(THREE.Mesh); // the cloned scene graph replaced the ball
    const sphere = new THREE.Box3().setFromObject(inst.root).getBoundingSphere(new THREE.Sphere());
    expect(sphere.radius).toBeCloseTo(50, 3); // drawn at radiusM metres
    inst.dispose();
  });

  it('many instances share one load and one parsed geometry; dimming is per instance', async () => {
    const { cache, stats } = mk();
    const def = assetModel(spec, cache);
    const a = def.build(), b = def.build();
    await cache.acquire(spec.url).ready;
    await new Promise((r) => setTimeout(r, 0));
    expect(stats().loads).toBe(1);
    const mesh = (i: typeof a) => {
      let m: THREE.Mesh | null = null;
      i.root.traverse((o) => { if ((o as THREE.Mesh).isMesh && !(o as THREE.Mesh).geometry.type.startsWith('Sphere')) m = o as THREE.Mesh; });
      return m as unknown as THREE.Mesh;
    };
    expect(mesh(a).geometry).toBe(mesh(b).geometry);
    expect(mesh(a).material).not.toBe(mesh(b).material);
    const before = (mesh(b).material as THREE.MeshStandardMaterial).color.r;
    a.setDim(true);
    expect((mesh(a).material as THREE.MeshStandardMaterial).color.r).toBeLessThan(before);
    expect((mesh(b).material as THREE.MeshStandardMaterial).color.r).toBe(before);
    a.setDim(false);
    expect((mesh(a).material as THREE.MeshStandardMaterial).color.r).toBeCloseTo(before, 6);
  });

  it('releases the shared asset when the last instance goes (the cache then decides when to free it)', async () => {
    const { cache, stats } = mk();
    const def = assetModel(spec, cache);
    const a = def.build();
    await cache.acquire(spec.url).ready;
    cache.release(spec.url); // our own probe reference
    await new Promise((r) => setTimeout(r, 0));
    a.dispose();
    a.dispose(); // idempotent
    expect(stats().disposed).toBe(0); // inside the budget: kept for the next time the camera comes back
    cache.clear();
    expect(stats().disposed).toBe(1);
  });

  it('a file that cannot be loaded leaves the placeholder', async () => {
    const cache = new AssetCache<LoadedGlb>({ loader: async () => { throw new Error('404'); }, dispose: () => undefined, budgetBytes: 1 });
    const quiet = console.info;
    console.info = () => undefined;
    try {
      const inst = assetModel(spec, cache).build();
      await cache.acquire(spec.url).ready;
      await new Promise((r) => setTimeout(r, 0));
      expect(inst.root.children).toHaveLength(1);
      expect((inst.root.children[0] as THREE.Mesh).geometry).toBeInstanceOf(THREE.SphereGeometry);
    } finally {
      console.info = quiet;
    }
  });
});
