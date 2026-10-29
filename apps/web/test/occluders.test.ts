import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EARTH, MARS, bodyEntityRecords, defaultBodies, type Body } from '@eio/core';
import { MAX_OCCLUDERS, MIN_OCCLUDER_PX, OccluderSet, sphereOccludes, type SceneBody } from '../src/lib/occlusion';
import { discGroups, hiddenByDisc } from '../src/lib/disc-hide';
import { CelestialLayer } from '../src/scene/celestial';
import { occlusionUniforms, setOccluderUniforms } from '../src/scene/materials';
import type { V3 } from '../src/lib/camera';
import { glslBodyHides } from './glsl-occlusion';

const FOV = 45, VP = 700;
const FOCAL = VP / (2 * Math.tan((FOV * Math.PI) / 360));
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const T = Date.UTC(2026, 5, 1, 12, 0, 0);

/** A body entry as `CelestialLayer.bodies()` has it, at world `c` seen from `cam`. */
const entry = (id: string, c: V3, radiusKm: number, cam: V3, flattening = 0): SceneBody => ({ entityId: id, c, rel: sub(c, cam), radiusKm, k: 1, flattening });
const build = (bodies: readonly SceneBody[]): OccluderSet => {
  const set = new OccluderSet();
  set.build(bodies, FOV, VP);
  return set;
};

describe('one occluder list for every body: the slots', () => {
  it('orders the slots by angular radius, largest first, and keeps the Earth an ellipsoid like any other entry', () => {
    const cam: V3 = [30_000, 0, 0];
    const set = build([
      entry('far-big', [4e8, 0, 0], 1.7e5, cam), // 4.3e-4 rad
      entry('earth', [0, 0, 0], EARTH.radiusKm, cam, EARTH.flattening), // 0.21 rad
      entry('near-small', [30_000, 9000, 0], 1000, cam), // 0.11 rad
    ]);
    expect(set.count).toBe(3);
    expect(set.slots.slice(0, 3).map((s) => (s.r > 5e4 ? 'far-big' : s.r > 6000 ? 'earth' : 'near-small'))).toEqual(['earth', 'near-small', 'far-big']);
    const earth = set.slots[0];
    expect(earth.k).toBeCloseTo(1 / (1 - EARTH.flattening), 12);
    expect(earth.z).toBeCloseTo(0, 6); // the Earth's centre is at the camera's height: z * k stays 0
    expect(set.slots[1].k).toBe(1); // a sphere
  });

  it('skips a body under MIN_OCCLUDER_PX, one the camera is inside, and one of radius 0', () => {
    const cam: V3 = [0, 0, 0];
    const dist = 1e7;
    const tiny = (MIN_OCCLUDER_PX * 0.9 * dist) / FOCAL, ok = (MIN_OCCLUDER_PX * 1.1 * dist) / FOCAL;
    const set = build([entry('tiny', [dist, 0, 0], tiny, cam), entry('ok', [0, dist, 0], ok, cam), entry('inside', [100, 0, 0], 500, cam), entry('none', [0, 0, dist], 0, cam)]);
    expect(set.count).toBe(1);
    expect(set.slots[0].r).toBeCloseTo(ok - Math.min(0.3, ok * 0.01), 6);
    expect(set.overflow).toBe(0);
  });

  it('with more bodies than slots the largest in the sky win, and the overflow is counted', () => {
    const cam: V3 = [0, 0, 0];
    const n = MAX_OCCLUDERS + 9;
    // body i has angular radius 0.01 / (1 + i) rad, shuffled order
    const order = Array.from({ length: n }, (_, i) => (i * 7) % n);
    const bodies = order.map((i) => entry(`b${i}`, [1e6, 0, 0], 1e6 * (0.01 / (1 + i)), cam));
    const set = build(bodies);
    expect(set.count).toBe(MAX_OCCLUDERS);
    expect(set.overflow).toBe(9);
    expect(set.maxOverflow).toBe(9);
    const sky = set.slots.map((s) => s.r / 1e6);
    for (let i = 1; i < MAX_OCCLUDERS; i++) expect(sky[i - 1]).toBeGreaterThan(sky[i]); // sorted, largest first
    expect(sky[0]).toBeCloseTo(0.01, 5); // body 0, the biggest
    expect(sky[MAX_OCCLUDERS - 1]).toBeGreaterThan(0.01 / (1 + MAX_OCCLUDERS)); // body 23 was the last to make it, body 24.. lost
    set.build([], FOV, VP);
    expect(set.count).toBe(0);
    expect(set.overflow).toBe(0);
    expect(set.maxOverflow).toBe(9); // the debug counter keeps the worst
  });

  it('rebuilding allocates nothing: the same slot objects are mutated', () => {
    const cam: V3 = [0, 0, 0];
    const set = new OccluderSet();
    const before = new Set(set.slots);
    const arr = set.slots;
    for (let i = 0; i < 5; i++) set.build([entry('a', [1e5 * (i + 1), 0, 0], 5000, cam), entry('b', [0, 2e5, 0], 9000, cam)], FOV, VP);
    expect(set.slots).toBe(arr);
    expect(new Set(set.slots)).toEqual(before);
    expect(set.slots).toHaveLength(MAX_OCCLUDERS);
  });
});

describe('the GPU and the CPU share the slots and the formula', () => {
  // the drawn bodies of the real scene, in float64, seen from four cameras
  const sunC: V3 = [-1.21e8, -7.89e7, -3.42e7], moonC: V3 = [1.2e5, 3.0e5, 1.65e5], marsC: V3 = [-1.589e8, 1.353e8, 6.5e7], jupC: V3 = [5.2e8, 1e7, -3e7];
  const world = (cam: V3): SceneBody[] => [
    entry('earth', [0, 0, 0], EARTH.radiusKm, cam, EARTH.flattening),
    entry('moon', moonC, 1737.4, cam),
    entry('sun', sunC, 695_700, cam),
    entry('mars', marsC, MARS.radiusKm, cam),
    entry('jupiter', jupC, 71_492, cam),
  ];
  const cameras: Record<string, V3> = {
    'low Earth orbit': [6778, 0, 0],
    'above the Moon': [moonC[0] + 1500, moonC[1] + 2200, moonC[2] - 400],
    'Sun frame, 1.5e8 km out': [1.496e8 * 0.8, 1.496e8 * 0.5, 1.496e8 * 0.33166],
    'Mars view, 14,000 km': [marsC[0] + 8000, marsC[1] - 9000, marsC[2] + 6000],
    'Jupiter view, 3e5 km': [jupC[0] - 3e5, jupC[1] + 1e5, jupC[2]],
  };

  for (const [name, cam] of Object.entries(cameras)) {
    it(`float32 emulation of the point shader equals the CPU test over a grid of positions: ${name}`, () => {
      const bodies = world(cam);
      const set = build(bodies);
      let agree = 0, hidden = 0, shown = 0;
      for (const b of bodies) {
        const d = norm(b.rel);
        const ax: V3 = [b.rel[0] / d, b.rel[1] / d, b.rel[2] / d];
        const e1: V3 = Math.abs(ax[2]) < 0.9 ? [-ax[1], ax[0], 0] : [0, -ax[2], ax[1]];
        const n1 = norm(e1);
        const u1: V3 = [e1[0] / n1, e1[1] / n1, e1[2] / n1];
        const u2: V3 = [ax[1] * u1[2] - ax[2] * u1[1], ax[2] * u1[0] - ax[0] * u1[2], ax[0] * u1[1] - ax[1] * u1[0]];
        const ang = b.radiusKm / d;
        for (let i = 0; i < 1200; i++) {
          // directions within 2.2 angular radii of the body's centre, at distances from a third of it to twice it
          const s = ((i % 24) / 24) * 2.2 * ang, phi = i * 0.618;
          const dist = d * [0.3, 0.9, 0.999, 1, 1.001, 1.3, 2][i % 7];
          const dir: V3 = [0, 1, 2].map((j) => ax[j] + s * (Math.cos(phi) * u1[j] + Math.sin(phi) * u2[j])) as V3;
          const dn = norm(dir);
          const rel: V3 = [(dir[0] / dn) * dist, (dir[1] / dn) * dist, (dir[2] / dn) * dist];
          const cpu = set.hides(rel[0], rel[1], rel[2]);
          // keep away from the exact grazing and surface-crossing cases, where float32 may legitimately differ
          const wiggle = (k: number) => set.hides(rel[0] * k, rel[1] * k, rel[2] * k);
          if (wiggle(0.9995) !== cpu || wiggle(1.0005) !== cpu) continue;
          agree++;
          if (cpu) hidden++; else shown++;
          expect(glslBodyHides(set, rel[0], rel[1], rel[2]), `${b.entityId} case ${i}`).toBe(cpu);
        }
      }
      expect(agree).toBeGreaterThan(2500);
      if (set.count > 0) {
        expect(hidden).toBeGreaterThan(100);
        expect(shown).toBeGreaterThan(100);
      }
    });
  }

  it('the slots hold the same numbers the uniforms carry (xyz scaled in z, radius, c2, k, count)', () => {
    const cam = cameras['low Earth orbit'];
    const set = build(world(cam));
    const u = occlusionUniforms();
    setOccluderUniforms(u, set);
    expect(u.uOccN.value).toBe(set.count);
    for (let i = 0; i < set.count; i++) {
      const s = set.slots[i];
      expect((u.uOccS.value as THREE.Vector4[])[i].toArray()).toEqual([s.x, s.y, s.z, s.r]);
      expect((u.uOccE.value as THREE.Vector2[])[i].toArray()).toEqual([s.c2, s.k]);
    }
    expect((u.uOccS.value as unknown[]).length).toBe(MAX_OCCLUDERS);
  });
});

describe('Mars hides what is behind it (the bug: it was a CPU-only occluder, the point shader drew the points anyway)', () => {
  const layer = new CelestialLayer(new THREE.Scene(), new THREE.Vector3(1, 0, 0), { loadTexture: () => undefined });
  layer.setBodies(bodyEntityRecords().filter((r) => r.id === 'body-earth' || r.id === 'body-mars'));

  it('an orbiter 3,678 km from Mars is hidden by the point shader exactly where the CPU says so', () => {
    layer.update(T, new THREE.Vector3(0, 0, 0));
    const mars = layer.bodies().find((b) => b.entityId === 'body-mars')!;
    // the camera 14,000 km from Mars (the Mars view)
    const u: V3 = [mars.c[0] / norm(mars.c), mars.c[1] / norm(mars.c), mars.c[2] / norm(mars.c)];
    const side: V3 = [-u[1], u[0], 0];
    const sn = norm(side);
    const cam: V3 = [mars.c[0] + 14_000 * side[0] / sn, mars.c[1] + 14_000 * side[1] / sn, mars.c[2]];
    layer.update(T, new THREE.Vector3(...cam));
    const set = new OccluderSet();
    set.build(layer.bodies(), FOV, VP);
    const marsRel = mars.rel;
    const dm = norm(marsRel);
    const along = (t: number, lateral = 0): V3 => {
      // a point at distance `t` from the camera along the line to Mars' centre, `lateral` km off it
      const dirr: V3 = [marsRel[0] / dm, marsRel[1] / dm, marsRel[2] / dm];
      const off: V3 = [-dirr[1], dirr[0], 0];
      const on = norm(off);
      return [dirr[0] * t + (off[0] / on) * lateral, dirr[1] * t + (off[1] / on) * lateral, dirr[2] * t + (off[2] / on) * lateral];
    };
    const behind = along(dm + 3678), beside = along(dm + 3678, 6000), inFront = along(dm - 3678);
    expect(set.hides(...behind)).toBe(true);
    expect(glslBodyHides(set, ...behind)).toBe(true); // THE fix: the shader hides it
    expect(set.hides(...beside)).toBe(false);
    expect(glslBodyHides(set, ...beside)).toBe(false);
    expect(set.hides(...inFront)).toBe(false);
    expect(glslBodyHides(set, ...inFront)).toBe(false);
    // the Earth is 1e8 km away here: well under MIN_OCCLUDER_PX, so Mars is the only slot
    expect(set.count).toBe(1);
  });

  it('the layer exposes one list: the same array every frame, with rel, the Earth ellipsoid and its system reach', () => {
    const a = layer.bodies();
    layer.update(T + 1000, new THREE.Vector3(1, 2, 3));
    expect(layer.bodies()).toBe(a);
    const earth = a.find((b) => b.entityId === 'body-earth')!;
    expect(earth.flattening).toBe(EARTH.flattening);
    expect(earth.reachKm).toBeGreaterThan(0);
    expect(earth.depthKm).toBeGreaterThan(0);
    expect(earth.rel).toEqual([-1, -2, -3]);
    const mars = a.find((b) => b.entityId === 'body-mars')!;
    expect(mars.flattening ?? 0).toBe(0);
    expect(mars.rel[0]).toBeCloseTo(mars.c[0] - 1, 6);
  });
});

describe('adding a body needs nothing beyond the layer exposing it (a Jupiter at 5e8 km)', () => {
  const JUPITER: Body = {
    id: 'JUPITER', name: 'Jupiter', parentId: 'SUN', radiusKm: 71_492, flattening: 0.06487, gm: 1.26686534e8,
    rotation: { kind: 'linear', poleRaDeg: 268.057, poleDecDeg: 64.495, w0Deg: 284.95, rateDegPerDay: 870.536 },
    ephemeris: () => ({ r: [5e8, 0, 0], v: [0, 0, 0] }),
    approx: true,
  };
  defaultBodies.register(JUPITER);
  const layer = new CelestialLayer(new THREE.Scene(), new THREE.Vector3(1, 0, 0), { loadTexture: () => undefined });
  layer.setBodies(bodyEntityRecords().filter((r) => ['body-earth', 'body-mars', 'body-jupiter'].includes(r.id)));

  it('it is in the layer list with no other code', () => {
    layer.update(T, new THREE.Vector3(0, 0, 0));
    const jup = layer.bodies().find((b) => b.entityId === 'body-jupiter');
    expect(jup).toBeDefined();
    expect(jup!.radiusKm).toBe(71_492);
    expect(norm(jup!.rel)).toBeGreaterThan(3e8);
  });

  it('from Earth it is a 0.09 px dot: no shader slot (too small to hide anything) but a disc cone, so the objects over it are hidden and a click finds it', () => {
    layer.update(T, new THREE.Vector3(0, 0, 0));
    const bodies = layer.bodies();
    const jup = bodies.find((b) => b.entityId === 'body-jupiter')!;
    expect((jup.radiusKm / norm(jup.rel)) * FOCAL).toBeLessThan(MIN_OCCLUDER_PX);
    const set = build(bodies);
    expect(set.slots.slice(0, set.count).some((s) => s.r > 7e4)).toBe(false);
    const groups = discGroups(bodies, FOV, VP);
    const g = groups.find((s) => s.sinR < 1 && Math.abs(s.dist - norm(jup.rel)) < 1e-3 * s.dist)!; // slots are in size order, not list order
    expect(g.sinR).toBeLessThan(1);
    expect(g.dist).toBeCloseTo(norm(jup.rel), 3);
    expect(hiddenByDisc(jup.rel[0] * 0.5, jup.rel[1] * 0.5, jup.rel[2] * 0.5, groups)).toBe(true); // in front of it, on its cone
  });

  it('2e7 km from it, it is a shader slot and hides what is behind it, GPU emulation and CPU alike, with its flattening ignored (a sphere here)', () => {
    layer.update(T, new THREE.Vector3(0, 0, 0));
    const jc = layer.bodies().find((b) => b.entityId === 'body-jupiter')!.c;
    const cam: V3 = [jc[0] - 2e7, jc[1], jc[2]];
    layer.update(T, new THREE.Vector3(...cam));
    const set = build(layer.bodies());
    const jupSlot = set.slots[0];
    expect(set.count).toBeGreaterThanOrEqual(1);
    expect(jupSlot.r).toBeCloseTo(71_492 - 0.3, 6); // the margin, like every body
    for (const [rel, expected] of [[[2e7 + 5e5, 0, 0], true], [[2e7 + 5e5, 8e4, 0], false], [[1.9e7, 0, 0], false], [[3e7, 70_000, 0], true]] as [V3, boolean][]) {
      expect(set.hides(...rel)).toBe(expected);
      expect(glslBodyHides(set, ...rel)).toBe(expected);
      expect(sphereOccludes(jupSlot, ...rel)).toBe(expected);
    }
    const u = occlusionUniforms();
    setOccluderUniforms(u, set);
    expect(u.uOccN.value).toBe(set.count);
    expect((u.uOccS.value as THREE.Vector4[])[0].w).toBeCloseTo(jupSlot.r, 4);
    // and the cone for the same frame comes from the same list: its disc is 3 px, so it is on
    const groups = discGroups(layer.bodies(), FOV, VP);
    expect(groups.some((s) => s.sinR < 1 && Math.abs(s.dist - 2e7) < 1)).toBe(true);
  });
});
