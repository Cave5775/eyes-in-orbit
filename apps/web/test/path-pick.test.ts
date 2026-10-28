import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PATH_HIT_PX, nearestOnPath } from '../src/lib/path-pick';

// Identity projection-view: ndc = (x, y), w = 1, viewport 200 x 200: screen x = 100 + 100 x, screen y = 100 - 100 y.
const I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const W = 200, H = 200;

/** A real perspective camera at the origin looking down -z: the same matrix the scene passes (projection * view). */
function perspective(): { m: ArrayLike<number>; project: (x: number, y: number, z: number) => [number, number] } {
  const cam = new THREE.PerspectiveCamera(60, W / H, 0.1, 1e6);
  cam.updateMatrixWorld(true);
  const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
  return {
    m,
    project: (x, y, z) => {
      const p = new THREE.Vector3(x, y, z).project(cam);
      return [(p.x * 0.5 + 0.5) * W, (1 - (p.y * 0.5 + 0.5)) * H];
    },
  };
}

describe('nearestOnPath', () => {
  const flat = { rel: [-0.5, 0, 0, 0.5, 0, 0], times: [1000, 2000], count: 2 };

  it('finds the time at the nearest point of a segment, interpolated', () => {
    const hit = nearestOnPath({ ...flat, m: I, w: W, h: H, px: 100, py: 103 })!;
    expect(hit.tMs).toBeCloseTo(1500, 6);
    expect(hit.distPx).toBeCloseTo(3, 6);
    expect(hit.index).toBe(0);
    expect(hit.sx).toBeCloseTo(100, 6);
    expect(hit.sy).toBeCloseTo(100, 6);
    expect(nearestOnPath({ ...flat, m: I, w: W, h: H, px: 75, py: 100 })!.tMs).toBeCloseTo(1250, 6);
  });

  it('respects the threshold (default about 8 px) and clamps to the ends of the line', () => {
    expect(PATH_HIT_PX).toBe(8);
    expect(nearestOnPath({ ...flat, m: I, w: W, h: H, px: 100, py: 109 })).toBeNull();
    expect(nearestOnPath({ ...flat, m: I, w: W, h: H, px: 100, py: 107 })).not.toBeNull();
    expect(nearestOnPath({ ...flat, m: I, w: W, h: H, px: 100, py: 109, thresholdPx: 12 })).not.toBeNull();
    // 4 px beyond the end: the end point's time, not an extrapolation
    const end = nearestOnPath({ ...flat, m: I, w: W, h: H, px: 154, py: 100 })!;
    expect(end.tMs).toBe(2000);
    expect(end.distPx).toBeCloseTo(4, 6);
    expect(nearestOnPath({ ...flat, m: I, w: W, h: H, px: 170, py: 100 })).toBeNull();
  });

  it('takes the nearest of several segments, with uneven sample times', () => {
    // an L: (-.5,0) -> (0,0) takes 1 s, (0,0) -> (0,-.5) takes 9 s
    const rel = [-0.5, 0, 0, 0, 0, 0, 0, -0.5, 0];
    const times = [0, 1000, 10000];
    const input = { rel, times, count: 3, m: I, w: W, h: H };
    const a = nearestOnPath({ ...input, px: 75, py: 98 })!;
    expect(a.index).toBe(0);
    expect(a.tMs).toBeCloseTo(500, 6);
    const b = nearestOnPath({ ...input, px: 102, py: 125 })!;
    expect(b.index).toBe(1);
    expect(b.tMs).toBeCloseTo(1000 + 9000 * 0.5, 6);
  });

  it('gives the right time on a foreshortened segment (perspective-correct, not linear on screen)', () => {
    const { m, project } = perspective();
    const a = [0.3, 0, -1], b = [0.3, 0, -9];
    const rel = [...a, ...b];
    for (const s of [0.05, 0.25, 0.5, 0.9]) {
      const p = project(a[0] + (b[0] - a[0]) * s, 0, a[2] + (b[2] - a[2]) * s);
      const hit = nearestOnPath({ rel, times: [0, 8000], count: 2, m, w: W, h: H, px: p[0], py: p[1] })!;
      expect(hit.tMs).toBeCloseTo(8000 * s, 3);
      expect(hit.distPx).toBeLessThan(1e-6);
    }
  });

  it('clips a segment that runs behind the camera and skips one that is wholly behind it', () => {
    const { m, project } = perspective();
    // from 5 in front to 5 behind: the visible part is the first half
    const rel = [0.2, 0, -5, 0.2, 0, 5];
    const p = project(0.2, 0, -2); // s = 0.3
    const hit = nearestOnPath({ rel, times: [0, 10000], count: 2, m, w: W, h: H, px: p[0], py: p[1] })!;
    expect(hit.tMs).toBeCloseTo(3000, 3);
    expect(nearestOnPath({ rel: [0.2, 0, 2, 0.2, 0, 8], times: [0, 1], count: 2, m, w: W, h: H, px: 100, py: 100, thresholdPx: 1e9 })).toBeNull();
  });

  it('drops a hit that is hidden behind a body and falls back to another part of the line', () => {
    const rel = [-0.5, 0, 0, 0, 0, 0, 0.5, 0, 0];
    const times = [0, 1000, 2000];
    // the cursor is nearer the second segment, but it is occluded
    const hit = nearestOnPath({ rel, times, count: 3, m: I, w: W, h: H, px: 120, py: 100, thresholdPx: 30, occluded: (x) => x > 0.01 })!;
    expect(hit.index).toBe(0);
    expect(hit.tMs).toBeCloseTo(1000, 6);
    expect(nearestOnPath({ rel, times, count: 3, m: I, w: W, h: H, px: 120, py: 100, occluded: () => true })).toBeNull();
  });

  it('handles degenerate input', () => {
    expect(nearestOnPath({ rel: [0, 0, 0], times: [0], count: 1, m: I, w: W, h: H, px: 100, py: 100 })).toBeNull();
    // a zero-length segment is a point
    const dot = nearestOnPath({ rel: [0, 0, 0, 0, 0, 0], times: [5, 9], count: 2, m: I, w: W, h: H, px: 103, py: 100 })!;
    expect(dot.tMs).toBe(5);
    // only `count` points are read: the stale tail of the buffer is ignored
    expect(nearestOnPath({ rel: [-0.5, 0, 0, 0.5, 0, 0, 0, 0.9, 0], times: [0, 1, 2], count: 2, m: I, w: W, h: H, px: 100, py: 10 })).toBeNull();
  });
});
