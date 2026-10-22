import { describe, expect, it } from 'vitest';
import type { EntityRecord } from '@eio/core';
import { NO_FILTERS, browseOrder, facetCounts, filtersActive, matchScore, matchesFilters, rankEntities, toggled } from '../src/lib/filters';
import { colorKeyOf } from '../src/lib/entity';

const rec = (id: string, name: string, kind: string, group?: string, aliases: Record<string, string> = {}): EntityRecord => ({
  id, name, kind, group, aliases, bodyId: 'EARTH', updatedAt: 0,
});

const CATALOG = [
  rec('sat-25544', 'ISS (ZARYA)', 'station', 'stations', { norad: '25544', cospar: '1998-067A' }),
  rec('sat-48274', 'CSS (TIANHE)', 'station', 'stations', { norad: '48274' }),
  rec('sat-44713', 'STARLINK-1007', 'satellite', 'starlink', { norad: '44713' }),
  rec('sat-44714', 'STARLINK-1008', 'satellite', 'starlink', { norad: '44714' }),
  rec('sat-1', 'COSMOS 2251 DEB', 'debris', 'active', { norad: '33791' }),
  rec('launch-x', 'Falcon 9 | Crew-14', 'launch_vehicle', 'launch'),
  rec('dsn-VGR1', 'Voyager 1', 'probe', 'dsn', { dsn: 'VGR1' }),
];

describe('filters', () => {
  it('matches kinds and groups, empty set meaning all', () => {
    const f = { kinds: new Set(['station']), groups: new Set<string>() };
    expect(CATALOG.filter((r) => matchesFilters(r, f)).map((r) => r.id)).toEqual(['sat-25544', 'sat-48274']);
    expect(matchesFilters(CATALOG[2], { kinds: new Set(['satellite']), groups: new Set(['starlink']) })).toBe(true);
    expect(matchesFilters(CATALOG[2], { kinds: new Set(['satellite']), groups: new Set(['active']) })).toBe(false);
    expect(CATALOG.every((r) => matchesFilters(r, NO_FILTERS))).toBe(true);
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive(f)).toBe(true);
  });

  it('toggled returns a new set', () => {
    const a = new Set(['a']);
    const b = toggled(a, 'b');
    expect([...b].sort()).toEqual(['a', 'b']);
    expect([...toggled(b, 'a')]).toEqual(['b']);
    expect([...a]).toEqual(['a']);
  });
});

describe('search ranking', () => {
  it('exact id/alias beats prefix beats substring', () => {
    expect(matchScore(CATALOG[0], '25544')).toBe(100);
    expect(matchScore(CATALOG[0], '1998-067a')).toBe(100);
    expect(matchScore(CATALOG[0], 'iss')).toBeGreaterThanOrEqual(80);
    expect(matchScore(CATALOG[0], 'zarya')).toBe(60);
    expect(matchScore(CATALOG[0], 'arya')).toBe(40);
    expect(matchScore(CATALOG[0], 'nope')).toBe(0);
  });

  it('ranks and limits results', () => {
    const hits = rankEntities(CATALOG, 'starlink', 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe('STARLINK-1007');
    expect(rankEntities(CATALOG, '48274')[0].id).toBe('sat-48274');
    expect(rankEntities(CATALOG, 'vgr1')[0].id).toBe('dsn-VGR1');
    expect(rankEntities(CATALOG, 'zzz')).toEqual([]);
  });

  it('counts facets most common first', () => {
    const { kinds, groups } = facetCounts(CATALOG);
    expect(kinds[0]).toEqual(['satellite', 2]);
    expect(groups.find(([g]) => g === 'starlink')?.[1]).toBe(2);
  });

  it('orders browse results with notable kinds first', () => {
    const sorted = [...CATALOG].sort(browseOrder);
    expect(sorted.map((r) => r.kind).slice(0, 4)).toEqual(['station', 'station', 'launch_vehicle', 'probe']);
    // the rest is alphabetical by name
    expect(sorted.slice(4).map((r) => r.name)).toEqual(['COSMOS 2251 DEB', 'STARLINK-1007', 'STARLINK-1008']);
  });
});

describe('colour keys', () => {
  it('prefers the server hint, then kind, then group', () => {
    expect(colorKeyOf({ ...CATALOG[2], render: { colorKey: 'probe' } })).toBe('probe');
    expect(colorKeyOf(CATALOG[0])).toBe('station');
    expect(colorKeyOf(CATALOG[2])).toBe('starlink');
    expect(colorKeyOf(CATALOG[4])).toBe('debris');
    expect(colorKeyOf(CATALOG[5])).toBe('vehicle');
    expect(colorKeyOf(rec('x', 'x', 'weird'))).toBe('satellite');
  });
});
