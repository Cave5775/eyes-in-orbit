import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { IdbKv, MemoryKv, withQuotaRetry, type KvStore } from '../../src/engine/store';
import { isFresh, isQuotaError, lruVictims } from '../../src/engine/store/types';

const DAY = 86_400_000;
const now = Date.parse('2026-11-16T12:00:00Z');
const keys = async (s: KvStore, prefix: string) => (await s.list(prefix)).map((r) => r.key).sort();
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

// the same contract runs over memory and IndexedDB (a fake one in node)
const impls: [string, () => Promise<KvStore>][] = [
  ['MemoryKv', async () => new MemoryKv()],
  ['IdbKv', () => IdbKv.open({ factory: new IDBFactory(), keyRange: IDBKeyRange })],
];

describe.each(impls)('%s', (_name, make) => {
  it('stores, reads, lists by literal prefix and deletes kv rows', async () => {
    const s = await make();
    await s.put('a:1', { x: [1, 2] }, 1000, now);
    await s.put('a:2', 'two', 2000, now - 5);
    await s.put('a_b:1', 1, 1, now);
    await s.put('b:1', 1, 1, now);
    expect(await s.get('a:1')).toEqual({ value: { x: [1, 2] }, fetchedAt: now, ttlMs: 1000 });
    expect(await s.get('missing')).toBeUndefined();
    expect(await keys(s, 'a:')).toEqual(['a:1', 'a:2']);
    expect(await keys(s, 'a_')).toEqual(['a_b:1']);
    expect((await s.list('a:')).find((r) => r.key === 'a:2')?.row).toEqual({ value: 'two', fetchedAt: now - 5, ttlMs: 2000 });
    await s.put('a:1', 'replaced', 5, now + 1);
    expect(await s.get('a:1')).toEqual({ value: 'replaced', fetchedAt: now + 1, ttlMs: 5 });
    await s.delete('a:1');
    expect(await s.get('a:1')).toBeUndefined();
  });

  it('returns a copy: changing a read value does not change the row', async () => {
    const s = await make();
    await s.put('k', { n: 1 }, 1000, now);
    ((await s.get<{ n: number }>('k'))!.value).n = 9;
    expect((await s.get<{ n: number }>('k'))!.value.n).toBe(1);
  });

  describe('prune (ported from the SQLite store)', () => {
    it('drops rows stale for longer than maxAge past their TTL and keeps newer ones', async () => {
      const s = await make();
      await s.put('a:old', 1, 1000, now - 40 * DAY);
      await s.put('a:recent', 2, 1000, now - 10 * DAY);
      await s.put('a:fresh', 3, 3600_000, now);
      expect(await s.prune(30 * DAY, now)).toBe(1);
      expect(await keys(s, 'a:')).toEqual(['a:fresh', 'a:recent']);
    });

    it('keeps rows under a kept prefix at any age, and still prunes other old rows', async () => {
      const s = await make();
      await s.put('celestrak:starlink', [1], 1000, now - 400 * DAY);
      await s.put('celestrak:active', [2], 1000, now - 40 * DAY);
      await s.put('backoff:celestrak:x', { failures: 1 }, 1000, now - 40 * DAY);
      await s.put('limit:celestrak', { n: 1 }, 1000, now - 40 * DAY);
      await s.put('other:y', 1, 1000, now - 40 * DAY);
      expect(await s.prune(30 * DAY, now, ['celestrak:'])).toBe(3);
      expect(await keys(s, '')).toEqual(['celestrak:active', 'celestrak:starlink']);
    });

    it('treats a kept prefix literally (no wildcards)', async () => {
      const s = await make();
      for (const k of ['a_b:1', 'axb:1', '100%:1', '1000:1']) await s.put(k, 1, 1000, now - 40 * DAY);
      expect(await s.prune(30 * DAY, now, ['a_b:', '100%'])).toBe(2);
      expect(await keys(s, '')).toEqual(['100%:1', 'a_b:1']);
    });

    it('prunes by age only when no prefixes are given, and leaves blob rows alone', async () => {
      const s = await make();
      await s.put('celestrak:starlink', [1], 1000, now - 400 * DAY);
      await s.putBlob('tile:1', bytes(4), 1000, now - 400 * DAY);
      expect(await s.prune(30 * DAY, now)).toBe(1);
      expect(await s.blobInfo('tile:1')).toBeDefined();
    });
  });

  describe('blob rows', () => {
    it('round-trips bytes with age, TTL and size', async () => {
      const s = await make();
      await s.putBlob('tile:a', Uint8Array.of(1, 2, 3), 5000, now);
      expect(Array.from((await s.getBlob('tile:a', now))!.data)).toEqual([1, 2, 3]);
      expect(await s.blobInfo('tile:a')).toEqual({ fetchedAt: now, ttlMs: 5000, bytes: 3 });
      expect(await s.blobInfo('tile:none')).toBeUndefined();
      await s.deleteBlob('tile:a');
      expect(await s.getBlob('tile:a')).toBeUndefined();
    });

    it('touchBlob renews the age and TTL without rewriting the bytes', async () => {
      const s = await make();
      await s.putBlob('t:1', Uint8Array.of(7, 8), 1000, now - 10_000);
      await s.touchBlob('t:1', 9000, now);
      expect(await s.blobInfo('t:1')).toEqual({ fetchedAt: now, ttlMs: 9000, bytes: 2 });
      expect(Array.from((await s.getBlob('t:1', now))!.data)).toEqual([7, 8]);
      await s.touchBlob('t:none', 1, now); // a missing row is not an error
    });

    it('counts and sums the rows under a prefix', async () => {
      const s = await make();
      await s.putBlob('tile:gibs:1', bytes(100), 1, now);
      await s.putBlob('tile:gibs:2', bytes(50), 1, now);
      await s.putBlob('tile:mmgis:1', bytes(7), 1, now);
      expect(await s.blobStats('tile:gibs:')).toEqual({ count: 2, bytes: 150 });
      expect(await s.blobStats('')).toEqual({ count: 3, bytes: 157 });
    });

    it('trimBlobs deletes the least recently used rows of a prefix down to 90 % of the cap', async () => {
      const s = await make();
      for (let i = 1; i <= 5; i++) await s.putBlob(`tile:${i}`, bytes(100), 1, now + i * 1000); // usedAt = fetchedAt
      await s.putBlob('other:1', bytes(1000), 1, now);
      // reading tile:1 two minutes later makes it the most recently used
      await s.getBlob('tile:1', now + 120_000);
      expect(await s.trimBlobs('tile:', 600)).toBe(0); // 500 bytes, within the cap
      expect(await s.trimBlobs('tile:', 400)).toBe(2); // down to <= 360: tile:2 and tile:3 go
      expect(await s.blobInfo('tile:2')).toBeUndefined();
      expect(await s.blobInfo('tile:3')).toBeUndefined();
      expect(await s.blobInfo('tile:1')).toBeDefined();
      expect(await s.blobInfo('other:1')).toBeDefined(); // another prefix is never trimmed
      expect(await s.blobStats('tile:')).toEqual({ count: 3, bytes: 300 });
    });

    it('a read inside a minute of the last use does not move usedAt', async () => {
      const s = await make();
      await s.putBlob('t:old', bytes(100), 1, now);
      await s.putBlob('t:new', bytes(100), 1, now + 1000);
      await s.getBlob('t:old', now + 30_000); // within 60 s of its use: not renewed
      expect(await s.trimBlobs('t:', 150)).toBe(1);
      expect(await s.blobInfo('t:old')).toBeUndefined();
    });
  });
});

describe('IdbKv', () => {
  it('keeps its data across a reopen of the same database and creates both stores at version 1', async () => {
    const factory = new IDBFactory();
    const a = await IdbKv.open({ factory, keyRange: IDBKeyRange });
    await a.put('k', 1, 10, now);
    await a.putBlob('b', Uint8Array.of(1), 10, now);
    a.close();
    const b = await IdbKv.open({ factory, keyRange: IDBKeyRange });
    expect((await b.get('k'))?.value).toBe(1);
    expect((await b.blobInfo('b'))?.bytes).toBe(1);
    const db = await new Promise<IDBDatabase>((res) => { const r = factory.open('eio'); r.onsuccess = () => res(r.result); });
    expect(db.version).toBe(1);
    expect([...db.objectStoreNames].sort()).toEqual(['blob', 'kv']);
    expect(db.transaction('blob').objectStore('blob').indexNames.contains('usedAt')).toBe(true);
    db.close();
  });
});

describe('quota handling', () => {
  const quota = () => new DOMException('full', 'QuotaExceededError');

  it('recognises QuotaExceededError', () => {
    expect(isQuotaError(quota())).toBe(true);
    expect(isQuotaError(new Error('x'))).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });

  it('asks the hook to free space and retries the write once when the hook says so', async () => {
    const write = vi.fn<() => Promise<string>>().mockRejectedValueOnce(quota()).mockResolvedValue('done');
    const hook = vi.fn(async () => true);
    expect(await withQuotaRetry(write, hook, { store: 'blob', key: 'tile:1' })).toBe('done');
    expect(hook).toHaveBeenCalledWith(expect.anything(), { store: 'blob', key: 'tile:1' });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('rethrows when the hook frees nothing, when there is no hook, and when the retry fails again', async () => {
    await expect(withQuotaRetry(async () => { throw quota(); }, async () => false, { store: 'kv', key: 'k' })).rejects.toThrow('full');
    await expect(withQuotaRetry(async () => { throw quota(); }, undefined, { store: 'kv', key: 'k' })).rejects.toThrow('full');
    const hook = vi.fn(async () => true);
    await expect(withQuotaRetry(async () => { throw quota(); }, hook, { store: 'kv', key: 'k' })).rejects.toThrow('full');
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('does not involve the hook for other errors', async () => {
    const hook = vi.fn(async () => true);
    await expect(withQuotaRetry(async () => { throw new Error('boom'); }, hook, { store: 'kv', key: 'k' })).rejects.toThrow('boom');
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('isFresh compares age with the TTL', () => {
    expect(isFresh({ fetchedAt: now, ttlMs: 1000 }, now + 999)).toBe(true);
    expect(isFresh({ fetchedAt: now, ttlMs: 1000 }, now + 1000)).toBe(false);
  });

  it('lruVictims is empty within the cap and otherwise frees down to 90 %', () => {
    const rows = [{ key: 'a', bytes: 100, usedAt: 3 }, { key: 'b', bytes: 100, usedAt: 1 }, { key: 'c', bytes: 100, usedAt: 2 }];
    expect(lruVictims(rows, 300)).toEqual([]);
    expect(lruVictims(rows, 250)).toEqual(['b']);
    expect(lruVictims(rows, 150)).toEqual(['b', 'c']);
  });
});
