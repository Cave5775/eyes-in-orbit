import { describe, expect, it } from 'vitest';
import { bodyEntityRecords, entityRank } from '@eio/core';
import {
  CLUSTER_PX, GROUP_DISC_PX, bodyDiscRadiusPx, bodyHitRadiusPx, bodyPickExtra, gatherCandidates, moveIndex, pickMeta, popupPlacement,
  SHOW_EXEMPT, rankMap, resolvePick, wheelSteps, type PickHit, type PickSource,
} from '../src/lib/pick';

// Identity projection-view: ndc = (x, y), w = h = 200, so screen x = 100 + 100 x and screen y = 100 - 100 y.
const M = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const W = 200, H = 200;
const sx = (px: number) => (px - 100) / 100;
const sy = (py: number) => (100 - py) / 100;
const never = (_x: number, _y: number, _z: number): boolean => false;

/** points given as screen px; z is arbitrary (identity matrix: w = 1) */
function source(pts: { id: string; x: number; y: number; size?: number; show?: number }[], bias = 0): PickSource & { rel: Float32Array; world: Float32Array } {
  const n = pts.length;
  const rel = new Float32Array(n * 3), world = new Float32Array(n * 3), size = new Float32Array(n), show = new Float32Array(n);
  pts.forEach((p, i) => {
    rel.set([sx(p.x), sy(p.y), 0], i * 3);
    world.set([7000, 0, 0], i * 3);
    size[i] = p.size ?? 4;
    show[i] = p.show ?? 1;
  });
  return { ids: pts.map((p) => p.id), rel, world, size, show, bias };
}

const run = (src: PickSource[], extras: Parameters<typeof gatherCandidates>[1], max = 12, occluded: (x: number, y: number, z: number) => boolean = never, wantTotal = true) =>
  gatherCandidates(src, extras, M, W, H, 100, 100, { max, occluded, wantTotal });

describe('gatherCandidates', () => {
  it('returns one entry for an isolated object and none for an empty spot', () => {
    expect(run([source([{ id: 'a', x: 103, y: 100 }, { id: 'far', x: 160, y: 100 }])], []).items.map((h) => h.id)).toEqual(['a']);
    expect(run([source([{ id: 'far', x: 160, y: 100 }])], []).items).toEqual([]);
  });

  it('lists everything within the cluster radius, nearest first', () => {
    const r = run([source([
      { id: 'c', x: 100 + CLUSTER_PX - 1, y: 100 },
      { id: 'a', x: 101, y: 100 },
      { id: 'b', x: 100, y: 105 },
      { id: 'out', x: 100 + CLUSTER_PX + 2, y: 100 },
    ])], []);
    expect(r.items.map((h) => h.id)).toEqual(['a', 'b', 'c']);
    expect(r.items[1].dist).toBeCloseTo(5, 5);
    expect(r.total).toBe(3);
  });

  it('honours a larger own hit radius (a big marker is hit from further away)', () => {
    expect(run([source([{ id: 'big', x: 100 + CLUSTER_PX + 4, y: 100, size: 40 }])], []).items.map((h) => h.id)).toEqual(['big']);
  });

  it('skips points that are not drawn, scoped out, unpositioned or behind the camera', () => {
    const s = source([
      { id: 'hidden', x: 100, y: 100, size: 0 },
      { id: 'scoped', x: 100, y: 101, show: 0 },
      { id: 'nopos', x: 100, y: 102 },
      { id: 'behind', x: 100, y: 103 },
      { id: 'ok', x: 100, y: 104 },
    ]);
    s.world[2 * 3] = s.world[2 * 3 + 1] = s.world[2 * 3 + 2] = 0;
    // behind the camera: w = m[3] x + m[7] y + m[11] z + m[15]; use a matrix that makes w = 1 - z
    const m = new Float32Array(M);
    m[11] = -1;
    (s.rel as Float32Array)[3 * 3 + 2] = 2;
    const r = gatherCandidates([s], [], m, W, H, 100, 100, { max: 12, occluded: never });
    expect(r.items.map((h) => h.id)).toEqual(['ok']);
  });

  it('drops objects behind a body, and the list and the first entry stay consistent', () => {
    const s = source([{ id: 'near-but-hidden', x: 100, y: 100 }, { id: 'visible', x: 106, y: 100 }]);
    const occ = (x: number) => Math.abs(x) < 0.001; // the point at screen x = 100 is behind the Earth
    const r = run([s], [], 12, occ);
    expect(r.items.map((h) => h.id)).toEqual(['visible']);
    // a single click takes the first element of the same call
    expect(run([s], [], 1, occ, false).items[0].id).toBe(r.items[0].id);
  });

  it('is not limited to the nearest 8: a hidden crowd cannot hide the visible object behind it', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ id: `h${i}`, x: 100 + (i % 3), y: 100 + Math.floor(i / 3) * 0.1 }));
    pts.push({ id: 'v', x: 100, y: 108 });
    // screen y 100..100.6 is ndc y 0..-0.006; v is at -0.08. Everything above -0.07 is behind the Earth
    const r = run([source(pts)], [], 12, (_x, y) => y > -0.07);
    expect(r.items.map((h) => h.id)).toEqual(['v']);
  });

  it('caps the list and counts the rest', () => {
    const pts = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, x: 100 + (i % 5) * 0.5, y: 100 + Math.floor(i / 5) * 0.5 }));
    const r = run([source(pts)], [], 12);
    expect(r.items).toHaveLength(12);
    expect(r.total).toBe(30);
    const quick = run([source(pts)], [], 12, never, false);
    expect(quick.items).toHaveLength(12);
    expect(quick.total).toBeLessThan(30);
  });

  it('prefers a propagated object over a cloud point on a near tie (bias)', () => {
    const cloud = source([{ id: 'cloud', x: 103, y: 100 }]);
    const dyn = source([{ id: 'dyn', x: 105, y: 100 }], 60);
    expect(run([cloud, dyn], []).items.map((h) => h.id)).toEqual(['dyn', 'cloud']);
    expect(run([cloud, source([{ id: 'dyn', x: 112, y: 100, size: 40 }], 60)], []).items[0].id).toBe('cloud');
  });

  it('de-duplicates an id found in two places and merges extras (model, selection ring)', () => {
    const a = source([{ id: 'iss', x: 104, y: 100 }]);
    const b = source([{ id: 'iss', x: 104, y: 100 }]);
    const r = run([a, b], [{ id: 'model', d2: 0 }, { id: 'sel', d2: 9, rel: [sx(100), sy(100), 0] }]);
    expect(r.items.map((h) => h.id)).toEqual(['model', 'sel', 'iss']);
    expect(r.total).toBe(3);
    // an extra with a position is occlusion-checked, one without is not
    const hidden = run([], [{ id: 'model', d2: 0 }, { id: 'sel', d2: 9, rel: [0, 0, 0] }], 12, () => true);
    expect(hidden.items.map((h) => h.id)).toEqual(['model']);
  });
});

describe('hierarchy rank', () => {
  it('lists a lower rank first even when a higher one is nearer the cursor; equal ranks keep the distance order', () => {
    const near = source([{ id: 'sat', x: 101, y: 100 }]);
    const r = run([near], [{ id: 'moon', d2: 81, rank: 2000 }, { id: 'earth', d2: 100, rank: 1000 }]);
    expect(r.items.map((h) => h.id)).toEqual(['earth', 'moon', 'sat']);
    // equal ranks: nearest first, as without ranks
    const eq = run([source([{ id: 'far', x: 107, y: 100 }, { id: 'near', x: 102, y: 100 }])], [{ id: 'a', d2: 30, rank: 5 }, { id: 'b', d2: 4, rank: 5 }]);
    expect(eq.items.map((h) => h.id)).toEqual(['b', 'a', 'near', 'far']);
  });

  it('takes ranks per point, per extra or from the id map; missing ranks last', () => {
    const s = source([{ id: 'p1', x: 101, y: 100 }, { id: 'p2', x: 102, y: 100 }, { id: 'p3', x: 103, y: 100 }]);
    s.rank = [1e6 + 3, 1e6 + 2]; // p3 has none per point: the id map supplies it
    const ranks = new Map([['p3', 1e6 + 1]]);
    const r = gatherCandidates([s], [{ id: 'x', d2: 0 }], M, W, H, 100, 100, { max: 12, occluded: never, ranks });
    // p3 from the map, p2 and p1 per point, the unranked extra last although it is dead centre
    expect(r.items.map((h) => h.id)).toEqual(['p3', 'p2', 'p1', 'x']);
  });

  it('builds the id map with the core entity rank (bodies first, then by the body they orbit)', () => {
    const recs = [
      { id: 'sat', bodyId: 'EARTH' }, { id: 'lro', bodyId: 'MOON' }, { id: 'probe', bodyId: 'SUN' },
      ...bodyEntityRecords(),
    ];
    const m = rankMap(recs);
    const order = [...m.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    expect(order).toEqual(['body-sun', 'body-earth', 'body-mars', 'body-moon', 'probe', 'sat', 'lro']);
    expect(m.get('body-moon')).toBe(entityRank(bodyEntityRecords().find((r) => r.id === 'body-moon')!));
  });
});

describe('recency among equal ranks', () => {
  const pts = [{ id: 'old', x: 101, y: 100 }, { id: 'new', x: 108, y: 100 }, { id: 'mid', x: 104, y: 100 }];
  const created = new Map([['old', 100], ['new', 300], ['mid', 200]]);
  const ranks = new Map([['old', 1e6 + 2], ['new', 1e6 + 2], ['mid', 1e6 + 2]]);
  const go = (extra: object) => gatherCandidates([source(pts)], [], M, W, H, 100, 100, { max: 12, occluded: never, ranks, ...extra }).items.map((h) => h.id);

  it('lists the most recently created first, although it is farther from the cursor', () => {
    expect(go({ created })).toEqual(['new', 'mid', 'old']);
  });

  it('rank still beats recency, and distance breaks a tie in both', () => {
    expect(go({ created, ranks: new Map([...ranks, ['old', 1e6 + 1]]) })).toEqual(['old', 'new', 'mid']);
    expect(go({ created: new Map([['old', 5], ['new', 5], ['mid', 5]]) })).toEqual(['old', 'mid', 'new']);
    expect(go({})).toEqual(['old', 'mid', 'new']); // no creation times: nearest first as before
  });

  it('an object without a creation time counts as the oldest', () => {
    expect(go({ created: new Map([['mid', 1]]) })).toEqual(['mid', 'old', 'new']);
  });

  it('nearestFirst ignores rank and recency (hover names the object under the pointer)', () => {
    expect(go({ created, nearestFirst: true })).toEqual(['old', 'mid', 'new']);
  });

  it('builds ranks and creation times from the records (updatedAt when there is no createdAt)', () => {
    const { ranks: r, created: c } = pickMeta([
      { id: 'a', bodyId: 'EARTH', createdAt: 10, updatedAt: 99 }, { id: 'b', bodyId: 'EARTH', updatedAt: 50 },
      ...bodyEntityRecords(),
    ]);
    expect(c.get('a')).toBe(10);
    expect(c.get('b')).toBe(50);
    expect(r.get('a')).toBe(r.get('b'));
    expect(r.get('body-earth')!).toBeLessThan(r.get('a')!);
  });
});

describe('gatherCandidates with discHidden (objects over a small far body)', () => {
  const near = source([{ id: 'plain', x: 102, y: 100 }, { id: 'exempt', x: 104, y: 100, show: SHOW_EXEMPT }, { id: 'out', x: 101, y: 100, show: 0 }]);
  const hiddenAll = (_x: number, _y: number, _z: number) => true;
  const ids = (discHidden?: (x: number, y: number, z: number) => boolean) =>
    gatherCandidates([near], [], M, W, H, 100, 100, { max: 12, occluded: never, wantTotal: true, discHidden }).items.map((h) => h.id);

  it('drops the plain points the predicate hides and keeps the exempt ones (show >= 1.5)', () => {
    expect(ids()).toEqual(['plain', 'exempt']);
    expect(ids(hiddenAll)).toEqual(['exempt']);
    expect(ids(() => false)).toEqual(['plain', 'exempt']);
  });

  it('asks the predicate with the camera-relative position, and never for an exempt point', () => {
    const asked: number[][] = [];
    ids((x, y, z) => (asked.push([x, y, z]), false));
    expect(asked).toHaveLength(1);
    expect(asked[0][0]).toBeCloseTo(sx(102), 6);
  });

  it('never drops an extra (a model, the selection): they are exempt by construction', () => {
    const r = gatherCandidates([], [{ id: 'sel', d2: 4, rel: [0, 0, 0] }], M, W, H, 100, 100, { max: 12, occluded: never, discHidden: hiddenAll });
    expect(r.items.map((h) => h.id)).toEqual(['sel']);
  });
});

describe('resolvePick (objects first, bodies where there is none)', () => {
  const hit = (id: string, discPx?: number): PickHit => (discPx === undefined ? { id, dist: 1 } : { id, dist: 1, discPx });
  const objs = (n: number) => ({ items: Array.from({ length: n }, (_, i) => hit(`o${i}`)), total: n });
  const earth = (disc: number) => ({ items: [hit('body-earth', disc)], total: 1 });

  it('any object wins: the bodies never join the objects, small disc or big', () => {
    for (const disc of [10, GROUP_DISC_PX, GROUP_DISC_PX + 0.5, 300, Infinity]) {
      expect(resolvePick(objs(2), earth(disc)).items.map((h) => h.id)).toEqual(['o0', 'o1']);
      expect(resolvePick(objs(1), earth(disc)).items.map((h) => h.id)).toEqual(['o0']);
    }
    expect(resolvePick(objs(2), null).items).toHaveLength(2);
    expect(resolvePick({ items: [hit('o0')], total: 5 }, earth(10)).total).toBe(5);
  });

  it('with no object under the cursor the bodies are the result: one body is selected directly', () => {
    const r = resolvePick(objs(0), earth(30));
    expect(r.items.map((h) => h.id)).toEqual(['body-earth']);
    expect(r).not.toHaveProperty('grouped');
    expect(resolvePick(objs(0), { items: [], total: 0 }).items).toEqual([]);
  });

  it('lists every body under the cursor, in the order given (an Earth disc with a Moon dot: the popup)', () => {
    const both = { items: [hit('body-earth', 30), hit('body-moon', 5)], total: 2 };
    const r = resolvePick(objs(0), both);
    expect(r.items.map((h) => h.id)).toEqual(['body-earth', 'body-moon']);
    expect(r.total).toBe(2);
  });
});

describe('body disc size', () => {
  it('is the silhouette radius without margin or floor, infinite inside the sphere', () => {
    const f = 600 / (2 * Math.tan(Math.PI / 6));
    expect(bodyDiscRadiusPx(6378.137, 1, 24_000, 60, 600)).toBeCloseTo((6378.137 / Math.sqrt(24_000 ** 2 - 6378.137 ** 2)) * f, 9);
    expect(bodyDiscRadiusPx(6378.137, 1, 5000, 60, 600)).toBe(Infinity);
    expect(bodyHitRadiusPx(6378.137, 1, 24_000, 60, 600)).toBeCloseTo(bodyDiscRadiusPx(6378.137, 1, 24_000, 60, 600) + 3, 9);
  });

  it('the Earth falls under the grouping threshold from about 13 Earth radii in a 60 degree, 600 px view', () => {
    // disc <= 40 px  <=>  dist >= ~83,000 km here (a taller viewport pushes it further out)
    expect(bodyDiscRadiusPx(6378.137, 1, 60_000, 60, 600)).toBeGreaterThan(GROUP_DISC_PX);
    expect(bodyDiscRadiusPx(6378.137, 1, 100_000, 60, 600)).toBeLessThan(GROUP_DISC_PX);
  });
});

describe('body picking', () => {
  // fov 60 degrees, viewport 600 px high: 520.8 px focal length
  const hit = (radiusKm: number, k: number, dist: number) => bodyHitRadiusPx(radiusKm, k, dist, 60, 600);

  it('has a pixel minimum for far or tiny bodies', () => {
    expect(hit(1737.4, 1, 384_400)).toBe(14); // the Moon from the Earth: 2.4 px + 3
    expect(bodyHitRadiusPx(1737.4, 1, 384_400, 60, 600, 20)).toBe(20);
  });

  it('grows with the angular size and is the disc radius plus 3 px', () => {
    const near = hit(1737.4, 1, 6000), nearer = hit(1737.4, 1, 3000);
    expect(nearer).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(14);
    // r / sqrt(d^2 - r^2) * focal + 3
    expect(hit(6378.137, 1, 24_000)).toBeCloseTo((6378.137 / Math.sqrt(24_000 ** 2 - 6378.137 ** 2)) * (600 / (2 * Math.tan(Math.PI / 6))) + 3, 9);
    // the displayed (shrunk) radius counts, not the true one
    expect(hit(695_700, 0.02, 3e6)).toBeLessThan(hit(695_700, 1, 3e6));
    // inside the sphere the disc covers the whole view
    expect(hit(1737.4, 1, 1000)).toBe(600);
  });

  it('builds a pick extra for a body from its camera-relative centre', () => {
    // identity matrix: ndc = (x, y), the screen centre is (100, 100) of 200 x 200
    const base = { id: 'body-moon', radiusKm: 1737.4, k: 1, fovDeg: 60, m: M, w: W, h: H, px: 100, py: 100, rank: 2000 };
    // on the disc's centre
    const centre = bodyPickExtra({ ...base, rel: [0, 0, 5000] })!;
    expect(centre).toMatchObject({ id: 'body-moon', d2: 0, rank: 2000 });
    expect(centre.discPx).toBeCloseTo(bodyDiscRadiusPx(1737.4, 1, 5000, 60, H), 9);
    // 10 px off, inside the 14 px floor
    const near = bodyPickExtra({ ...base, rel: [sx(110), 0, 1e6] })!;
    expect(near.d2).toBeCloseTo(100, 5);
    // 30 px off a far, small Moon: a miss
    expect(bodyPickExtra({ ...base, rel: [sx(130), 0, 1e6] })).toBeNull();
    // behind the camera (w = 1 with the identity matrix; make w negative with m[15] = -1)
    expect(bodyPickExtra({ ...base, m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1]), rel: [0, 0, 0] })).toBeNull();
    // occlusion check only when asked for
    expect(bodyPickExtra({ ...base, rel: [0, 0, 5000] })!.rel).toBeUndefined();
    expect(bodyPickExtra({ ...base, rel: [0, 0, 5000], checkOcclusion: true })!.rel).toEqual([0, 0, 5000]);
    // the Moon in front of the satellite in the popup order: ranks decide
    const extra = bodyPickExtra({ ...base, rel: [sx(102), 0, 5000] })!;
    const r = run([source([{ id: 'sat', x: 100, y: 100 }])], [extra]);
    expect(r.items.map((h) => h.id)).toEqual(['body-moon', 'sat']);
  });
});

describe('wheelSteps', () => {
  it('turns one mouse notch into one step and accumulates trackpad deltas', () => {
    expect(wheelSteps(0, 100)).toEqual({ acc: 0, steps: 1 });
    let acc = 0, total = 0;
    for (let i = 0; i < 10; i++) {
      const r = wheelSteps(acc, 20);
      acc = r.acc;
      total += r.steps;
    }
    expect(total).toBe(2); // 200 px = two steps
    expect(wheelSteps(0, -120).steps).toBeLessThan(0);
  });

  it('drops leftovers when the direction flips and scales line mode', () => {
    expect(wheelSteps(30, -10).steps).toBe(0);
    expect(wheelSteps(30, -10).acc).toBe(-10);
    expect(wheelSteps(0, 3, 1).steps).toBe(1); // 3 lines is one notch
  });
});

describe('moveIndex', () => {
  it('clamps at both ends', () => {
    expect(moveIndex(0, -1, 5)).toBe(0);
    expect(moveIndex(3, 5, 5)).toBe(4);
    expect(moveIndex(1, 2, 5)).toBe(3);
    expect(moveIndex(0, 1, 0)).toBe(0);
  });
});

describe('popupPlacement', () => {
  it('opens right and below the cursor, flips near the edges and stays inside', () => {
    expect(popupPlacement(100, 100, 200, 100, 800, 600)).toEqual({ left: 112, top: 112 });
    expect(popupPlacement(750, 100, 200, 100, 800, 600).left).toBe(538);
    expect(popupPlacement(100, 560, 200, 100, 800, 600).top).toBe(448);
    const p = popupPlacement(5, 5, 900, 700, 800, 600);
    expect(p.left).toBeGreaterThanOrEqual(4);
    expect(p.top).toBeGreaterThanOrEqual(4);
  });
});
