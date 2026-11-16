import { describe, expect, it } from 'vitest';
import { AMBIENT_I, EARTHSHINE_I, FLAT_AMBIENT_I, SUN_I, lightRig } from '../src/lib/shading';

describe('lightRig', () => {
  it('shaded: Sun scaled by the sunlit fraction, earthshine by the day weight, dim ambient', () => {
    expect(lightRig(true, 1, 0.5)).toEqual({ sun: SUN_I, earth: EARTHSHINE_I * 0.5, ambient: AMBIENT_I });
  });
  it('shaded: umbra turns the Sun off', () => {
    expect(lightRig(true, 0, 0).sun).toBe(0);
  });
  it('unshaded: even ambient only, whatever the eclipse state', () => {
    for (const [s, d] of [[1, 1], [0, 0], [0.4, 0.2]]) expect(lightRig(false, s, d)).toEqual({ sun: 0, earth: 0, ambient: FLAT_AMBIENT_I });
    expect(FLAT_AMBIENT_I).toBeGreaterThan(AMBIENT_I);
  });
});
