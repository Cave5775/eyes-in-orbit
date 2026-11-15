import { describe, expect, it, vi } from 'vitest';
import { AssetCache } from '../src/lib/asset-cache';

const deferred = <T>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

function make(budget = 100, retryMs = 1000) {
  let now = 0;
  const loads: Record<string, ReturnType<typeof deferred<{ value: string; bytes: number }>>> = {};
  const disposed: string[] = [];
  const loader = vi.fn((key: string) => (loads[key] = deferred()).promise);
  const cache = new AssetCache<string>({ loader, dispose: (_v, k) => void disposed.push(k), budgetBytes: budget, retryMs, now: () => now });
  return { cache, loads, loader, disposed, advance: (ms: number) => (now += ms) };
}

describe('AssetCache', () => {
  it('loads once for many holders and hands the value out after the load', async () => {
    const { cache, loads, loader } = make();
    const a = cache.acquire('m');
    const b = cache.acquire('m');
    expect(a.value).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.stateOf('m')).toBe('loading');
    loads.m.resolve({ value: 'parsed', bytes: 10 });
    await a.ready;
    await b.ready;
    expect(cache.peek('m')).toBe('parsed');
    expect(cache.acquire('m').value).toBe('parsed');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.bytes).toBe(10);
  });

  it('keeps a released asset while the budget allows, and disposes the least recently used one beyond it', async () => {
    const { cache, loads, disposed } = make(100);
    for (const k of ['a', 'b', 'c']) {
      const g = cache.acquire(k);
      loads[k].resolve({ value: k, bytes: 40 });
      await g.ready;
      cache.release(k);
    }
    // 120 bytes loaded, budget 100: the oldest idle one (a) goes, as soon as the third arrives
    expect(disposed).toEqual(['a']);
    expect(cache.peek('a')).toBeNull();
    expect(cache.peek('b')).toBe('b');
    expect(cache.stateOf('a')).toBe('unknown');
  });

  it('never disposes an asset somebody holds, even over the budget', async () => {
    const { cache, loads, disposed } = make(50);
    const a = cache.acquire('a');
    const b = cache.acquire('b');
    loads.a.resolve({ value: 'a', bytes: 40 });
    loads.b.resolve({ value: 'b', bytes: 40 });
    await a.ready;
    await b.ready;
    expect(disposed).toEqual([]);
    expect(cache.bytes).toBe(80);
    cache.release('a'); // idle now, and 80 > 50: it can go
    expect(disposed).toEqual(['a']);
    expect(cache.peek('b')).toBe('b');
  });

  it('a recently used idle asset outlives an older one', async () => {
    const { cache, loads, disposed } = make(100);
    for (const k of ['old', 'new']) {
      const g = cache.acquire(k);
      loads[k].resolve({ value: k, bytes: 40 });
      await g.ready;
      cache.release(k);
    }
    cache.acquire('old'); // touched again: now the most recent
    cache.release('old');
    const c = cache.acquire('c');
    loads.c.resolve({ value: 'c', bytes: 40 });
    await c.ready;
    cache.release('c');
    expect(disposed).toEqual(['new']);
  });

  it('remembers a failed load for retryMs, then asks again', async () => {
    const { cache, loads, loader, advance } = make(100, 1000);
    const a = cache.acquire('x');
    loads.x.reject(new Error('404'));
    await a.ready;
    expect(cache.stateOf('x')).toBe('failed');
    expect((cache.errorOf('x') as Error).message).toBe('404');
    cache.release('x');
    expect(cache.acquire('x').value).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1); // not asked again yet
    advance(1500);
    cache.acquire('x');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('disposes a load that arrives after everybody let go of it', async () => {
    const { cache, loads, disposed } = make();
    const g = cache.acquire('late');
    cache.release('late');
    loads.late.resolve({ value: 'late', bytes: 5 });
    await g.ready;
    expect(disposed).toEqual(['late']);
    expect(cache.peek('late')).toBeNull();
  });

  it('keeps a load that somebody wanted again before it arrived', async () => {
    const { cache, loads, disposed } = make();
    const g = cache.acquire('k');
    cache.release('k');
    cache.acquire('k'); // wanted again while still loading
    loads.k.resolve({ value: 'k', bytes: 5 });
    await g.ready;
    expect(disposed).toEqual([]);
    expect(cache.peek('k')).toBe('k');
  });

  it('clear disposes everything and a pending load on arrival', async () => {
    const { cache, loads, disposed } = make();
    const a = cache.acquire('a');
    loads.a.resolve({ value: 'a', bytes: 5 });
    await a.ready;
    const p = cache.acquire('p');
    cache.clear();
    loads.p.resolve({ value: 'p', bytes: 5 });
    await p.ready;
    expect(disposed.sort()).toEqual(['a', 'p']);
    expect(cache.bytes).toBe(0);
  });
});
