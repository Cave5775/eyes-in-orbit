import { describe, expect, it } from 'vitest';
import { fixedToInertial, spinOf, toCameraRelative } from '../src/lib/floating';

describe('floating origin', () => {
  it('keeps sub-millimetre accuracy for points metres from a camera 6,400 km from the origin', () => {
    const origin: [number, number, number] = [6378.137123456, 1234.5678912, -2345.6789123];
    const world = new Float64Array([origin[0] + 0.0123, origin[1] - 0.0042, origin[2] + 0.2001]);
    const out = new Float32Array(3);
    toCameraRelative(world, out, 1, origin, spinOf(0), false);
    expect(out[0]).toBeCloseTo(0.0123, 6);
    expect(out[1]).toBeCloseTo(-0.0042, 6);
    expect(out[2]).toBeCloseTo(0.2001, 6);
  });

  it('beats the naive path (float32 world positions, subtracted on the GPU), which is metres-class off at this radius', () => {
    const origin: [number, number, number] = [6378.137123456, 0, 0];
    let worstNaive = 0, worstRebased = 0;
    for (let i = 0; i < 200; i++) {
      const d = 0.0005 * i + 0.00013; // 0.13 m .. 100 m offsets
      const world = new Float64Array([origin[0] + d, 0, 0]);
      const out = new Float32Array(3);
      toCameraRelative(world, out, 1, origin, spinOf(0), false);
      worstRebased = Math.max(worstRebased, Math.abs(out[0] - d));
      worstNaive = Math.max(worstNaive, Math.abs(Math.fround(world[0]) - Math.fround(origin[0]) - d));
    }
    expect(worstNaive).toBeGreaterThan(1.5e-4); // ~half an ulp of 6,378 km = 0.24 m
    expect(worstRebased).toBeLessThan(1e-8 * 100);
  });

  it('rotates Earth-fixed points into the inertial frame before subtracting', () => {
    const spin = spinOf(Math.PI / 2);
    const out = new Float32Array(3);
    toCameraRelative([6378, 0, 5], out, 1, [0, 6378, 0], spin, true);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(0, 3);
    expect(out[2]).toBeCloseTo(5, 6);
    expect(fixedToInertial([1, 0, 2], spin)[1]).toBeCloseTo(1, 12);
  });

  it('only fills the requested count', () => {
    const out = new Float32Array(9).fill(-1);
    toCameraRelative([1, 2, 3, 4, 5, 6, 7, 8, 9], out, 2, [1, 1, 1], spinOf(0), false);
    expect(Array.from(out)).toEqual([0, 1, 2, 3, 4, 5, -1, -1, -1]);
  });
});
