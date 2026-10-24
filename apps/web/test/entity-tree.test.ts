import { describe, expect, it } from 'vitest';
import { defaultBodies } from '@eio/core';
import { bodyCentre, entityCentre } from '../src/lib/frame';
import { bodyKey, bodyPathKeys, buildTreeRows, entityKey, groupKey, type TreeBody, type TreeItem, type TreeRow } from '../src/lib/entity-tree';

const BODIES: TreeBody[] = defaultBodies.all().map((b) => ({ id: b.id, name: b.name, parentId: b.parentId }));
const item = (id: string, kind: string, bodyId: string): TreeItem => ({ id, kind, bodyId });

/** 20 Earth satellites, 3 stations, LRO at the Moon, a rover on Mars. */
const CATALOG: TreeItem[] = [
  ...Array.from({ length: 20 }, (_, i) => item(`sat-${i}`, 'satellite', 'EARTH')),
  ...Array.from({ length: 3 }, (_, i) => item(`stn-${i}`, 'station', 'EARTH')),
  item('dsn-LRO', 'probe', 'MOON'),
  item('mars-probe-1', 'rover', 'MARS'),
];

const base = { bodies: BODIES, frame: bodyCentre('EARTH') };
const types = (rows: TreeRow[]) => rows.map((r) => (r.type === 'body' ? `B:${r.bodyId}` : r.type === 'group' ? `G:${r.kind}` : `E:${r.id}`));

describe('entity tree rows', () => {
  it('starts collapsed except the path to the frame (Earth: Sun and Earth open, kind groups and the other bodies closed)', () => {
    const rows = buildTreeRows(CATALOG, base);
    // SUN > (EARTH > MOON, then the kind groups) and MARS
    expect(types(rows)).toEqual(['B:SUN', 'B:EARTH', 'B:MOON', 'G:satellite', 'G:station', 'B:MARS']);
    const open = Object.fromEntries(rows.filter((r) => r.type === 'body').map((r) => [(r as { bodyId: string }).bodyId, (r as { open: boolean }).open]));
    expect(open).toEqual({ SUN: true, EARTH: true, MOON: false, MARS: false });
  });

  it('counts are subtree totals', () => {
    const rows = buildTreeRows(CATALOG, base);
    const count = (id: string) => (rows.find((r) => r.type === 'body' && r.bodyId === id) as { count: number }).count;
    expect(count('SUN')).toBe(CATALOG.length);
    expect(count('EARTH')).toBe(24); // 23 on the Earth + LRO at the Moon
    expect(count('MOON')).toBe(1);
    expect(count('MARS')).toBe(1);
    const group = rows.find((r) => r.type === 'group' && r.kind === 'satellite') as { count: number };
    expect(group.count).toBe(20);
  });

  it('depth follows the nesting', () => {
    const rows = buildTreeRows(CATALOG, { ...base, overrides: new Map([[bodyKey('MOON'), true], [groupKey('EARTH', 'station'), true]]) });
    const depthOf = (key: string) => rows.find((r) => r.key === key)!.depth;
    expect(depthOf(bodyKey('SUN'))).toBe(0);
    expect(depthOf(bodyKey('EARTH'))).toBe(1);
    expect(depthOf(bodyKey('MOON'))).toBe(2);
    expect(depthOf(entityKey('MOON', 'dsn-LRO'))).toBe(3);
    expect(depthOf(groupKey('EARTH', 'station'))).toBe(2);
    expect(depthOf(entityKey('EARTH', 'stn-0'))).toBe(3);
  });

  it('a body with few entities lists them directly (no kind groups), LRO under the Moon', () => {
    const rows = buildTreeRows(CATALOG, { ...base, frame: bodyCentre('MOON') });
    expect(types(rows)).toEqual(['B:SUN', 'B:EARTH', 'B:MOON', 'E:dsn-LRO', 'G:satellite', 'G:station', 'B:MARS']);
  });

  it('opens the path to an entity frame and its group', () => {
    const rows = buildTreeRows(CATALOG, { ...base, frame: entityCentre('stn-1'), frameBodyId: 'EARTH' });
    expect(types(rows)).toContain('E:stn-1');
    const rows2 = buildTreeRows(CATALOG, { ...base, frame: entityCentre('dsn-LRO'), frameBodyId: 'MOON' });
    expect(types(rows2)).toEqual(['B:SUN', 'B:EARTH', 'B:MOON', 'E:dsn-LRO', 'G:satellite', 'G:station', 'B:MARS']);
  });

  it('openAll (a query or filter is active) opens every node that has entities; empty bodies are dropped', () => {
    const hits = CATALOG.filter((r) => r.id === 'dsn-LRO');
    const rows = buildTreeRows(hits, { ...base, openAll: true });
    expect(types(rows)).toEqual(['B:SUN', 'B:EARTH', 'B:MOON', 'E:dsn-LRO']);
    expect(rows.every((r) => r.type !== 'body' || r.open)).toBe(true);

    const all = buildTreeRows(CATALOG, { ...base, openAll: true });
    expect(all.filter((r) => r.type === 'entity')).toHaveLength(CATALOG.length);
  });

  it('counts reflect the filtered set', () => {
    const stations = CATALOG.filter((r) => r.kind === 'station');
    const rows = buildTreeRows(stations, { ...base, openAll: true });
    expect(rows.find((r) => r.key === bodyKey('SUN'))).toMatchObject({ count: 3 });
    expect(rows.find((r) => r.key === bodyKey('MOON'))).toBeUndefined();
    expect(rows.find((r) => r.key === bodyKey('MARS'))).toBeUndefined();
  });

  it('explicit choices win over the defaults', () => {
    const overrides = new Map([[bodyKey('EARTH'), false], [bodyKey('MARS'), true]]);
    const rows = buildTreeRows(CATALOG, { ...base, overrides });
    expect(types(rows)).toEqual(['B:SUN', 'B:EARTH', 'B:MARS', 'E:mars-probe-1']);
    const rows2 = buildTreeRows(CATALOG, { ...base, overrides: new Map([[groupKey('EARTH', 'station'), true]]) });
    expect(types(rows2).filter((t) => t.startsWith('E:'))).toEqual(['E:stn-0', 'E:stn-1', 'E:stn-2']);
  });

  it('orders kind groups by size and keeps the input order inside a group', () => {
    const items = [item('a', 'debris', 'EARTH'), ...Array.from({ length: 13 }, (_, i) => item(`s${i}`, 'satellite', 'EARTH')), item('b', 'debris', 'EARTH')];
    const rows = buildTreeRows(items, { ...base, overrides: new Map([[groupKey('EARTH', 'debris'), true]]) });
    expect(types(rows)).toEqual(['B:SUN', 'B:EARTH', 'G:satellite', 'G:debris', 'E:a', 'E:b']);
  });

  it('uses bodyOf for search hits and hangs unknown bodies off the root', () => {
    const hits = [{ id: 'x', kind: 'probe' }, { id: 'y', kind: 'probe', bodyId: 'CERES' }];
    const rows = buildTreeRows(hits, { ...base, openAll: true, bodyOf: (h) => (h.id === 'x' ? 'MOON' : undefined) });
    expect(types(rows)).toEqual(['B:SUN', 'B:EARTH', 'B:MOON', 'E:x', 'B:CERES', 'E:y']);
  });

  it('bodyPathKeys runs from the root down', () => {
    expect(bodyPathKeys(BODIES, 'MOON')).toEqual(['b:SUN', 'b:EARTH', 'b:MOON']);
    expect(bodyPathKeys(BODIES, 'NOPE')).toEqual(['b:NOPE']);
  });

  it('flattens 12,000 entities fast and emits only what is open', () => {
    const big = Array.from({ length: 12_000 }, (_, i) => item(`sat-${i}`, i % 3 ? 'satellite' : 'debris', 'EARTH'));
    const t0 = performance.now();
    const closed = buildTreeRows(big, base);
    const tClosed = performance.now() - t0;
    expect(closed.length).toBeLessThan(10);
    const opened = buildTreeRows(big, { ...base, openAll: true });
    expect(opened.length).toBe(12_000 + 2 + 2); // SUN, EARTH, two kind groups
    expect(tClosed).toBeLessThan(200);
  });
});
