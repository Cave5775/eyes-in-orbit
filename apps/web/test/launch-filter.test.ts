import { describe, expect, it } from 'vitest';
import type { EntityRecord } from '@eio/core';
import { buildLaunchGroups, launchIdOf, launchMembers, searchLaunchGroups } from '../src/lib/launch-group';
import { NO_QUERY, classify, isDrawn, termFromWord, type Query } from '../src/lib/query';
import { mockSatellites } from '../src/mock/generators';

const rec = (id: string, name: string, kind: string, group: string, aliases: Record<string, string>): EntityRecord => ({
  id, name, kind, group, aliases, bodyId: 'EARTH', updatedAt: 0,
});

const SATS: EntityRecord[] = [
  rec('sat-22675', 'COSMOS 2251', 'debris', 'cosmos-2251-debris', { norad: '22675', cospar: '1993-036A' }),
  rec('sat-33791', 'COSMOS 2251 DEB', 'debris', 'cosmos-2251-debris', { norad: '33791', cospar: '1993-036BQ' }),
  rec('sat-33792', 'COSMOS 2251 DEB', 'debris', 'cosmos-2251-debris', { norad: '33792', cospar: '1993-036BR' }),
  rec('sat-44713', 'STARLINK-1007', 'satellite', 'starlink', { norad: '44713', cospar: '2019-074A' }),
  rec('sat-44714', 'STARLINK-1008', 'satellite', 'starlink', { norad: '44714', cospar: '2019-074B' }),
  rec('sat-lone', 'LONELY', 'satellite', 'active', { norad: '1', cospar: '2001-001A' }),
  rec('sat-nocospar', 'NO COSPAR', 'satellite', 'active', { norad: '2' }),
  rec('sat-bad', 'BAD COSPAR', 'satellite', 'active', { norad: '3', cospar: 'garbage' }),
];
const launch = (words: string): Query => ({ terms: words.split(' ').map((w) => termFromWord(w)!) });
const members = (query: Query) => SATS.filter((r) => isDrawn(classify(r, query))).map((r) => r.id);

describe('launch: tags', () => {
  it('reads the launch id from the cospar alias', () => {
    expect(launchIdOf(SATS[1])).toBe('1993-036');
    expect(launchIdOf(SATS[6])).toBeUndefined();
    expect(launchIdOf(SATS[7])).toBeUndefined();
  });

  it('launch:YYYY-NNN keeps the members, launch:YYYY every launch of the year', () => {
    expect(members(launch('launch:1993-036'))).toEqual(['sat-22675', 'sat-33791', 'sat-33792']);
    expect(members(launch('launch:2019'))).toEqual(['sat-44713', 'sat-44714']);
    expect(members(launch('launch:1993 launch:2019'))).toEqual(['sat-22675', 'sat-33791', 'sat-33792', 'sat-44713', 'sat-44714']);
    expect(members(launch('launch:1993-03'))).toEqual([]); // not a prefix of the digits
    expect(members(NO_QUERY)).toHaveLength(SATS.length);
  });

  it('an object without a valid cospar is never a member, and -launch: keeps it', () => {
    expect(members(launch('launch:2001-001'))).toEqual(['sat-lone']);
    expect(members(launch('-launch:1993-036 -launch:2019-074'))).toEqual(['sat-lone', 'sat-nocospar', 'sat-bad']);
  });

  it('combines with the other tags', () => {
    expect(members(launch('launch:1993-036 kind:satellite'))).toEqual([]);
    expect(members(launch('launch:1993-036 kind:debris'))).toEqual(['sat-22675', 'sat-33791', 'sat-33792']);
    expect(members(launch('launch:1993-036 -group:cosmos-2251-debris'))).toEqual([]);
  });

  it('a hidden launch leaves the scene and the list', () => {
    const hide: Query = { terms: [{ key: 'launch', value: '1993-036', effect: 'hide' }] };
    expect(members(hide)).toEqual(['sat-44713', 'sat-44714', 'sat-lone', 'sat-nocospar', 'sat-bad']);
  });
});

describe('launch groups', () => {
  it('builds groups of >= 2 members, largest first, labelled by the A piece', () => {
    const groups = buildLaunchGroups(SATS);
    expect(groups.map((g) => [g.id, g.label, g.count])).toEqual([
      ['1993-036', 'COSMOS 2251', 3],
      ['2019-074', 'STARLINK-1007', 2],
    ]);
    expect(groups[0].ids).toEqual(['sat-22675', 'sat-33791', 'sat-33792']);
    expect(buildLaunchGroups(SATS, 1).map((g) => g.id)).toContain('2001-001');
  });

  it('finds the members a launch: tag fits the camera to', () => {
    const groups = buildLaunchGroups(SATS);
    expect(launchMembers(groups, '1993-036')).toEqual(['sat-22675', 'sat-33791', 'sat-33792']);
    expect(launchMembers(groups, '2019')).toEqual(['sat-44713', 'sat-44714']);
    expect(launchMembers(groups, '19')).toEqual([]);
    expect(launchMembers(groups, '2001-001')).toEqual([]); // a single object is no group
  });

  it('searches groups by label, word and launch id', () => {
    const groups = buildLaunchGroups(SATS);
    expect(searchLaunchGroups(groups, '2251').map((g) => g.id)).toEqual(['1993-036']);
    expect(searchLaunchGroups(groups, 'cosmos').map((g) => g.id)).toEqual(['1993-036']);
    expect(searchLaunchGroups(groups, 'COSMOS 22').map((g) => g.id)).toEqual(['1993-036']);
    expect(searchLaunchGroups(groups, '1993-036').map((g) => g.id)).toEqual(['1993-036']);
    expect(searchLaunchGroups(groups, '2019').map((g) => g.id)).toEqual(['2019-074']);
    expect(searchLaunchGroups(groups, 'zzz')).toEqual([]);
    expect(searchLaunchGroups(groups, '  ').map((g) => g.id)).toEqual(['1993-036', '2019-074']);
    expect(searchLaunchGroups(groups, '', 1)).toHaveLength(1);
  });

  it('finds the COSMOS 2251 group in the mock catalog', () => {
    const sats = mockSatellites(Date.parse('2026-10-22T12:00:00Z'));
    const groups = buildLaunchGroups(sats);
    const cosmos = searchLaunchGroups(groups, '2251')[0];
    expect(cosmos).toMatchObject({ id: '1993-036', label: 'COSMOS 2251' });
    expect(cosmos.count).toBeGreaterThanOrEqual(120);
    expect(searchLaunchGroups(groups, 'cosmos')[0].id).toBe('1993-036');
    expect(groups.some((g) => g.label.startsWith('IRIDIUM 33'))).toBe(true);
    expect(groups.some((g) => g.label.startsWith('STARLINK'))).toBe(true);
    expect(sats.filter((s) => launchIdOf(s) === '1993-036').every((s) => s.kind === 'debris')).toBe(true);
    expect(groups.every((g) => g.count >= 2)).toBe(true);
  });
});
