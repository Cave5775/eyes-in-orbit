import { describe, expect, it } from 'vitest';
import { BodyRegistry, STREAM_FADE_PERIOD_FRACTION, bodyPeriodSec, bodyStateInParent, setBodyStream, type Sample, type Vec3 } from '../src';

const T = Date.UTC(2026, 9, 29, 12);
const YEAR_MS = 365.25 * 86_400_000;
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const OFFSET_R: Vec3 = [3e5, -2e5, 1e5]; // km, a stand-in for the Horizons-minus-Kepler error
const OFFSET_V: Vec3 = [1e-3, 0, -1e-3]; // km/s

const orbiting = new BodyRegistry().all().filter((b) => b.parentId && b.orbit).map((b) => b.id);

/** A stream of the body's own Kepler orbit plus a constant offset, over a window of ±halfMs around T. */
function streamed(id: string): { reg: BodyRegistry; fresh: BodyRegistry; start: number; end: number; periodMs: number } {
  const fresh = new BodyRegistry(), reg = new BodyRegistry();
  const periodMs = bodyPeriodSec(fresh.get(id), fresh)! * 1000;
  const halfMs = Math.min(2 * YEAR_MS, periodMs * 0.02);
  const n = 41;
  const samples: Sample[] = Array.from({ length: n }, (_, k) => {
    const t = T - halfMs + (k * 2 * halfMs) / (n - 1);
    const s = bodyStateInParent(fresh.get(id), t, fresh)!;
    return [t, s.r[0] + OFFSET_R[0], s.r[1] + OFFSET_R[1], s.r[2] + OFFSET_R[2], s.v[0] + OFFSET_V[0], s.v[1] + OFFSET_V[1], s.v[2] + OFFSET_V[2]];
  });
  const parent = reg.get(id).parentId!;
  expect(setBodyStream(id, { frame: `${parent}:inertial`, samples }, reg)).toBe(true);
  return { reg, fresh, start: samples[0][0], end: samples[n - 1][0], periodMs };
}

describe('a streamed body continues smoothly past its sample window', () => {
  it.each(orbiting)('%s: position and velocity are continuous across both window edges', (id) => {
    const { reg, start, end } = streamed(id);
    const st = (t: number) => bodyStateInParent(reg.get(id), t, reg)!;
    for (const edge of [start, end]) {
      const a = st(edge - 1), b = st(edge + 1); // 1 ms either side
      const vmag = Math.hypot(...st(edge).v);
      expect(dist(a.r, b.r), `${id} position jump`).toBeLessThan(vmag * 0.002 + 1e-3 + 1); // 2 ms of travel plus < 1 km
      expect(dist(a.r, b.r), `${id} position jump`).toBeLessThan(vmag * 0.002 + 1);
      expect(dist(a.v, b.v), `${id} velocity jump`).toBeLessThan(1e-4 * Math.max(vmag, 1e-3) + 1e-6);
    }
  });

  it.each(orbiting)('%s: the correction fades to the plain Kepler orbit and does nothing inside the window', (id) => {
    const { reg, fresh, start, end, periodMs } = streamed(id);
    const st = (r: BodyRegistry, t: number) => bodyStateInParent(r.get(id), t, r)!;
    const fade = periodMs * STREAM_FADE_PERIOD_FRACTION;
    // at the edge the offset is the whole correction, at the end of the fade none is left
    expect(dist(st(reg, end + 1).r, st(fresh, end + 1).r)).toBeGreaterThan(0.99 * dist(OFFSET_R, [0, 0, 0]));
    for (const t of [end + fade, end + 2 * fade, start - fade, start - 3 * fade]) {
      expect(dist(st(reg, t).r, st(fresh, t).r), `${id} at ${(t - T) / YEAR_MS} y`).toBeLessThan(1e-6);
      expect(dist(st(reg, t).v, st(fresh, t).v)).toBeLessThan(1e-9);
    }
    // halfway through the fade: strictly between (smoothstep gives half the offset)
    const mid = dist(st(reg, end + fade / 2).r, st(fresh, end + fade / 2).r);
    expect(mid).toBeGreaterThan(0.4 * dist(OFFSET_R, [0, 0, 0]));
    expect(mid).toBeLessThan(0.6 * dist(OFFSET_R, [0, 0, 0]));
    // inside the window: the stream (Kepler + offset, to the Hermite error)
    const tIn = T + (end - start) / 7;
    expect(dist(st(reg, tIn).r, [0, 1, 2].map((k) => st(fresh, tIn).r[k] + OFFSET_R[k]))).toBeLessThan(1 + 1e-6 * Math.hypot(...st(fresh, tIn).r));
  });

  it('is C1: the velocity matches the derivative of the position through the fade', () => {
    const id = 'MARS';
    const { reg, end, periodMs } = streamed(id);
    const st = (t: number) => bodyStateInParent(reg.get(id), t, reg)!;
    for (const f of [0.01, 0.1, 0.5, 0.9]) {
      const t = end + f * periodMs * STREAM_FADE_PERIOD_FRACTION;
      const h = 1000; // ms
      const num = [0, 1, 2].map((k) => (st(t + h).r[k] - st(t - h).r[k]) / 2); // km per s
      expect(dist(num, st(t).v)).toBeLessThan(1e-4 * Math.hypot(...st(t).v) + 1e-6);
    }
  });

  it('leaves bodies without a stream and bodyPeriodSec unchanged', () => {
    const { reg, fresh } = streamed('JUPITER');
    for (const id of orbiting.filter((x) => x !== 'JUPITER')) {
      expect(bodyStateInParent(reg.get(id), T + 5 * YEAR_MS, reg)).toEqual(bodyStateInParent(fresh.get(id), T + 5 * YEAR_MS, fresh));
    }
    for (const id of orbiting) expect(bodyPeriodSec(reg.get(id), reg)).toBe(bodyPeriodSec(fresh.get(id), fresh));
  });
});
