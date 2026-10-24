import { describe, expect, it } from 'vitest';
import {
  ATLAS, DETAIL_MAX_Z, TILE_PX, detailLevel, kmPerScreenPx, nextWindow, tileDeg, uOfLon, vOfLat, windowBox, windowFor, windowTiles,
  type DetailView,
} from '../src/lib/earth-detail';

const view = (groundDistKm: number, over: Partial<DetailView> = {}): DetailView => ({
  latDeg: 28.5, lonDeg: -80.6, groundDistKm, fovDeg: 45, viewportPx: 800, aspect: 1.2, ...over,
});

describe('detail level', () => {
  it('turns off when the base map is already as sharp as the screen needs', () => {
    expect(detailLevel(view(24000))).toBeNull();
    expect(detailLevel(view(8000))).toBeNull();
    expect(detailLevel(view(5000))).toBeNull();
  });

  it('starts around 2,600 km (where a level-4 footprint fits) and gets finer as the camera comes down, up to level 6', () => {
    expect(detailLevel(view(3500))).toBeNull(); // the footprint is wider than three level-4 tiles
    expect(detailLevel(view(2500))).toBe(4);
    expect(detailLevel(view(1200))).toBe(5);
    expect(detailLevel(view(600))).toBe(6);
    expect(detailLevel(view(150))).toBe(DETAIL_MAX_Z);
    expect(detailLevel(view(5))).toBe(DETAIL_MAX_Z);
  });

  it('never picks a level whose footprint is wider than three tiles', () => {
    for (const d of [1500, 2500, 3500, 6000]) {
      const z = detailLevel(view(d));
      if (z === null) continue;
      const halfKm = d * Math.tan((45 * Math.PI) / 360) * 1.2 * 1.25;
      const spanDeg = 2 * (halfKm / (111.195 * Math.cos((28.5 * Math.PI) / 180)));
      expect(spanDeg / tileDeg(z)).toBeLessThanOrEqual(3.01);
    }
  });

  it('is coarser near the poles, where a degree of longitude is short, and for a larger window', () => {
    const lv = (v: DetailView) => detailLevel(v) ?? 0; // 0: no detail layer
    expect(lv(view(2500, { latDeg: 80 }))).toBeLessThanOrEqual(lv(view(2500, { latDeg: 0 })));
    expect(lv(view(2500, { aspect: 2.4 }))).toBeLessThanOrEqual(lv(view(2500, { aspect: 1 })));
    expect(lv(view(1000, { latDeg: 80 }))).toBeLessThan(lv(view(1000, { latDeg: 0 })));
  });

  it('measures a screen pixel on the ground', () => {
    expect(kmPerScreenPx({ groundDistKm: 1000, fovDeg: 45, viewportPx: 800 })).toBeCloseTo((2 * 1000 * Math.tan((22.5 * Math.PI) / 180)) / 800, 9);
    expect(kmPerScreenPx({ groundDistKm: 1000, fovDeg: 45, viewportPx: 0 })).toBeGreaterThan(0); // no division by zero
  });
});

describe('tile window', () => {
  it('centres the window on the looked-at point and stays inside the grid', () => {
    const w = windowFor(6, 28.5, -80.6);
    const s = tileDeg(6);
    const cx = (w.tx + ATLAS / 2) * s - 180, cy = 90 - (w.ty + ATLAS / 2) * s;
    expect(Math.abs(cx - -80.6)).toBeLessThanOrEqual(s / 2 + 1e-9);
    expect(Math.abs(cy - 28.5)).toBeLessThanOrEqual(s / 2 + 1e-9);
    // corners of the world: clamped, never negative or past the last tile
    expect(windowFor(5, 89.9, -179.9)).toEqual({ z: 5, tx: 0, ty: 0 });
    expect(windowFor(5, -89.9, 179.9)).toEqual({ z: 5, tx: 2 ** 6 - ATLAS, ty: 2 ** 5 - ATLAS });
  });

  it('keeps the window while the point stays in its middle tiles, recentres when it leaves', () => {
    const w = windowFor(5, 28.5, -80.6);
    expect(nextWindow(w, 5, 28.5, -80.6)).toBe(w);
    const s = tileDeg(5);
    const centre = { lat: 90 - (w.ty + ATLAS / 2) * s, lon: -180 + (w.tx + ATLAS / 2) * s };
    expect(nextWindow(w, 5, centre.lat + 0.4 * s, centre.lon + 0.4 * s)).toBe(w); // small pan
    expect(nextWindow(w, 5, centre.lat, centre.lon + 0.7 * s)).not.toBe(w); // more than half a tile from the centre
    const far = nextWindow(w, 5, 28.5, -80.6 + 3 * s);
    expect(far).not.toBe(w);
    expect(far.tx).toBeGreaterThan(w.tx);
    // a different level always rebuilds
    expect(nextWindow(w, 6, 28.5, -80.6).z).toBe(6);
    expect(nextWindow(null, 4, 0, 0).z).toBe(4);
  });

  it('lists ATLAS x ATLAS tiles row by row with their atlas pixel offsets', () => {
    const tiles = windowTiles({ z: 5, tx: 10, ty: 3 });
    expect(tiles).toHaveLength(ATLAS * ATLAS);
    expect(tiles[0]).toEqual({ z: 5, x: 10, y: 3, px: 0, py: 0 });
    expect(tiles[1]).toEqual({ z: 5, x: 11, y: 3, px: TILE_PX, py: 0 });
    expect(tiles[ATLAS]).toEqual({ z: 5, x: 10, y: 4, px: 0, py: TILE_PX });
    expect(tiles[tiles.length - 1]).toEqual({ z: 5, x: 13, y: 6, px: 3 * TILE_PX, py: 3 * TILE_PX });
  });

  it('maps the window to the base map\'s texture coordinates, north at the top (v = 1)', () => {
    const w = { z: 4, tx: 0, ty: 0 };
    const [u0, v0, u1, v1] = windowBox(w);
    expect([u0, v1]).toEqual([0, 1]); // north-west corner of the world
    expect(u1).toBeCloseTo((ATLAS * tileDeg(4)) / 360, 12);
    expect(v1 - v0).toBeCloseTo((ATLAS * tileDeg(4)) / 180, 12);
    // the point the window was built around lies inside its box
    const win = windowFor(6, 28.5, -80.6);
    const [a, b, c, d] = windowBox(win);
    expect(uOfLon(-80.6)).toBeGreaterThan(a);
    expect(uOfLon(-80.6)).toBeLessThan(c);
    expect(vOfLat(28.5)).toBeGreaterThan(b);
    expect(vOfLat(28.5)).toBeLessThan(d);
  });
});
