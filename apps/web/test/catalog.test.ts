import type { EntityRecord } from '@eio/core';
import { describe, expect, it } from 'vitest';
import { Catalog, sameShape } from '../src/lib/catalog';

const rec = (id: string, name = id): EntityRecord => ({ id, name, kind: 'satellite', bodyId: 'EARTH', aliases: {}, updatedAt: 0 });

describe('Catalog', () => {
  it('reads like a Map', () => {
    const c = Catalog.of([rec('a'), rec('b')]);
    expect(c.size).toBe(2);
    expect(c.get('a')?.name).toBe('a');
    expect(c.has('b')).toBe(true);
    expect(c.has('z')).toBe(false);
    expect([...c.keys()]).toEqual(['a', 'b']);
    expect([...c.values()].map((r) => r.id)).toEqual(['a', 'b']);
    expect([...c].map(([k]) => k)).toEqual(['a', 'b']);
    expect([...c.entries()].map(([k]) => k)).toEqual(['a', 'b']);
    const seen: string[] = [];
    c.forEach((v, k, m) => { seen.push(k); expect(m).toBe(c); });
    expect(seen).toEqual(['a', 'b']);
    expect(new Map(c).size).toBe(2); // a frozen copy when one is needed
    expect(Object.prototype.toString.call(c)).toBe('[object Catalog]');
  });

  it('a merge returns a new view (identity changes) and costs only its records', () => {
    const c0 = Catalog.of([rec('a')]);
    const c1 = c0.merged([rec('a', 'A2'), rec('b')]);
    expect(c1).not.toBe(c0);
    expect(c1.version).toBe(c0.version + 1);
    expect(c1.get('a')?.name).toBe('A2');
    expect(c1.size).toBe(2);
  });

  it('an older view is not a snapshot: it reads the shared map', () => {
    const c0 = Catalog.of([rec('a')]);
    const c1 = c0.merged([rec('b')]);
    expect(c0.has('b')).toBe(true);
    expect(c0.size).toBe(c1.size);
  });

  it('Catalog.of starts a map of its own that older catalogues do not see', () => {
    const old = Catalog.of([rec('a')]);
    const fresh = Catalog.of([rec('x')]);
    fresh.merged([rec('y')]);
    expect(old.has('x') || old.has('y')).toBe(false);
    expect(fresh.size).toBe(2);
  });
});


describe('sameShape', () => {
  const omm = (n: number) => ({ OBJECT_NAME: 'X', EPOCH: '2026-11-15T00:00:00', MEAN_MOTION: n, ECCENTRICITY: 0.001, INCLINATION: 53, RA_OF_ASC_NODE: 1, ARG_OF_PERICENTER: 2, MEAN_ANOMALY: 3, NORAD_CAT_ID: 1 });
  const sat = (extra: Partial<EntityRecord> = {}, n = 15): EntityRecord => ({
    ...rec('sat-1', 'STARLINK-1'), group: 'starlink', aliases: { norad: '1' }, render: { color: 'x' } as EntityRecord['render'],
    provider: { type: 'sgp4', omm: omm(n) } as EntityRecord['provider'], ...extra,
  });
  it('new orbital elements and a new updatedAt keep the shape', () => {
    expect(sameShape(sat(), sat({ updatedAt: 99 }, 15.1))).toBe(true);
    expect(sameShape(sat(), { ...sat(), aliases: { norad: '1' } })).toBe(true); // equal objects, new references
  });
  it('a new record, a rename, another group, alias or render, or a non-SGP4 record change the shape', () => {
    expect(sameShape(undefined, sat())).toBe(false);
    expect(sameShape(sat(), sat({ name: 'STARLINK-1 renamed' }))).toBe(false);
    expect(sameShape(sat(), sat({ group: 'other' }))).toBe(false);
    expect(sameShape(sat(), sat({ aliases: { norad: '1', cospar: '2019-001A' } }))).toBe(false);
    expect(sameShape(sat(), sat({ render: { color: 'y' } as EntityRecord['render'] }))).toBe(false);
    expect(sameShape(rec('p'), rec('p'))).toBe(false); // no SGP4 provider: a sampled track may move its listed parent
  });
});
