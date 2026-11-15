import { describe, expect, it } from 'vitest';
import { BodyRegistry, bodyStateInParent, isBodyStreamed, setBodyStream, type Sample } from '../src';

const T = Date.UTC(2026, 9, 29, 12);
const HOUR = 3_600_000;

describe('isBodyStreamed', () => {
  it('is false for every body of a fresh registry, including the moons whose offline phase is arbitrary', () => {
    const reg = new BodyRegistry();
    for (const b of reg.all()) expect(isBodyStreamed(b.id, T, reg)).toBe(false);
  });

  it('is true only inside the sample window of an installed stream, and false again once it is removed', () => {
    const reg = new BodyRegistry();
    const io = reg.get('IO');
    const samples: Sample[] = [-2, -1, 0, 1, 2].map((k) => {
      const t = T + k * HOUR;
      const s = bodyStateInParent(io, t, reg)!;
      return [t, ...s.r, ...s.v];
    });
    expect(setBodyStream('IO', { frame: 'JUPITER:inertial', samples }, reg)).toBe(true);
    expect(isBodyStreamed('IO', T, reg)).toBe(true);
    expect(isBodyStreamed('IO', T - 2 * HOUR, reg)).toBe(true); // the window edges belong to it
    expect(isBodyStreamed('IO', T + 2 * HOUR, reg)).toBe(true);
    expect(isBodyStreamed('IO', T + 2 * HOUR + 1, reg)).toBe(false); // past the end the shifted fallback runs
    expect(isBodyStreamed('IO', T - 2 * HOUR - 1, reg)).toBe(false);
    expect(isBodyStreamed('EUROPA', T, reg)).toBe(false); // another moon of the same planet is not
    setBodyStream('IO', undefined, reg);
    expect(isBodyStreamed('IO', T, reg)).toBe(false);
  });
});
