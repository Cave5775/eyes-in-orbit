import { describe, expect, it, vi } from 'vitest';
import { Clock, type ClockSnapshot } from '../src';

function make(start = 1_000_000) {
  const t = { wall: start };
  const c = new Clock(() => t.wall);
  return { t, c };
}

describe('clock modes', () => {
  it('starts live at rate 1 and follows the wall clock', () => {
    const { t, c } = make();
    expect(c.snapshot()).toEqual({ mode: 'live', nowMs: 1_000_000, rate: 1 });
    t.wall += 2500;
    expect(c.now()).toBe(1_002_500);
  });

  it('seek with a non-zero rate scrubs, rate 0 pauses', () => {
    const { t, c } = make();
    c.seek(50_000, 10);
    expect(c.snapshot().mode).toBe('scrubbed');
    t.wall += 1000;
    expect(c.now()).toBe(60_000);
    c.seek(70_000, 0);
    expect(c.snapshot()).toEqual({ mode: 'paused', nowMs: 70_000, rate: 0 });
    t.wall += 9999;
    expect(c.now()).toBe(70_000);
  });

  it('seek without a rate keeps the current one (including its sign)', () => {
    const { t, c } = make();
    c.seek(500_000, -60);
    c.seek(400_000);
    expect(c.snapshot().rate).toBe(-60);
    t.wall += 1000;
    expect(c.now()).toBe(400_000 - 60_000);
  });

  it('pause freezes at the current sim time and remembers the rate', () => {
    const { t, c } = make();
    c.seek(0, 60);
    t.wall += 1000;
    c.pause();
    expect(c.snapshot()).toEqual({ mode: 'paused', nowMs: 60_000, rate: 60 });
    t.wall += 5000;
    expect(c.now()).toBe(60_000);
  });

  it('goLive returns to wall time at rate 1, even after a negative rate', () => {
    const { t, c } = make();
    c.seek(0, -600);
    t.wall += 100;
    c.goLive();
    expect(c.snapshot()).toEqual({ mode: 'live', nowMs: t.wall, rate: 1 });
  });
});

describe('clock rates', () => {
  it('runs backwards at a negative rate, with no clamp', () => {
    const { t, c } = make();
    c.seek(1_000_000, -10);
    t.wall += 1000;
    expect(c.now()).toBe(990_000);
    t.wall += 200_000;
    expect(c.now()).toBe(1_000_000 - 2_010_000);
    expect(c.now()).toBeLessThan(0);
  });

  it('setRate changes speed from the current sim time without a jump', () => {
    const { t, c } = make();
    c.seek(10_000, 10);
    t.wall += 1000;
    expect(c.now()).toBe(20_000);
    c.setRate(60);
    expect(c.now()).toBe(20_000);
    t.wall += 1000;
    expect(c.now()).toBe(80_000);
  });

  it('setRate to the negative of the rate reverses direction from where it is', () => {
    const { t, c } = make();
    c.seek(0, 60);
    t.wall += 1000;
    c.setRate(-60);
    expect(c.now()).toBe(60_000);
    t.wall += 1000;
    expect(c.now()).toBe(0);
    expect(c.snapshot().rate).toBe(-60);
  });

  it('setRate from live leaves live at the wall time; setRate(0) pauses', () => {
    const { t, c } = make();
    t.wall += 3000;
    c.setRate(-10);
    expect(c.snapshot().mode).toBe('scrubbed');
    expect(c.now()).toBe(t.wall);
    t.wall += 1000;
    expect(c.now()).toBe(t.wall - 11_000);
    c.setRate(0);
    expect(c.snapshot().mode).toBe('paused');
    const frozen = c.now();
    t.wall += 8000;
    expect(c.now()).toBe(frozen);
  });

  it('a seek to wall-now plus an offset at rate r keeps the offset moving by (r - 1) per second', () => {
    const { t, c } = make();
    const offset = 3 * 86_400_000 + 5000;
    c.seek(t.wall + offset, 60);
    t.wall += 1000;
    expect(c.now() - t.wall).toBe(offset + 59_000);
    c.setRate(-60);
    t.wall += 1000;
    expect(c.now() - t.wall).toBe(offset + 59_000 - 61_000);
  });
});

describe('clock subscribe / snapshot', () => {
  it('emits a snapshot on every transition and stops after unsubscribe', () => {
    const { c } = make();
    const fn = vi.fn<(s: ClockSnapshot) => void>();
    const off = c.subscribe(fn);
    c.seek(5000, -2);
    c.setRate(3);
    c.pause();
    c.goLive();
    expect(fn).toHaveBeenCalledTimes(4);
    expect(fn.mock.calls.map((a) => [a[0].mode, a[0].rate])).toEqual([
      ['scrubbed', -2], ['scrubbed', 3], ['paused', 3], ['live', 1],
    ]);
    off();
    c.pause();
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('reports rate 1 while live regardless of an earlier rate', () => {
    const { c } = make();
    c.seek(0, 600);
    c.goLive();
    expect(c.snapshot().rate).toBe(1);
  });
});
