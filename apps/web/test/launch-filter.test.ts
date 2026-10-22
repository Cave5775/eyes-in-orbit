import { describe, expect, it } from 'vitest';
import type { EntityRecord } from '@eio/core';
import {
  NO_FILTERS, buildLaunchGroups, filtersActive, launchIdOf, matchesFilters, sceneVisibility, searchLaunchGroups, type Filters,
} from '../src/lib/filters';
import { mockSatellites } from '../src/mock/generators';
import { runtime } from '../src/state/runtime';
import { useStore } from '../src/state/store';

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
const withLaunch = (launch: string | null, launchMode: 'only' | 'highlight' = 'only'): Filters => ({ ...NO_FILTERS, launch, launchMode });

describe('launch filter semantics', () => {
  it('reads the launch id from the cospar alias', () => {
    expect(launchIdOf(SATS[1])).toBe('1993-036');
    expect(launchIdOf(SATS[6])).toBeUndefined();
    expect(launchIdOf(SATS[7])).toBeUndefined();
  });

  it('list matching keeps only members in either mode', () => {
    for (const mode of ['only', 'highlight'] as const) {
      const ids = SATS.filter((r) => matchesFilters(r, withLaunch('1993-036', mode))).map((r) => r.id);
      expect(ids).toEqual(['sat-22675', 'sat-33791', 'sat-33792']);
    }
    expect(SATS.every((r) => matchesFilters(r, withLaunch(null)))).toBe(true);
    expect(filtersActive(withLaunch('1993-036'))).toBe(true);
    expect(filtersActive(withLaunch(null))).toBe(false);
    // filters written before the launch fields existed still work
    expect(matchesFilters(SATS[0], { kinds: new Set(), groups: new Set() })).toBe(true);
  });

  it('show-only hides non-members, highlight dims them', () => {
    const member = SATS[1];
    const other = SATS[3];
    expect(sceneVisibility(member, withLaunch('1993-036', 'only'))).toBe('show');
    expect(sceneVisibility(other, withLaunch('1993-036', 'only'))).toBe('hide');
    expect(sceneVisibility(other, withLaunch('1993-036', 'highlight'))).toBe('dim');
    expect(sceneVisibility(member, withLaunch('1993-036', 'highlight'))).toBe('show');
    expect(sceneVisibility(SATS[6], withLaunch('1993-036', 'highlight'))).toBe('dim'); // no cospar is never a member
    expect(sceneVisibility(other, NO_FILTERS)).toBe('show');
  });

  it('kind and group filters still hide in highlight mode and combine with the launch', () => {
    const f: Filters = { kinds: new Set(['satellite']), groups: new Set(), launch: '1993-036', launchMode: 'highlight' };
    expect(sceneVisibility(SATS[1], f)).toBe('hide'); // member but wrong kind
    expect(sceneVisibility(SATS[3], f)).toBe('dim');
    expect(matchesFilters(SATS[1], { ...f, kinds: new Set(['debris']) })).toBe(true);
    expect(matchesFilters(SATS[3], { ...f, kinds: new Set(['debris']) })).toBe(false);
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

describe('launch filter store actions', () => {
  it('sets the group, requests a camera fit, switches mode and clears', () => {
    const fits: string[][] = [];
    runtime.onFitRequest = (ids) => void fits.push(ids);
    useStore.getState().setLaunchFilter('1993-036', ['a', 'b']);
    expect(useStore.getState().filters.launch).toBe('1993-036');
    expect(fits).toEqual([['a', 'b']]);
    useStore.getState().setLaunchMode('highlight');
    expect(useStore.getState().filters).toMatchObject({ launch: '1993-036', launchMode: 'highlight' });
    expect(fits).toHaveLength(1); // changing the mode does not refit
    useStore.getState().setLaunchFilter(null);
    expect(useStore.getState().filters.launch).toBeNull();
    expect(fits).toHaveLength(1);
    useStore.getState().setLaunchFilter('x');
    useStore.getState().clearFilters();
    expect(useStore.getState().filters.launch).toBeNull();
    expect(useStore.getState().filters.launchMode).toBe('highlight'); // mode is a preference and survives CLEAR
    runtime.onFitRequest = undefined;
    expect(() => useStore.getState().setLaunchFilter('1993-036', ['a'])).not.toThrow(); // no scene hook installed
    useStore.getState().clearFilters();
  });
});
