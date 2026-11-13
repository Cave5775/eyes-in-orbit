import { describe, expect, it } from 'vitest';
import type { Sample } from '@eio/core';
import { listedParent } from '../src/lib/listed-parent';
import { categoryOf } from '../src/lib/browser-ui';

const T = Date.UTC(2026, 9, 22);
const rec = (samples: Sample[], frame = 'EARTH:inertial', bodyId = 'EARTH') => ({
  kind: 'probe', bodyId, provider: { type: 'sampled' as const, frame: frame as `${string}:inertial`, samples },
});

describe('listedParent memo', () => {
  it('hits for the same array and re-evaluates for a new one', () => {
    const s: Sample[] = [[T, 7000, 0, 0], [T + 1000, 7000, 0, 0]];
    const r = rec(s);
    expect(listedParent(r)).toBe('EARTH');
    expect(listedParent(r)).toBe('EARTH');
    expect(listedParent(rec([[T, 1.5e6, 0, 0], [T + 1000, 1.5e6, 0, 0]]))).toBe('SUN');
  });
  it('an in-place push that changes the window changes the result', () => {
    const s: Sample[] = [[T, 7000, 0, 0]];
    const r = rec(s);
    expect(listedParent(r)).toBe('EARTH');
    s.push([T + 1000, 1.5e6, 0, 0]);
    expect(listedParent(r)).toBe('SUN');
  });
  it('a different frame or bodyId re-evaluates', () => {
    const s: Sample[] = [[T, 3800, 0, 0]];
    expect(listedParent(rec(s, 'MARS:inertial', 'MARS'))).toBe('MARS');
    expect(listedParent(rec(s, 'EARTH:inertial', 'EARTH'))).toBe('EARTH');
  });
  it('a Sun-listed sampled probe is in the probes category', () => {
    expect(categoryOf({ ...rec([[T, 2.5e10, 0, 0]]) })).toBe('probes');
  });
});
