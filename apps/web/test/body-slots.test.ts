import { describe, expect, it } from 'vitest';
import { bodyStateEci, defaultBodies } from '@eio/core';
import { MAX_OCCLUDERS, MIN_OCCLUDER_PX, OccluderSet, type SceneBody } from '../src/lib/occlusion';
import { GROUP_SLOTS, discGroups, type GroupStats } from '../src/lib/disc-hide';
import { GROUP_DISC_PX, bodyDiscRadiusPx } from '../src/lib/pick';
import { MIN_VERTEX_UNIFORM_VECTORS, POINT_UNIFORM_VECTORS, createPointMaterial } from '../src/scene/materials';
import type { V3 } from '../src/lib/camera';

const FOV = 45, VP = 700;
const FOCAL = VP / (2 * Math.tan((FOV * Math.PI) / 360));
const T = Date.UTC(2026, 9, 29, 12);
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

/** The real registry (35 bodies, real positions at T) as the layer would list it, seen from `cam` (EARTH:inertial, km). */
const world = defaultBodies.all().map((b) => ({ id: b.id, c: bodyStateEci(b.id, T).r as V3, radiusKm: b.radiusKm }));
const sceneBodies = (cam: V3): SceneBody[] =>
  world.map((w) => ({ entityId: `body-${w.id.toLowerCase()}`, c: w.c, rel: sub(w.c, cam), radiusKm: w.radiusKm, k: 1 }));
const at = (id: string, off: V3): V3 => {
  const c = world.find((w) => w.id === id)!.c;
  return [c[0] + off[0], c[1] + off[1], c[2] + off[2]];
};
const cameras: Record<string, V3> = {
  'Earth orbit': at('EARTH', [7000, 0, 0]),
  'near Jupiter': at('JUPITER', [3e5, 1e5, 0]),
  'near Saturn': at('SATURN', [4e5, 0, 1e5]),
  'Sun at 1 AU': at('SUN', [1.496e8, 0, 0]),
  'far out': [3e10, 1e10, 0],
};

/** An independent reference: angular radius (rad) and disc radius (px) of each body, with its registry index. */
const ranked = (bodies: SceneBody[]) =>
  bodies.map((b, i) => ({ i, ang: (b.radiusKm * b.k) / norm(b.rel), disc: bodyDiscRadiusPx(b.radiusKm, b.k, norm(b.rel), FOV, VP) }));
const hasCone = (g: { sinR: number; dist: number }[], b: SceneBody) => g.some((s) => s.sinR < 1 && Math.abs(s.dist - norm(b.rel)) < 1e-6 * s.dist);

describe('occluder slots with the 35 bodies of the registry', () => {
  it('has 35 bodies, more than the slots', () => expect(world.length).toBeGreaterThan(MAX_OCCLUDERS));

  for (const [name, cam] of Object.entries(cameras)) {
    it(`${name}: the slots are the largest discs in the sky in order, none >= ${MIN_OCCLUDER_PX} px dropped while slots remain, deterministic`, () => {
      const bodies = sceneBodies(cam);
      const set = new OccluderSet();
      set.build(bodies, FOV, VP);
      const want = ranked(bodies).filter((r) => r.ang * FOCAL >= MIN_OCCLUDER_PX && r.disc !== Infinity).sort((a, b) => b.ang - a.ang || a.i - b.i);
      expect(set.count).toBe(Math.min(MAX_OCCLUDERS, want.length));
      expect(set.overflow).toBe(Math.max(0, want.length - MAX_OCCLUDERS));
      for (let s = 0; s < set.count; s++) {
        const b = bodies[want[s].i];
        expect(set.slots[s].r, `slot ${s}`).toBeCloseTo(b.radiusKm - Math.min(0.3, b.radiusKm * 0.01), 6);
      }
      const again = new OccluderSet();
      again.build(bodies, FOV, VP);
      expect(again.slots.slice(0, again.count)).toEqual(set.slots.slice(0, set.count));
    });
  }

  it('near Jupiter and Saturn the planet is the first slot', () => {
    for (const [cam, r] of [[cameras['near Jupiter'], 71_492], [cameras['near Saturn'], 60_268]] as [V3, number][]) {
      const set = new OccluderSet();
      set.build(sceneBodies(cam), FOV, VP);
      expect(set.slots[0].r).toBeCloseTo(r - 0.3, 3);
    }
  });

  it('counts the overflow when more than MAX_OCCLUDERS qualify (synthetic bodies), the smallest losing', () => {
    const synth: SceneBody[] = Array.from({ length: MAX_OCCLUDERS + 6 }, (_, i) => ({ entityId: `s${i}`, c: [1e6, i, 0], rel: [1e6, i, 0], radiusKm: 1e6 * (0.02 / (1 + i)), k: 1 }));
    const set = new OccluderSet();
    set.build(synth, FOV, VP);
    expect(set.count).toBe(MAX_OCCLUDERS);
    expect(set.overflow).toBe(6);
    expect(set.slots[0].r).toBeCloseTo(0.02e6, -1);
  });
});

describe('cone slots with the 35 bodies of the registry', () => {
  for (const [name, cam] of Object.entries(cameras)) {
    it(`${name}: the cones go to the largest small discs, in order, registry order on ties`, () => {
      const bodies = sceneBodies(cam);
      const stats: GroupStats = { used: -1, overflow: -1 };
      const g = discGroups(bodies, FOV, VP, GROUP_DISC_PX, GROUP_SLOTS, stats);
      expect(g).toHaveLength(GROUP_SLOTS);
      const want = ranked(bodies).filter((r) => r.disc <= GROUP_DISC_PX).sort((a, b) => b.disc - a.disc || a.i - b.i);
      expect(stats.used).toBe(Math.min(GROUP_SLOTS, want.length));
      expect(stats.overflow).toBe(Math.max(0, want.length - GROUP_SLOTS));
      for (let s = 0; s < GROUP_SLOTS; s++) {
        if (s < stats.used) {
          const b = bodies[want[s].i];
          expect(g[s].sinR, `slot ${s}`).toBeLessThan(1);
          expect(g[s].dist).toBeCloseTo(norm(b.rel), 3);
          expect(g[s].x).toBeCloseTo(b.rel[0] / norm(b.rel), 9);
        } else expect(g[s].sinR).toBeGreaterThan(1);
      }
      expect(discGroups(bodies, FOV, VP)).toEqual(g); // deterministic
    });
  }

  it('near Jupiter the Galilean moons have cones and Jupiter (a big disc) none; near Saturn Titan has one', () => {
    const check = (cam: V3, withCone: string[], without: string) => {
      const bodies = sceneBodies(cam);
      const g = discGroups(bodies, FOV, VP);
      const find = (id: string) => bodies.find((x) => x.entityId === `body-${id.toLowerCase()}`)!;
      for (const id of withCone) expect(hasCone(g, find(id)), id).toBe(true);
      expect(hasCone(g, find(without)), without).toBe(false);
    };
    check(cameras['near Jupiter'], ['IO', 'EUROPA', 'GANYMEDE', 'CALLISTO'], 'JUPITER');
    check(cameras['near Saturn'], ['TITAN'], 'SATURN');
  });

  it('from Earth orbit the Earth is off (big disc), the Moon gets a cone', () => {
    const bodies = sceneBodies(cameras['Earth orbit']);
    const g = discGroups(bodies, FOV, VP);
    expect(hasCone(g, bodies.find((b) => b.entityId === 'body-moon')!)).toBe(true);
    expect(hasCone(g, bodies.find((b) => b.entityId === 'body-earth')!)).toBe(false);
  });

  it('with more candidates than slots the overflow is counted; equal discs keep registry order', () => {
    const synth: SceneBody[] = Array.from({ length: GROUP_SLOTS + 5 }, (_, i) => ({ entityId: `s${i}`, c: [0, 0, 0], rel: [1e6 + i, 0, 0], radiusKm: 1000, k: 1 }));
    const stats: GroupStats = { used: 0, overflow: 0 };
    const g = discGroups(synth, FOV, VP, GROUP_DISC_PX, GROUP_SLOTS, stats);
    expect(stats).toEqual({ used: GROUP_SLOTS, overflow: 5 });
    for (let s = 1; s < GROUP_SLOTS; s++) expect(g[s].dist).toBeGreaterThanOrEqual(g[s - 1].dist); // nearest (largest disc) first
    const same: SceneBody[] = [[1e6, 0, 0], [0, 1e6, 0], [0, 0, 1e6]].map((rel, i) => ({ entityId: `t${i}`, c: [0, 0, 0], rel: rel as V3, radiusKm: 1000, k: 1 }));
    const gs = discGroups(same, FOV, VP);
    expect([gs[0].x, gs[1].y, gs[2].z]).toEqual([1, 1, 1]);
  });
});

describe('the point shader uniform budget', () => {
  it('stays within the 256 vertex uniform vectors WebGL2 guarantees (counted from the slot constants)', () => {
    const u = createPointMaterial(1).uniforms;
    const len = (k: string) => (u[k].value as unknown[]).length;
    expect(len('uOccS')).toBe(MAX_OCCLUDERS);
    expect(len('uOccE')).toBe(MAX_OCCLUDERS);
    expect(len('uOccP')).toBe(MAX_OCCLUDERS);
    expect(len('uGroup')).toBe(GROUP_SLOTS);
    expect(len('uGroupD')).toBe(GROUP_SLOTS);
    expect(len('uGroupE')).toBe(GROUP_SLOTS);
    // occluders 24 x 3, cones 8 + 8 + 8, uOccN + uPx, three.js built-ins 20 (assumed: 4 mat4 + 1 mat3 + cameraPosition)
    expect(POINT_UNIFORM_VECTORS).toBe(3 * 24 + 3 * 8 + 2 + 20);
    expect(POINT_UNIFORM_VECTORS).toBeLessThanOrEqual(MIN_VERTEX_UNIFORM_VECTORS);
  });
});
