import type { EntityRecord } from '@eio/core';
import { describe, expect, it } from 'vitest';
import { loadPaged, pageSlice, type CatalogPage } from '../src/lib/paging';

const recs = (n: number, from = 0): EntityRecord[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${from + i}`, name: `S${from + i}`, kind: 'satellite', bodyId: 'EARTH', aliases: {}, updatedAt: 0 }));

/** A fake server of `n` records in pages of `size`. */
const server = (n: number, size: number, log?: number[]) => async (offset: number): Promise<CatalogPage> => {
  log?.push(offset);
  const all = recs(n);
  const { items, next } = pageSlice(all, offset, size);
  return { serverTime: 1000 + offset, entities: items, next, total: offset === 0 ? n : undefined };
};

describe('pageSlice', () => {
  const xs = [1, 2, 3, 4, 5];
  it('slices, chains next, and returns everything without a limit', () => {
    expect(pageSlice(xs, 0, 2)).toEqual({ items: [1, 2], next: 2 });
    expect(pageSlice(xs, 4, 2)).toEqual({ items: [5] });
    expect(pageSlice(xs, 3, 2)).toEqual({ items: [4, 5] });
    expect(pageSlice(xs)).toEqual({ items: xs });
    expect(pageSlice(xs, 2)).toEqual({ items: [3, 4, 5] });
    expect(pageSlice(xs)).not.toBe(xs.slice());
  });
});

describe('loadPaged', () => {
  it('loads every record once, in order, and reports the first page serverTime', async () => {
    const got: string[] = [];
    const r = await loadPaged(server(95, 10), (rs) => got.push(...rs.map((e) => e.id)));
    expect(got).toEqual(recs(95).map((e) => e.id));
    expect(r).toMatchObject({ count: 95, pages: 10, serverTime: 1000, total: 95 });
  });

  it('commits the first page at once, then on a doubling schedule, and `first` is true only once', async () => {
    const sizes: number[] = [];
    const firsts: boolean[] = [];
    const r = await loadPaged(server(1000, 10), (rs, first) => (sizes.push(rs.length), firsts.push(first)));
    // 10, then 10 (waiting 10 >= committed 10), 20, 40, 80, 160, 320, and the rest
    expect(sizes.slice(0, 5)).toEqual([10, 10, 20, 40, 80]);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(firsts.filter(Boolean)).toHaveLength(1);
    expect(firsts[0]).toBe(true);
    expect(r.commits).toBe(sizes.length);
    expect(r.commits).toBeLessThan(15); // logarithmic in the number of pages (100), not one per page
  });

  it('a single page commits once; an empty catalogue commits one empty first batch', async () => {
    const sizes: number[] = [];
    await loadPaged(server(5, 10), (rs) => sizes.push(rs.length));
    expect(sizes).toEqual([5]);
    const empty: [number, boolean][] = [];
    await loadPaged(server(0, 10), (rs, first) => empty.push([rs.length, first]));
    expect(empty).toEqual([[0, true]]);
  });

  it('keeps what it has when a page fails, and rethrows', async () => {
    const got: string[] = [];
    let calls = 0;
    const fetchPage = async (offset: number) => {
      if (++calls === 4) throw new Error('HTTP 500');
      return server(100, 10)(offset);
    };
    await expect(loadPaged(fetchPage, (rs) => got.push(...rs.map((e) => e.id)))).rejects.toThrow('HTTP 500');
    expect(got).toEqual(recs(30).map((e) => e.id)); // three good pages, none lost between commits
  });

  it('refuses a server whose next does not advance, and one that never ends', async () => {
    const stuck = async (): Promise<CatalogPage> => ({ serverTime: 1, entities: recs(2), next: 0 });
    await expect(loadPaged(stuck, () => undefined)).rejects.toThrow(/does not advance/);
    let o = 0;
    const endless = async (): Promise<CatalogPage> => ({ serverTime: 1, entities: recs(1), next: ++o });
    await expect(loadPaged(endless, () => undefined, { maxPages: 50 })).rejects.toThrow(/more than 50 pages/);
  });

  it('reports progress after every page', async () => {
    const seen: [number, number | undefined][] = [];
    await loadPaged(server(25, 10), () => undefined, { onProgress: (n, t) => seen.push([n, t]) });
    expect(seen).toEqual([[10, 25], [20, 25], [25, 25]]);
  });
});
