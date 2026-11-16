import { describe, expect, it } from 'vitest';
import { ZOOM_MAX, ZOOM_RESET, clampView, isZoomed, panBy, wheelZoomFactor, zoomAt } from '../src/lib/zoom-pan';

const W = 400;
const H = 225;
const shown = (v: { scale: number; x: number; y: number }, px: number, py: number) => [px * v.scale + v.x, py * v.scale + v.y];

describe('zoom about a point', () => {
  it('keeps the point under the cursor fixed', () => {
    const v = zoomAt(ZOOM_RESET, 2, 300, 100, W, H);
    expect(v.scale).toBe(2);
    // the picture point that was at (300,100) is still there
    const [sx, sy] = shown(v, 300, 100);
    expect(sx).toBeCloseTo(300);
    expect(sy).toBeCloseTo(100);
    // zooming again about another point keeps that one fixed too
    const p = [(250 - v.x) / v.scale, (80 - v.y) / v.scale];
    const v2 = zoomAt(v, 1.5, 250, 80, W, H);
    const [ax, ay] = shown(v2, p[0], p[1]);
    expect(ax).toBeCloseTo(250);
    expect(ay).toBeCloseTo(80);
  });
  it('clamps the scale to 1..8', () => {
    expect(zoomAt(ZOOM_RESET, 100, 10, 10, W, H).scale).toBe(ZOOM_MAX);
    expect(zoomAt(ZOOM_RESET, 0.1, 10, 10, W, H)).toEqual(ZOOM_RESET);
  });
  it('resets the pan when the scale returns to 1', () => {
    const v = zoomAt(ZOOM_RESET, 3, 390, 220, W, H);
    expect(v.x).not.toBe(0);
    const back = zoomAt(v, 0.01, 390, 220, W, H);
    expect(back).toEqual({ scale: 1, x: 0, y: 0 });
    expect(isZoomed(back)).toBe(false);
  });
  it('never shows empty edges, also zooming at the corners', () => {
    for (const [cx, cy] of [[0, 0], [W, H], [W, 0], [0, H]]) {
      const v = zoomAt(ZOOM_RESET, 4, cx, cy, W, H);
      expect(v.x).toBeLessThanOrEqual(0);
      expect(v.x).toBeGreaterThanOrEqual(W - W * v.scale);
      expect(v.y).toBeLessThanOrEqual(0);
      expect(v.y).toBeGreaterThanOrEqual(H - H * v.scale);
    }
  });
});

describe('pan and clamp', () => {
  it('pans within the covering range only', () => {
    const v = zoomAt(ZOOM_RESET, 2, 200, 112, W, H);
    expect(panBy(v, 1e6, 1e6, W, H)).toEqual({ scale: 2, x: 0, y: 0 });
    expect(panBy(v, -1e6, -1e6, W, H)).toEqual({ scale: 2, x: -W, y: -H });
  });
  it('does not pan at scale 1', () => {
    expect(panBy(ZOOM_RESET, 50, 50, W, H)).toEqual(ZOOM_RESET);
  });
  it('survives non-finite input', () => {
    expect(clampView({ scale: NaN, x: NaN, y: 3 }, W, H)).toEqual(ZOOM_RESET);
    expect(clampView({ scale: 2, x: NaN, y: NaN }, W, H)).toEqual({ scale: 2, x: 0, y: 0 });
  });
});

describe('wheel factor', () => {
  it('wheel up zooms in, down zooms out, bounded', () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(-1e9)).toBe(wheelZoomFactor(-300));
    expect(wheelZoomFactor(NaN)).toBe(1);
  });
});
