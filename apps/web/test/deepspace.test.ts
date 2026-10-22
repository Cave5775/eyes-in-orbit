import { describe, expect, it } from 'vitest';
import { norm, type Vec3 } from '@eio/core';
import { SHELL_THRESHOLD_KM, compressDeepSpace, shellRadius } from '../src/lib/deepspace';

describe('deep-space shell compression', () => {
  it('leaves near-Earth and cislunar positions untouched', () => {
    for (const r of [[7000, 0, 0], [0, -384_400, 0], [1_500_000, 0, 0], [SHELL_THRESHOLD_KM, 0, 0]] as Vec3[]) {
      const out = compressDeepSpace(r);
      expect(out.compressed).toBe(false);
      expect(out.r).toEqual(r);
    }
  });

  it('is continuous at the threshold and monotonic beyond it', () => {
    expect(shellRadius(SHELL_THRESHOLD_KM)).toBe(SHELL_THRESHOLD_KM);
    expect(shellRadius(SHELL_THRESHOLD_KM * 1.0001)).toBeCloseTo(SHELL_THRESHOLD_KM, -2);
    let prev = 0;
    for (const r of [1e6, 2e6, 3e6, 1e7, 1.5e8, 2.3e8, 2.5e10]) {
      const s = shellRadius(r);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });

  it('keeps direction and bounds the shell for the farthest probes', () => {
    const voyager: Vec3 = [-1.2e10, 1.9e10, 5e9];
    const out = compressDeepSpace(voyager);
    expect(out.compressed).toBe(true);
    const k = norm(out.r) / norm(voyager);
    out.r.forEach((c, i) => expect(c / k).toBeCloseTo(voyager[i], 0));
    expect(norm(out.r)).toBeGreaterThan(SHELL_THRESHOLD_KM);
    expect(norm(out.r)).toBeLessThan(SHELL_THRESHOLD_KM * 2.1);
  });

  it('log-scales: each decade adds a constant radius', () => {
    const d1 = shellRadius(2e8) - shellRadius(2e7);
    const d2 = shellRadius(2e9) - shellRadius(2e8);
    expect(d1).toBeCloseTo(d2, 3);
  });

  it('handles the zero vector', () => {
    expect(compressDeepSpace([0, 0, 0])).toEqual({ r: [0, 0, 0], compressed: false });
  });
});
