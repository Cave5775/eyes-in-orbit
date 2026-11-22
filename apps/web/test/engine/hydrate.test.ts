import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { backoffKey } from '../../src/engine/backoff';
import { createCelestrak, parseOmmJson } from '../../src/engine/connectors/celestrak';
import { engineConfig } from '../../src/engine/config';
import { Http } from '../../src/engine/http';
import { Hub } from '../../src/engine/hub';
import { Limiter } from '../../src/engine/net/limiter';
import { Scheduler } from '../../src/engine/scheduler';
import { MemoryKv, readOnlyKv } from '../../src/engine/store';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

/** a scheduler whose startup pass reads the cache only, over a store that already holds what an earlier visit left */
async function started(withCache = true) {
  const kv = new MemoryKv();
  if (withCache) {
    // nine hours old with a three hour TTL: stale, but the only data there is while CelesTrak cannot be reached
    await kv.put('celestrak:stations', parseOmmJson(fixture('celestrak-stations.json')), 3 * 3600_000, Date.now() - 9 * 3600_000);
  }
  const fetchMock = vi.fn<typeof fetch>(async () => { throw new TypeError('Failed to fetch'); });
  const limiter = new Limiter(kv, { limits: {} });
  const http = new Http(kv, { fetch: fetchMock, limiter });
  const ro = readOnlyKv(kv);
  const hydrate = { http: new Http(ro, { fetch: fetchMock, limiter: new Limiter(ro, { limits: {} }), cacheOnly: true }), store: ro };
  const hub = new Hub(0);
  const scheduler = new Scheduler({ hub, config: engineConfig(), store: kv, http, hydrate }, [createCelestrak()], 0);
  return { kv, hub, fetchMock, scheduler };
}

describe('scheduler hydration from the cache', () => {
  it('fills the hub from stale cached rows before the first request, without writing to the store', async () => {
    vi.useFakeTimers();
    try {
      const { kv, hub, fetchMock, scheduler } = await started();
      const rowBefore = await kv.get('celestrak:stations');
      await scheduler.start(); // returns after the cache pass, before any timer fired
      expect(fetchMock).not.toHaveBeenCalled();
      expect(hub.graph.get('sat-25544')).toBeDefined();
      // the stale row was read as it was: no refreshed timestamp, no failure gate written for it
      expect(await kv.get('celestrak:stations')).toEqual(rowBefore);
      expect(await kv.get(backoffKey('celestrak:stations'))).toBeUndefined();
      expect((await kv.list('backoff:')).length).toBe(0);
      // the health record is not touched by the pass: the first real run reports
      expect(hub.healthOf('celestrak').runs).toBe(0);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a connector with nothing cached stays quiet in the pass', async () => {
    vi.useFakeTimers();
    try {
      const { hub, kv, scheduler } = await started(false);
      await scheduler.start();
      expect(hub.graph.size).toBe(0);
      expect(hub.healthOf('celestrak')).toMatchObject({ status: 'idle', runs: 0 });
      expect((await kv.list('backoff:')).length).toBe(0);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('readOnlyKv', () => {
  it('reads through and swallows writes', async () => {
    const kv = new MemoryKv();
    await kv.put('a', 1, 1000);
    await kv.putBlob('b', new Uint8Array([1, 2]), 1000);
    const ro = readOnlyKv(kv);
    expect((await ro.get('a'))?.value).toBe(1);
    expect((await ro.getBlob('b'))?.data).toEqual(new Uint8Array([1, 2]));
    await ro.put('a', 2, 1000);
    await ro.delete('a');
    await ro.deleteBlob('b');
    await ro.putBlob('c', new Uint8Array([9]), 1000);
    expect((await kv.get('a'))?.value).toBe(1);
    expect(await kv.blobInfo('b')).toBeDefined();
    expect(await kv.blobInfo('c')).toBeUndefined();
  });
});
