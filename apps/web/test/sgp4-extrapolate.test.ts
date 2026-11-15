import { describe, expect, it } from 'vitest';
import { MU_EARTH_WGS72, extrapolateStates } from '../src/lib/sgp4-extrapolate';

/** A circular orbit in the xy plane: exact position at time t (s). */
const R = 6771; // km, about the ISS
const W = Math.sqrt(MU_EARTH_WGS72 / R ** 3); // rad/s
const V = W * R;
const exact = (t: number) => [R * Math.cos(W * t), R * Math.sin(W * t), 0];
const state0 = [R, 0, 0, 0, V, 0];

const step = (states: number[], dt: number) => {
  const out = new Float64Array((states.length / 6) * 3);
  extrapolateStates(states, out, states.length / 6, dt);
  return [...out];
};
const err = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('extrapolateStates', () => {
  it('is the sample itself at dt = 0', () => {
    expect(step(state0, 0)).toEqual([R, 0, 0]);
  });
  it('keeps a missing state (zero position) at zero', () => {
    expect(step([0, 0, 0, 1, 2, 3, ...state0], 5)).toEqual([0, 0, 0, ...step(state0, 5)]);
  });
  it('stays on a circular LEO orbit within a centimetre over one tick at x1 and x600', () => {
    expect(err(step(state0, 0.033), exact(0.033))).toBeLessThan(1e-5); // km
    expect(err(step(state0, 0.033 * 600), exact(0.033 * 600))).toBeLessThan(0.02);
  });
  it('is far better than holding the sample (what was drawn before)', () => {
    const t = 0.033;
    expect(err(state0.slice(0, 3), exact(t))).toBeGreaterThan(0.2); // 250 m of drift in one tick
    expect(err(step(state0, -t), exact(-t))).toBeLessThan(1e-5); // backwards too
  });
});
