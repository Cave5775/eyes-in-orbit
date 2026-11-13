import { describe, expect, it } from 'vitest';
import { RateCounter, RollingWindow, percentileSorted } from '../src/lib/perf-stats';

describe('percentileSorted', () => {
  it('interpolates and handles edges', () => {
    expect(percentileSorted([], 50)).toBeNaN();
    expect(percentileSorted([7], 95)).toBe(7);
    expect(percentileSorted([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentileSorted([0, 10], 25)).toBe(2.5);
    expect(percentileSorted([1, 2, 3], 0)).toBe(1);
    expect(percentileSorted([1, 2, 3], 100)).toBe(3);
    expect(percentileSorted([1, 2, 3], 250)).toBe(3);
  });
});

describe('RollingWindow', () => {
  it('keeps only the last `size` samples', () => {
    const w = new RollingWindow(3);
    [100, 1, 2, 3].forEach((v) => w.push(v));
    expect(w.count).toBe(3);
    expect(w.max()).toBe(3);
    expect(w.percentile(50)).toBe(2);
    expect(w.mean()).toBe(2);
  });

  it('reports p50 and p95 of 1..100', () => {
    const w = new RollingWindow(200);
    for (let i = 100; i >= 1; i--) w.push(i);
    const s = w.summary();
    expect(s.n).toBe(100);
    expect(s.p50).toBeCloseTo(50.5, 5);
    expect(s.p95).toBeCloseTo(95.05, 5);
    expect(s.max).toBe(100);
  });

  it('is NaN when empty and after clear', () => {
    const w = new RollingWindow(4);
    expect(w.percentile(50)).toBeNaN();
    w.push(5);
    w.clear();
    expect(w.count).toBe(0);
    expect(w.summary().p95).toBeNaN();
  });
});

describe('RateCounter', () => {
  it('counts events in the last second', () => {
    const r = new RateCounter(1000);
    [0, 100, 200, 900].forEach((t) => r.hit(t));
    expect(r.perSecond(950)).toBe(4);
    expect(r.perSecond(1150)).toBe(2);
    expect(r.perSecond(5000)).toBe(0);
  });
});
