import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { bodyEntityRecords, defaultBodies, NO_ROTATION } from '@eio/core';
import { BODY_TEXTURES, MAP_LOAD_PX, textureCredits, textureOf, textureU } from '../src/lib/body-textures';
import { refPositionEci, refRadiusKm } from '../src/lib/ref-body';
import { CelestialLayer, createMapSphere, type MapEnv } from '../src/scene/celestial';
import { createBodyMaterial, createMapMaterial } from '../src/scene/materials';

const repo = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(repo, p), 'utf8');

describe('textureU (longitude to map column)', () => {
  it('centred-east: the prime meridian is the centre, east goes right, and the antimeridian wraps', () => {
    expect(textureU(0)).toBeCloseTo(0.5, 12);
    expect(textureU(90)).toBeCloseTo(0.75, 12);
    expect(textureU(-90)).toBeCloseTo(0.25, 12);
    expect(textureU(180)).toBeCloseTo(0, 12);
    expect(textureU(-180)).toBeCloseTo(0, 12);
    expect(textureU(105)).toBeCloseTo(0.5 + 105 / 360, 12); // Io's Pele
    expect(textureU(-56)).toBeCloseTo(0.5 - 56 / 360, 12); // Callisto's Valhalla, 56 W
  });

  it('the other layouts', () => {
    expect(textureU(0, 'zero-left-east')).toBe(0);
    expect(textureU(270, 'zero-left-east')).toBeCloseTo(0.75, 12);
    expect(textureU(-90, 'zero-left-east')).toBeCloseTo(0.75, 12);
    expect(textureU(90, 'centred-west')).toBeCloseTo(0.25, 12);
  });

  it('agrees with the sphere geometry the scene uses (u of a vertex at a given east longitude)', () => {
    const g = createMapSphere(1, 72, 36);
    const pos = g.getAttribute('position'), uv = g.getAttribute('uv');
    let checked = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (Math.abs(z) > 0.9 || Math.hypot(x, y) < 0.3) continue; // skip the poles
      const lon = (Math.atan2(y, x) * 180) / Math.PI;
      const du = Math.abs(uv.getX(i) - textureU(lon, 'centred-east'));
      expect(Math.min(du, 1 - du)).toBeLessThan(1e-6);
      checked++;
    }
    expect(checked).toBeGreaterThan(500);
  });
});

describe('the texture table', () => {
  it('names only registry bodies that have an IAU rotation, so the map has a prime meridian to sit on', () => {
    for (const id of Object.keys(BODY_TEXTURES)) {
      expect(defaultBodies.has(id), id).toBe(true);
      const rot = defaultBodies.get(id).rotation;
      expect(rot, id).not.toEqual(NO_ROTATION);
      expect(rot.kind, id).toBe('linear');
    }
  });

  it('has unique, plain file names that scripts/fetch-assets.mjs downloads, and every one is documented', () => {
    const files = Object.values(BODY_TEXTURES).map((t) => t.file);
    expect(new Set(files).size).toBe(files.length);
    const script = read('scripts/fetch-assets.mjs');
    const reference = read('docs/reference.md');
    for (const f of files) {
      expect(f).toMatch(/^[a-z]+\.jpg$/);
      const stem = f.replace('.jpg', '');
      // the script names each file as `textures/<f>` or builds it from usgs('<stem>', ...)
      expect(script.includes(`textures/${f}`) || script.includes(`usgs('${stem}'`), f).toBe(true);
      expect(reference.includes(f), f).toBe(true);
    }
  });

  it('uses the east-right centred layout everywhere (what the script requests from the WMS) and lazy loading except Mars', () => {
    for (const [id, t] of Object.entries(BODY_TEXTURES)) {
      expect(t.layout, id).toBe('centred-east');
      expect(!!t.eager, id).toBe(id === 'MARS');
      expect(t.credit.length).toBeGreaterThan(10);
    }
    expect(textureOf('SATURN')).toBeUndefined();
    expect(textureOf('JUPITER')?.file).toBe('jupiter.jpg');
  });

  it('is credited in the README', () => {
    const readme = read('README.md');
    expect(textureCredits().length).toBeGreaterThan(2);
    expect(readme).toContain('USGS Astrogeology');
    expect(readme).toContain('Cassini');
  });
});

describe('lazy loading of a body map in the celestial layer', () => {
  afterEach(() => vi.restoreAllMocks());
  const T0 = Date.UTC(2026, 9, 25, 12, 0, 0), FOV = 50, VP = 700;
  const focal = VP / (2 * Math.tan((FOV * Math.PI) / 360));
  const camAt = (id: string, px: number) => new THREE.Vector3(...refPositionEci(id, T0)).add(new THREE.Vector3(refRadiusKm(id) / (px / focal), 0, 0));

  function make(loadTexture: (url: string, ok: (t: THREE.Texture) => void, fail: () => void) => void, ids = ['body-io'], extra: Partial<MapEnv> = {}) {
    const scene = new THREE.Scene();
    const layer = new CelestialLayer(scene, new THREE.Vector3(1, 0, 0), { loadTexture, ...extra });
    layer.setBodies(bodyEntityRecords().filter((r) => ids.includes(r.id)));
    const sphereOf = (id: string) => scene.children.find((o) => (o as THREE.Mesh).isMesh && Math.abs(((o as THREE.Mesh).geometry as THREE.SphereGeometry).parameters.radius - refRadiusKm(id)) < 1e-6) as THREE.Mesh;
    return { scene, layer, io: sphereOf('IO'), jupiter: sphereOf('JUPITER') };
  }
  const tex = () => new THREE.Texture({ width: 2048, height: 1024 } as unknown as HTMLImageElement);

  it('asks for nothing while the disc is small, loads at MAP_LOAD_PX, keeps it under hysteresis, and frees it when far', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const urls: string[] = [];
    const t = tex();
    const dispose = vi.spyOn(t, 'dispose');
    const { layer, io } = make((url, ok) => { urls.push(url); ok(t); });
    const tinted = io.material as THREE.ShaderMaterial;
    expect(tinted.uniforms.uTint).toBeDefined();

    layer.update(T0, camAt('IO', MAP_LOAD_PX / 3));
    layer.updateMeshes(FOV, VP);
    expect(urls).toEqual([]);

    layer.update(T0, camAt('IO', MAP_LOAD_PX * 2));
    layer.updateMeshes(FOV, VP);
    expect(urls).toEqual(['/textures/io.jpg']);
    expect((io.material as THREE.ShaderMaterial).uniforms.uTex.value).toBe(t);

    layer.update(T0, camAt('IO', MAP_LOAD_PX * 0.6)); // under the load size, over 40 %
    layer.updateMeshes(FOV, VP);
    expect(io.material).not.toBe(tinted);
    expect(urls.length).toBe(1);

    layer.update(T0, camAt('IO', MAP_LOAD_PX * 0.1));
    layer.updateMeshes(FOV, VP);
    expect(io.material).toBe(tinted);
    expect(dispose).toHaveBeenCalled();
  });

  it('a missing file is asked for once and the body keeps its procedural look', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let asked = 0;
    const { layer, io } = make((_u, _ok, fail) => { asked++; fail(); });
    for (let i = 0; i < 3; i++) {
      layer.update(T0, camAt('IO', MAP_LOAD_PX * 3));
      layer.updateMeshes(FOV, VP);
    }
    expect(asked).toBe(1);
    expect((io.material as THREE.ShaderMaterial).uniforms.uTint).toBeDefined();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('io.jpg is missing'));
  });

  it('a map that arrives after the body left is discarded, not applied', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let finish: (() => void) | undefined;
    const t = tex();
    const dispose = vi.spyOn(t, 'dispose');
    const { layer, io } = make((_u, ok) => { finish = () => ok(t); });
    layer.update(T0, camAt('IO', MAP_LOAD_PX * 2));
    layer.updateMeshes(FOV, VP);
    layer.update(T0, camAt('IO', MAP_LOAD_PX * 0.1));
    layer.updateMeshes(FOV, VP);
    finish?.();
    expect(dispose).toHaveBeenCalled();
    expect((io.material as THREE.ShaderMaterial).uniforms.uTint).toBeDefined();
  });

  it('the eager flag is the one switch: an eager body other than Mars loads at build, a lazy one does not', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const urls: string[] = [];
    const entry = { file: 'io.jpg', layout: 'centred-east' as const, credit: 'test credit line' };
    make((u) => { urls.push(u); }, ['body-io'], { textures: { IO: { ...entry, eager: true } } });
    expect(urls).toEqual(['/textures/io.jpg']);
    urls.length = 0;
    make((u) => { urls.push(u); }, ['body-io'], { textures: { IO: entry } });
    expect(urls).toEqual([]);
  });

  it('the map material takes the same normal correction as the tinted one (same uniform, same shader line), for the oblate giants and the ellipsoids', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { layer, jupiter } = make((_u, ok) => ok(tex()), ['body-jupiter']);
    const tinted = jupiter.material as THREE.ShaderMaterial;
    const f = defaultBodies.get('JUPITER').flattening;
    expect(tinted.uniforms.uInv2.value.toArray()).toEqual([1, 1, expect.closeTo(1 / ((1 - f) * (1 - f)), 12)]);
    layer.update(T0, camAt('JUPITER', MAP_LOAD_PX * 2));
    layer.updateMeshes(FOV, VP);
    const mapped = jupiter.material as THREE.ShaderMaterial;
    expect(mapped).not.toBe(tinted);
    expect(mapped.uniforms.uInv2.value.toArray()).toEqual(tinted.uniforms.uInv2.value.toArray());
    const line = 'normalize(mat3(modelMatrix) * (normal * uInv2))';
    expect(mapped.vertexShader).toContain(line);
    expect(createBodyMaterial(new THREE.Vector3(1, 0, 0), { color: '#fff' }).vertexShader).toContain(line);
    expect(createMapMaterial(new THREE.Vector3(1, 0, 0), null, [4, 1, 0.25]).uniforms.uInv2.value.toArray()).toEqual([4, 1, 0.25]);
  });

  it('dispose() frees a held map and the set-aside material, and later frames request nothing', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const urls: string[] = [];
    const t = tex();
    const dispose = vi.spyOn(t, 'dispose');
    const { layer, io } = make((u, ok) => { urls.push(u); ok(t); });
    layer.update(T0, camAt('IO', MAP_LOAD_PX * 2));
    layer.updateMeshes(FOV, VP);
    const mapped = io.material as THREE.ShaderMaterial;
    expect(mapped.uniforms.uTex.value).toBe(t);
    const matDispose = vi.spyOn(mapped, 'dispose');
    layer.dispose();
    expect(dispose).toHaveBeenCalled();
    expect(matDispose).toHaveBeenCalled();
    expect((io.material as THREE.ShaderMaterial).uniforms.uTint).toBeDefined();
    layer.update(T0, camAt('IO', MAP_LOAD_PX * 3));
    layer.updateMeshes(FOV, VP);
    expect(urls.length).toBe(1);
  });

  it('keeps the flattening of a mapped giant: Jupiter stays squashed along its pole with or without the map', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { layer, jupiter } = make((_u, ok) => ok(tex()), ['body-jupiter']);
    layer.update(T0, camAt('JUPITER', MAP_LOAD_PX * 2));
    layer.updateMeshes(FOV, VP);
    expect((jupiter.material as THREE.ShaderMaterial).uniforms.uTex).toBeDefined();
    expect(jupiter.scale.z).toBeCloseTo(1 - defaultBodies.get('JUPITER').flattening, 9);
    expect(jupiter.scale.x).toBe(1);
  });
});
