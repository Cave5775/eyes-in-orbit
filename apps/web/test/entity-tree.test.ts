import { describe, expect, it } from 'vitest';
import { bodyEntityRecords, defaultBodies } from '@eio/core';
import { bodyKey, bodyPathKeys, buildTreeRows, entityKey, groupKey, revealKeys, revealRowIndex, scrollTopToReveal, type TreeBody, type TreeItem, type TreeRow } from '../src/lib/entity-tree';

const BODIES: TreeBody[] = defaultBodies.all().map((b) => ({ id: b.id, name: b.name, parentId: b.parentId }));
const item = (id: string, kind: string, bodyId: string): TreeItem => ({ id, kind, bodyId });

/** 20 Earth satellites, 3 stations, LRO at the Moon, a rover on Mars. */
const CATALOG: TreeItem[] = [
  ...Array.from({ length: 20 }, (_, i) => item(`sat-${i}`, 'satellite', 'EARTH')),
  ...Array.from({ length: 3 }, (_, i) => item(`stn-${i}`, 'station', 'EARTH')),
  item('dsn-LRO', 'probe', 'MOON'),
  item('mars-probe-1', 'rover', 'MARS'),
];

/** the frame is an entity id; the caller says which body node its path ends at (the frame's own body, or an object's primary) */
const base = { bodies: BODIES, frameId: 'body-earth', frameBodyId: 'EARTH' };
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
    const rows = buildTreeRows(CATALOG, { ...base, frameId: 'body-moon', frameBodyId: 'MOON' });
    expect(types(rows)).toEqual(['B:SUN', 'B:EARTH', 'B:MOON', 'E:dsn-LRO', 'G:satellite', 'G:station', 'B:MARS']);
  });

  it('opens the path to an entity frame and its group', () => {
    const rows = buildTreeRows(CATALOG, { ...base, frameId: 'stn-1', frameBodyId: 'EARTH' });
    expect(types(rows)).toContain('E:stn-1');
    const rows2 = buildTreeRows(CATALOG, { ...base, frameId: 'dsn-LRO', frameBodyId: 'MOON' });
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

  describe('body entities as nodes', () => {
    const bodyItems: TreeItem[] = bodyEntityRecords().map((r) => ({ id: r.id, kind: r.kind, bodyId: r.bodyId, provider: r.provider }));
    const all = [...bodyItems, ...CATALOG];
    const bodyRows = (rows: TreeRow[]) => rows.filter((r): r is Extract<TreeRow, { type: 'body' }> => r.type === 'body');

    it('backs the nodes with the entities: entityId on the row, no duplicate rows, counts without the bodies', () => {
      const rows = buildTreeRows(all, { ...base, openAll: true });
      const ent = Object.fromEntries(bodyRows(rows).map((r) => [r.bodyId, r.entityId]));
      expect(ent).toEqual({ SUN: 'body-sun', EARTH: 'body-earth', MOON: 'body-moon', MARS: 'body-mars' });
      // no body entity is also listed as an ordinary row
      expect(rows.filter((r) => r.type === 'entity' && r.id.startsWith('body-'))).toEqual([]);
      expect(rows.filter((r) => r.type === 'entity')).toHaveLength(CATALOG.length);
      const count = (id: string) => bodyRows(rows).find((r) => r.bodyId === id)!.count;
      expect(count('SUN')).toBe(CATALOG.length);
      expect(count('EARTH')).toBe(24);
      expect(count('MARS')).toBe(1);
      // same shape as without the body entities
      expect(types(rows)).toEqual(types(buildTreeRows(CATALOG, { ...base, openAll: true })));
    });

    it('keeps the collapsed layout and the open path with the entities present', () => {
      expect(types(buildTreeRows(all, base))).toEqual(['B:SUN', 'B:EARTH', 'B:MOON', 'G:satellite', 'G:station', 'B:MARS']);
    });

    it('shows a node for a hit body entity even with nothing under it (Mars alone)', () => {
      const hits = all.filter((r) => r.id === 'body-mars');
      const rows = buildTreeRows(hits, { ...base, openAll: true });
      expect(types(rows)).toEqual(['B:SUN', 'B:MARS']);
      expect(bodyRows(rows).find((r) => r.bodyId === 'MARS')).toMatchObject({ entityId: 'body-mars', count: 0 });
      expect(bodyRows(rows).find((r) => r.bodyId === 'SUN')!.entityId).toBeUndefined();
    });

    it('a filtered-out body entity leaves a synthesised node that still has objects under it, with the known entity id', () => {
      const noBodies = CATALOG;
      const rows = buildTreeRows(noBodies, { ...base, bodies: BODIES.map((b) => ({ ...b, entityId: `body-${b.id.toLowerCase()}` })) });
      expect(bodyRows(rows).find((r) => r.bodyId === 'MARS')).toMatchObject({ entityId: 'body-mars', count: 1 });
      // fallback: a registry body with no entity at all keeps the synthesised node and no entityId
      const plain = buildTreeRows(noBodies, base);
      expect(bodyRows(plain).map((r) => r.bodyId)).toEqual(['SUN', 'EARTH', 'MOON', 'MARS']);
      expect(bodyRows(plain).every((r) => r.entityId === undefined)).toBe(true);
    });

    it('recognises search hits of body entities through standsForBody', () => {
      const hit: TreeItem = { id: 'body-moon', kind: 'moon' };
      const rows = buildTreeRows([hit], { ...base, openAll: true, standsForBody: (h) => (h.id === 'body-moon' ? 'MOON' : undefined) });
      expect(types(rows)).toEqual(['B:SUN', 'B:EARTH', 'B:MOON']);
      expect(bodyRows(rows).find((r) => r.bodyId === 'MOON')!.entityId).toBe('body-moon');
    });

    it('an entity whose body the registry lacks hangs a node off the root', () => {
      const ceres = { id: 'body-ceres', kind: 'planet', bodyId: 'SUN', provider: { type: 'body', bodyId: 'CERES' } };
      const rows = buildTreeRows([ceres], { ...base, openAll: true });
      expect(types(rows)).toEqual(['B:SUN', 'B:CERES']);
    });
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

describe('reveal a selected entity', () => {
  const bodyItems: TreeItem[] = bodyEntityRecords().map((r) => ({ id: r.id, kind: r.kind, bodyId: r.bodyId, provider: r.provider }));
  const all = [...bodyItems, ...CATALOG];
  const opts = { bodies: BODIES };
  const find = (id: string) => all.find((i) => i.id === id)!;
  /** rows after opening the revealed keys on top of the defaults */
  const rowsWith = (keys: string[], frameBodyId = base.frameBodyId) =>
    buildTreeRows(all, { bodies: BODIES, frameId: `body-${frameBodyId.toLowerCase()}`, frameBodyId, overrides: new Map(keys.map((k) => [k, true])) });

  it('opens the body chain and the kind group of an Earth satellite so its row appears', () => {
    const keys = revealKeys(find('sat-3'), opts);
    expect(keys).toEqual([bodyKey('SUN'), bodyKey('EARTH'), groupKey('EARTH', 'satellite')]);
    expect(revealRowIndex(buildTreeRows(all, base), 'sat-3')).toBe(-1);
    const rows = rowsWith(keys);
    const i = revealRowIndex(rows, 'sat-3');
    expect(rows[i]).toMatchObject({ type: 'entity', id: 'sat-3', depth: 3 });
  });

  it('opens Mars and the Moon chain from a frame elsewhere (nothing else changes)', () => {
    const keys = revealKeys(find('mars-probe-1'), opts);
    expect(keys).toEqual([bodyKey('SUN'), bodyKey('MARS'), groupKey('MARS', 'rover')]);
    expect(revealRowIndex(rowsWith(keys), 'mars-probe-1')).toBeGreaterThan(0);
    const moon = revealKeys(find('dsn-LRO'), opts);
    expect(moon.slice(0, 3)).toEqual([bodyKey('SUN'), bodyKey('EARTH'), bodyKey('MOON')]);
    expect(revealRowIndex(rowsWith(moon, 'MARS'), 'dsn-LRO')).toBeGreaterThan(0);
  });

  it('a body entity reveals its own node: only the nodes above it open', () => {
    expect(revealKeys(find('body-moon'), opts)).toEqual([bodyKey('SUN'), bodyKey('EARTH')]);
    expect(revealKeys(find('body-sun'), opts)).toEqual([]);
    const rows = rowsWith(revealKeys(find('body-moon'), opts), 'MARS');
    expect(revealRowIndex(rows, 'body-moon')).toBeGreaterThan(0);
    // a search hit that stands for a body (no provider) is the same
    expect(revealKeys({ id: 'hit', kind: 'moon' }, { ...opts, standsForBody: () => 'MOON' })).toEqual([bodyKey('SUN'), bodyKey('EARTH')]);
  });

  it('uses bodyOf for search hits and hangs an unknown body off the root', () => {
    expect(revealKeys({ id: 'x', kind: 'probe' }, { ...opts, bodyOf: () => 'MOON' }).slice(0, 3)).toEqual([bodyKey('SUN'), bodyKey('EARTH'), bodyKey('MOON')]);
    expect(revealKeys({ id: 'y', kind: 'probe', bodyId: 'CERES' }, opts)).toEqual([bodyKey('SUN'), bodyKey('CERES'), groupKey('CERES', 'probe')]);
    expect(revealKeys({ id: 'z', kind: 'probe' }, opts).slice(0, 2)).toEqual([bodyKey('SUN'), bodyKey('EARTH')]);
  });

  it('finds the row of an entity row or of a body node, -1 when it is hidden', () => {
    const rows = buildTreeRows(all, { ...base, openAll: true });
    expect(rows[revealRowIndex(rows, 'stn-1')]).toMatchObject({ type: 'entity', id: 'stn-1' });
    expect(rows[revealRowIndex(rows, 'body-mars')]).toMatchObject({ type: 'body', bodyId: 'MARS' });
    expect(revealRowIndex(rows, 'nope')).toBe(-1);
  });

  describe('scrollTopToReveal', () => {
    const H = 28;
    it('does not move when the row is fully visible', () => {
      expect(scrollTopToReveal(5, H, 0, 280, 100)).toBeNull();
      expect(scrollTopToReveal(9, H, 0, 280, 100)).toBeNull(); // last fully visible row
      expect(scrollTopToReveal(30, H, 28 * 25, 280, 100)).toBeNull();
    });
    it('centres a row that is out of view or cut off', () => {
      expect(scrollTopToReveal(50, H, 0, 280, 100)).toBe(50 * H - (280 - H) / 2);
      expect(scrollTopToReveal(10, H, 0, 280, 100)).toBe(10 * H - (280 - H) / 2); // just below
      expect(scrollTopToReveal(2, H, 28 * 40, 280, 100)).toBe(0); // clamped at the top
    });
    it('clamps at the end of the list and ignores a bad index', () => {
      expect(scrollTopToReveal(99, H, 0, 280, 100)).toBe(100 * H - 280);
      expect(scrollTopToReveal(3, H, 0, 280, 5)).toBeNull();
      expect(scrollTopToReveal(-1, H, 0, 280, 100)).toBeNull();
      expect(scrollTopToReveal(100, H, 0, 280, 100)).toBeNull();
    });
  });
});
