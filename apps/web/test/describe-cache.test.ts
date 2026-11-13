import type { Description } from '@eio/core';
import { describe, expect, it, vi } from 'vitest';
import { DESCRIBE_REUSE_MS, createDescribeCache, limitedNotice } from '../src/lib/describe-cache';

const desc = (id: string): Description => ({
  entityId: id, fallback: 'x', searchUrl: 'https://en.wikipedia.org/', sources: { wikidata: 'ok', wikipedia: 'ok', discos: 'off' }, fetchedAt: 0,
});

describe('describe cache (About tab)', () => {
  it('shares one in-flight lookup and reuses the answer for 60 s, then asks again', async () => {
    let t = 1_000_000;
    const load = vi.fn(async (id: string) => desc(id));
    const cache = createDescribeCache(load, { now: () => t });
    const [a, b] = await Promise.all([cache.get('sat-1'), cache.get('sat-1')]);
    expect(a).toBe(b);
    t += DESCRIBE_REUSE_MS - 1;
    expect(await cache.get('sat-1')).toBe(a);
    expect(load).toHaveBeenCalledTimes(1);
    t += 2;
    await cache.get('sat-1');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a rate limited answer: the next open asks again', async () => {
    const limited = { ...desc('sat-1'), limitedUntil: 5_000_000 };
    const load = vi.fn<(id: string) => Promise<Description>>().mockResolvedValueOnce(limited).mockImplementation(async (id) => desc(id));
    const cache = createDescribeCache(load);
    expect(await cache.get('sat-1')).toBe(limited);
    await Promise.resolve();
    const real = await cache.get('sat-1');
    expect(real.limitedUntil).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
    await cache.get('sat-1'); // a real answer is reused
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps entities apart and forgets a failed lookup at once', async () => {
    const load = vi.fn<(id: string) => Promise<Description>>()
      .mockRejectedValueOnce(new Error('HTTP 502'))
      .mockImplementation(async (id) => desc(id));
    const cache = createDescribeCache(load);
    await expect(cache.get('sat-1')).rejects.toThrow('HTTP 502');
    await cache.get('sat-1'); // a failure is not kept
    await cache.get('sat-2');
    expect(load).toHaveBeenCalledTimes(3);
    await cache.get('sat-1');
    expect(load).toHaveBeenCalledTimes(3);
    cache.clear();
    await cache.get('sat-1');
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('says when a rate limited lookup can be tried again', () => {
    expect(limitedNotice({})).toBeUndefined();
    expect(limitedNotice({ limitedUntil: Date.UTC(2026, 10, 1, 14, 30) })).toBe('rate limited, try again at 14:30Z');
  });
});
