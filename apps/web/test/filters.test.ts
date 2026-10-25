import { describe, expect, it } from 'vitest';
import type { EntityRecord } from '@eio/core';
import { browseOrder, facetCounts, matchScore, rankEntities } from '../src/lib/filters';
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

  it('ranks every match when the limit is open', () => {
    expect(rankEntities(CATALOG, 'starlink', Infinity).map((h) => h.id)).toEqual(['sat-44713', 'sat-44714']);
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
  it('are the browser categories: the kind decides, the feed hint is advisory, Starlink is a satellite', () => {
    expect(colorKeyOf({ ...CATALOG[2], render: { colorKey: 'probe' } })).toBe('probes');
    expect(colorKeyOf(CATALOG[0])).toBe('stations');
    expect(colorKeyOf(CATALOG[2])).toBe('satellites');
    expect(colorKeyOf({ ...CATALOG[2], render: { colorKey: 'starlink' } })).toBe('satellites');
    expect(colorKeyOf(CATALOG[4])).toBe('debris');
    expect(colorKeyOf(CATALOG[5])).toBe('launch-vehicles');
    expect(colorKeyOf(CATALOG[6])).toBe('probes');
    expect(colorKeyOf(rec('x', 'x', 'weird'))).toBe('other');
  });
});
