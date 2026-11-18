import { afterEach, describe, expect, it, vi } from 'vitest';
import { SORT_KEY, listComparator, loadSortMode, parseSortMode, saveSortMode, sortedBy, type SortInfo, type SortMode } from '../src/lib/list-sort';

const infos: Record<string, SortInfo> = {
  a: { radiusKm: 100, distanceKm: 50 }, b: { radiusKm: 6371, distanceKm: 10 }, c: {}, d: { radiusKm: 100, distanceKm: 50 },
};
const items = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: `n-${id}` }));
const sorted = (mode: SortMode) => sortedBy(items, listComparator<{ id: string; name: string }>(mode, (t) => infos[t.id])).map((t) => t.id);

describe('list sort', () => {
  it('default keeps the order (no comparator)', () => {
    expect(listComparator('default', () => undefined)).toBeUndefined();
    expect(sorted('default')).toEqual(['a', 'b', 'c', 'd']);
  });
  it('name sorts A to Z with numbers by value', () => {
    const cmp = listComparator('name', () => undefined)!;
    expect(['x10', 'x9', 'X1'].map((name) => ({ name })).sort(cmp).map((t) => t.name)).toEqual(['X1', 'x9', 'x10']);
  });
  it('distance: nearest first, ties and unknown by name, unknown last', () => {
    expect(sorted('distance')).toEqual(['b', 'a', 'd', 'c']);
  });
  it('size: largest first, ties and unknown by name, unknown last', () => {
    expect(sorted('size')).toEqual(['b', 'a', 'd', 'c']);
  });
  it('without any value a size or distance sort is the name sort', () => {
    const cmp = listComparator('size', () => undefined)!;
    expect([{ name: 'b' }, { name: 'a' }].sort(cmp).map((t) => t.name)).toEqual(['a', 'b']);
  });
  it('does not touch the input', () => {
    const copy = [...items];
    sortedBy(items, listComparator('name', () => undefined));
    expect(items).toEqual(copy);
  });
  it('parses a stored value, falling back to default', () => {
    expect(parseSortMode('size')).toBe('size');
    expect(parseSortMode('nonsense')).toBe('default');
    expect(parseSortMode(null)).toBe('default');
  });
});

describe('list sort storage', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('remembers the mode and survives a storage that throws', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    saveSortMode('distance');
    expect(store.get(SORT_KEY)).toBe('distance');
    expect(loadSortMode()).toBe('distance');
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(() => saveSortMode('name')).not.toThrow();
    expect(loadSortMode()).toBe('default');
  });
});
