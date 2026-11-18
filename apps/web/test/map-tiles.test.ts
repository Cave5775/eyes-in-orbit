import { describe, expect, it } from 'vitest';
import { defaultBodies, layerHasTile, lonLatOfTms, tileBounds, tmsOf } from '@eio/core';
import {
  MAX_TILES, TILE_TARGET_PX, ancestors, evictions, fixedOf, lonLatAlt, missionUnder, patchOpacity, requestsFor, selectTiles, standIn, texKey, tileGrid,
  tileScreenPx, uvRect, type PatchView,
} from '../src/lib/map-tiles';
import type { V3 } from '../src/lib/camera';

const R = defaultBodies.get('MARS').radiusKm;
// Perseverance's sol-2022 waypoint and Curiosity's sol-5073 one (trimmed real MMGIS localizations, mock fixture)
const M20: [number, number] = [77.233223, 18.435594];
const MSL: [number, number] = [137.388886, -4.826023];

const norm = (v: V3): V3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** A camera `distKm` from the ground point, `elDeg` over its horizon toward the east, looking at it (like the Close-up). */
function viewAt([lon, lat]: [number, number], distKm: number, elDeg = 45): PatchView {
  const p = fixedOf(lon, lat, R);
  const up = norm(p);
  const l = (lon * Math.PI) / 180;
  const east: V3 = [-Math.sin(l), Math.cos(l), 0];
  const c = Math.cos((elDeg * Math.PI) / 180), s = Math.sin((elDeg * Math.PI) / 180);
  const cam: V3 = [p[0] + distKm * (c * east[0] + s * up[0]), p[1] + distKm * (c * east[1] + s * up[1]), p[2] + distKm * (c * east[2] + s * up[2])];
  return { cam, dir: norm([p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]]), fovDeg: 45, aspect: 1.5, viewportPx: 600, radiusKm: R };
}

const contains = (z: number, x: number, y: number, [lon, lat]: [number, number]) => {
  const t = tmsOf(lon, lat, z);
  return Math.floor(t.x) === x && Math.floor(t.y) === y;
};

describe('placement on the sphere and when the patch shows', () => {
  it('body-fixed points and longitude / latitude / height round-trip', () => {
    const p = fixedOf(M20[0], M20[1], R + 2);
    const g = lonLatAlt(p, R);
    expect(g.lonDeg).toBeCloseTo(M20[0], 10);
    expect(g.latDeg).toBeCloseTo(M20[1], 10);
    expect(g.altKm).toBeCloseTo(2, 9);
  });

  it('fades in from 600 km down to 250 km', () => {
    expect(patchOpacity(700)).toBe(0);
    expect(patchOpacity(600)).toBe(0);
    expect(patchOpacity(250)).toBe(1);
    expect(patchOpacity(3)).toBe(1);
    expect(patchOpacity(425)).toBeCloseTo(0.5, 6);
    expect(patchOpacity(300)).toBeGreaterThan(patchOpacity(400));
  });

  it('is on over Jezero and Gale below 600 km, off elsewhere and higher up', () => {
    expect(missionUnder(M20[0], M20[1], 3, R)).toBe('M20');
    expect(missionUnder(MSL[0], MSL[1], 30, R)).toBe('MSL');
    expect(missionUnder(M20[0], M20[1], 700, R)).toBeNull();
    expect(missionUnder(0, 0, 3, R)).toBeNull();
    // just outside the context layer, high enough to see it over the horizon
    expect(missionUnder(66, 20, 300, R)).toBe('M20');
    expect(missionUnder(66, 20, 1, R)).toBeNull();
  });
});

describe('tile selection (quadtree by screen size)', () => {
  it('Close-up of Perseverance (4 km): within the budget, fine colour tiles under the rover, nothing too large or out of view', () => {
    const v = viewAt(M20, 4);
    const draws = selectTiles('M20', v);
    const leaves = new Set(draws.map((d) => `${d.z}/${d.x}/${d.y}`));
    expect(leaves.size).toBeLessThanOrEqual(MAX_TILES);
    expect(leaves.size).toBeGreaterThan(8);
    const under = draws.filter((d) => contains(d.z, d.x, d.y, M20));
    expect(under.length).toBeGreaterThan(0);
    const top = under[under.length - 1];
    expect(top.layer.id).toBe('color');
    expect(top.z).toBeGreaterThanOrEqual(13);
    expect(top.z).toBeLessThanOrEqual(19);
    // largest first; every texture is a tile its layer publishes
    for (let i = 1; i < draws.length; i++) expect(draws[i].px).toBeLessThanOrEqual(draws[i - 1].px);
    for (const d of draws) expect(layerHasTile(d.layer, d.tz, d.tx, d.ty), d.key).toBe(true);
    // no leaf that could still be split is drawn much larger than the target (the budget may stop the farthest)
    expect(Math.max(...draws.filter((d) => d.z < 19).map((d) => d.px))).toBeLessThan(TILE_TARGET_PX * 2.5);
    // nothing behind the camera
    for (const d of draws) expect(tileScreenPx(d.z, d.x, d.y, v)).toBeGreaterThan(0);
    // unique keys: one mesh per draw
    expect(new Set(draws.map((d) => d.key)).size).toBe(draws.length);
  });

  it('the whole traverse from 30 km: the first and the latest waypoint are both under drawn tiles', () => {
    const v = viewAt([77.34, 18.44], 30, 60);
    const draws = selectTiles('M20', v);
    expect(draws.some((d) => contains(d.z, d.x, d.y, [77.450886, 18.444627]))).toBe(true);
    expect(draws.some((d) => contains(d.z, d.x, d.y, M20))).toBe(true);
  });

  it('outside the colour mosaic the context layer is the base, and a partly covered leaf stacks the sharper layer on top', () => {
    const draws = selectTiles('M20', viewAt([77.5, 18.5], 60, 50));
    const byLeaf = new Map<string, typeof draws>();
    for (const d of draws) byLeaf.set(`${d.z}/${d.x}/${d.y}`, [...(byLeaf.get(`${d.z}/${d.x}/${d.y}`) ?? []), d]);
    const stacked = [...byLeaf.values()].filter((s) => s.length > 1);
    expect(stacked.length).toBeGreaterThan(0);
    for (const s of stacked) {
      expect(s.map((d) => d.stack)).toEqual(s.map((_, i) => i));
      expect(s[0].layer.id).toBe('syrtis'); // the bottom covers the whole leaf
    }
    // a leaf finer than the context layer's last level (12) shows part of a level-12 tile
    const deep = draws.find((d) => d.layer.id === 'syrtis' && d.z > 12);
    if (deep) expect(deep.tz).toBe(12);
  });

  it('Curiosity uses the Gale layers', () => {
    const draws = selectTiles('MSL', viewAt(MSL, 4));
    expect(draws.length).toBeGreaterThan(0);
    expect(new Set(draws.map((d) => d.layer.mission))).toEqual(new Set(['MSL']));
    expect(draws.filter((d) => contains(d.z, d.x, d.y, MSL)).at(-1)!.layer.id).toBe('color');
  });

  it('culls tiles beyond the horizon and behind the camera; an unknown mission draws nothing', () => {
    // 2 km up, looking at the horizon to the west: the tiles 200 km east are behind the camera and past the horizon
    const v = viewAt(M20, 3, 5);
    const far = tmsOf(M20[0] + 4, M20[1], 9);
    expect(tileScreenPx(9, Math.floor(far.x), Math.floor(far.y), { ...v, dir: [-v.dir[0], -v.dir[1], -v.dir[2]] })).toBe(-1);
    const b = lonLatOfTms(Math.floor(far.x) + 0.5, Math.floor(far.y) + 0.5, 9);
    expect(b.lonDeg).toBeGreaterThan(M20[0] + 3);
    expect(selectTiles('XYZ', v)).toEqual([]);
  });
});

describe('textures and grids', () => {
  it('uv rectangle of a leaf in its own texture and in an ancestor', () => {
    expect(uvRect(14, 100, 200, 14, 100, 200)).toEqual([0, 0, 1]);
    expect(uvRect(13, 5, 7, 12, 2, 3)).toEqual([0.5, 0.5, 0.5]);
    expect(uvRect(14, 8, 12, 12, 2, 3)).toEqual([0, 0, 0.25]);
    expect(uvRect(14, 11, 15, 12, 2, 3)).toEqual([0.75, 0.75, 0.25]);
  });

  it('stand-ins: the coarser tiles of the same layer down to its first level', () => {
    const color = selectTiles('M20', viewAt(M20, 4)).find((d) => d.layer.id === 'color')!;
    const list = [...ancestors(color.layer, 12, 2926, 2261)];
    expect(list).toEqual([[11, 1463, 1130], [10, 731, 565]]);
  });

  it('a tile grid lies on the sphere, corners on the tile bounds, faces outward, positions relative to the centre', () => {
    const z = 11, x = 1463, y = 1130, n = 16;
    const g = tileGrid(z, x, y, R, n);
    const m = n + 1;
    expect(g.position.length).toBe(m * m * 3);
    expect(g.index.length).toBe(n * n * 6);
    expect(Math.hypot(...g.centre)).toBeCloseTo(R, 9);
    const at = (k: number): V3 => [g.position[k * 3] + g.centre[0], g.position[k * 3 + 1] + g.centre[1], g.position[k * 3 + 2] + g.centre[2]];
    for (let k = 0; k < m * m; k++) expect(Math.abs(Math.hypot(...at(k)) - R)).toBeLessThan(1e-3); // float32 offsets: < 1 m
    const [w, s, e, nn] = tileBounds(z, x, y);
    const sw = lonLatAlt(at(0), R), ne = lonLatAlt(at(m * m - 1), R);
    expect(sw.lonDeg).toBeCloseTo(w, 5);
    expect(sw.latDeg).toBeCloseTo(s, 5);
    expect(ne.lonDeg).toBeCloseTo(e, 5);
    expect(ne.latDeg).toBeCloseTo(nn, 5);
    expect([g.uv[0], g.uv[1], g.uv[(m * m - 1) * 2], g.uv[(m * m - 1) * 2 + 1]]).toEqual([0, 0, 1, 1]);
    // first triangle: (b - a) x (d - a) points away from the centre of Mars
    const [a, b, d] = [g.index[0], g.index[1], g.index[2]].map(at);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const cross = [u[1] * w2[2] - u[2] * w2[1], u[2] * w2[0] - u[0] * w2[2], u[0] * w2[1] - u[1] * w2[0]];
    expect(cross[0] * a[0] + cross[1] * a[1] + cross[2] * a[2]).toBeGreaterThan(0);
    expect(Math.hypot(g.normal[0], g.normal[1], g.normal[2])).toBeCloseTo(1, 6);
  });

  it('evicts the least recently used textures that are not in use, and starts at most 6 downloads', () => {
    const e = new Map([['a', { used: 1 }], ['b', { used: 5 }], ['c', { used: 2 }], ['d', { used: 9 }]]);
    expect(evictions(e, new Set(['a']), 2)).toEqual(['c', 'b']);
    expect(evictions(e, new Set(), 4)).toEqual([]);
    const wanted = ['k1', 'k2', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'];
    expect(requestsFor(wanted, (k) => k === 'k1', 0)).toEqual(['k2', 'k3', 'k4', 'k5', 'k6', 'k7']);
    expect(requestsFor(wanted, () => false, 5)).toEqual(['k1']);
    expect(requestsFor(wanted, () => false, 6)).toEqual([]);
    expect(texKey({ mission: 'M20', id: 'color' }, 11, 1463, 1130)).toBe('M20/color/11/1463/1130');
  });
});

describe('stand-ins while a tile loads', () => {
  const color = { mission: 'M20' as const, id: 'color', name: '', dir: '', minZoom: 10, maxNativeZoom: 19, bbox: [0, 0, 0, 0] as const, credit: '' };
  const d = { layer: color, tz: 14, tx: 11706, ty: 9045 };
  it('asks for the ancestor three levels up, or the nearest one that has not failed, and nothing once one is ready', () => {
    const st = (m: Record<string, 'ready' | 'loading' | 'failed'>) => (k: string) => m[k];
    expect(standIn(d, st({}))).toBe('M20/color/11/1463/1130');
    expect(standIn(d, st({ 'M20/color/14/11706/9045': 'failed' }))).toBe('M20/color/13/5853/4522');
    expect(standIn(d, st({ 'M20/color/14/11706/9045': 'failed', 'M20/color/13/5853/4522': 'failed', 'M20/color/12/2926/2261': 'failed' }))).toBe('M20/color/11/1463/1130');
    expect(standIn(d, st({ 'M20/color/12/2926/2261': 'ready' }))).toBeNull();
    expect(standIn(d, st({ 'M20/color/14/11706/9045': 'ready' }))).toBeNull();
    expect(standIn({ ...d, tz: 10, tx: 731, ty: 565 }, st({}))).toBeNull(); // the layer's first level has no ancestor
  });
});

describe('mock mode', () => {
  it('serves the three real fixture tiles under Perseverance and nothing else', async () => {
    const { createMockApi } = await import('../src/mock/mock-api');
    const api = createMockApi(Date.UTC(2026, 10, 17), 10);
    const color = { mission: 'M20' as const, id: 'color' };
    expect(api.mapTile(color, 11, 1463, 1130)).toMatch(/m20-color-11-1463-1130\.png/);
    expect(api.mapTile(color, 11, 1464, 1130)).toMatch(/m20-color-11-1464-1130\.png/);
    expect(api.mapTile(color, 10, 731, 565)).toMatch(/m20-color-10-731-565\.png/);
    expect(api.mapTile(color, 12, 2926, 2261)).toBeNull();
    expect(api.mapTile({ mission: 'MSL', id: 'color' }, 11, 1463, 1130)).toBeNull();
    // the mock's Close-up of Perseverance selects exactly these tiles at level 11 when the view asks for that level
    const draws = selectTiles('M20', viewAt([77.34, 18.44], 30, 60));
    expect(draws.some((d) => d.layer.id === 'color' && d.tz === 11 && d.tx === 1463 && d.ty === 1130)).toBe(true);
  });
});
