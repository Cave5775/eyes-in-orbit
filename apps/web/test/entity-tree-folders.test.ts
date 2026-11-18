import { describe, expect, it } from 'vitest';
import { bodyKey, bodyPathKeys, buildTreeRows, groupKey, revealKeys, revealRowIndex, stickyAncestors, type BodyGroups, type TreeBody, type TreeItem, type TreeRow } from '../src/lib/entity-tree';
import { bodyGroupLabel, bodyGroupOrder } from '../src/lib/body-groups';

const item = (id: string, kind: string, bodyId: string): TreeItem => ({ id, kind, bodyId });
const types = (rows: TreeRow[]) => rows.map((r) => (r.type === 'body' ? `B:${r.bodyId}` : r.type === 'group' ? `G:${r.kind}` : `E:${r.id}`));

describe('entity tree body folders', () => {
  const bodies: TreeBody[] = [
    { id: 'SUN', name: 'Sun', kind: 'star' },
    { id: 'MARS', name: 'Mars', parentId: 'SUN', kind: 'planet', radiusKm: 3389 },
    { id: 'EARTH', name: 'Earth', parentId: 'SUN', kind: 'planet', radiusKm: 6378 },
    { id: 'CERES', name: 'Ceres', parentId: 'SUN', kind: 'dwarf_planet', radiusKm: 470 },
    { id: 'MOON', name: 'Moon', parentId: 'EARTH', kind: 'moon', radiusKm: 1737 },
  ];
  const groups: BodyGroups = { of: (b) => b.kind ?? 'other', label: bodyGroupLabel, order: bodyGroupOrder };
  const opts = { bodies, frameId: 'body-earth', frameBodyId: 'EARTH', skeleton: true, bodyGroups: groups };

  it('puts planets and dwarf planets in folders under the Sun and the Moon in one under Earth; no asteroid folder while empty', () => {
    const rows = buildTreeRows([], { ...opts, openAll: true });
    expect(types(rows)).toEqual(['B:SUN', 'G:planet', 'B:MARS', 'B:EARTH', 'G:moon', 'B:MOON', 'G:dwarf_planet', 'B:CERES']);
    expect(rows.filter((r) => r.type === 'group').map((r) => (r as { label?: string }).label)).toEqual(['Planets', 'Moons', 'Dwarf planets']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2, 3, 4, 1, 2]);
  });

  it('shows an asteroid body in its folder when one exists, without any change to the table', () => {
    const withAst = [...bodies, { id: 'EROS', name: 'Eros', parentId: 'SUN', kind: 'asteroid' }];
    const rows = buildTreeRows([], { ...opts, bodies: withAst, openAll: true });
    expect(types(rows).slice(-2)).toEqual(['G:asteroid', 'B:EROS']);
  });

  it('opens the path to the frame including the folders, and folds the rest', () => {
    const rows = buildTreeRows([], opts);
    expect(types(rows)).toEqual(['B:SUN', 'G:planet', 'B:MARS', 'B:EARTH', 'G:moon', 'G:dwarf_planet']);
    expect(rows.find((r) => r.type === 'group' && r.kind === 'moon')).toMatchObject({ open: false });
    expect(rows.find((r) => r.type === 'group' && r.kind === 'planet')).toMatchObject({ open: true });
  });

  it('counts the objects of a folder and lists the objects of a body after its folders', () => {
    const items = [item('s1', 'satellite', 'EARTH'), item('l1', 'probe', 'MOON'), item('r1', 'rover', 'MARS')];
    const rows = buildTreeRows(items, { ...opts, openAll: true, skeleton: false });
    const g = rows.filter((r) => r.type === 'group') as { kind: string; count: number }[];
    expect(g.map((x) => [x.kind, x.count])).toEqual([['planet', 3], ['moon', 1]]);
    expect(types(rows).indexOf('E:s1')).toBeGreaterThan(types(rows).indexOf('B:MOON'));
  });

  it('sorts the bodies inside a folder and the objects inside a group', () => {
    const rows = buildTreeRows([item('z', 'satellite', 'EARTH'), item('y', 'satellite', 'EARTH')], {
      ...opts, openAll: true, sortBodies: (a, b) => a.name.localeCompare(b.name), sortItems: (a, b) => a.id.localeCompare(b.id),
    });
    expect(types(rows).filter((t) => t === 'B:EARTH' || t === 'B:MARS')).toEqual(['B:EARTH', 'B:MARS']);
    expect(types(rows).filter((t) => t.startsWith('E:'))).toEqual(['E:y', 'E:z']);
  });

  it('path keys carry the folder before the body; reveal opens the folders of a body and of an object under a moon', () => {
    expect(bodyPathKeys(bodies, 'MOON', groups)).toEqual([bodyKey('SUN'), 'h:SUN:planet', bodyKey('EARTH'), 'h:EARTH:moon', bodyKey('MOON')]);
    expect(bodyPathKeys(bodies, 'MOON')).toEqual([bodyKey('SUN'), bodyKey('EARTH'), bodyKey('MOON')]);
    const keys = revealKeys(item('l1', 'probe', 'MOON'), { bodies, bodyGroups: groups });
    expect(keys).toEqual([bodyKey('SUN'), 'h:SUN:planet', bodyKey('EARTH'), 'h:EARTH:moon', bodyKey('MOON'), groupKey('MOON', 'probe')]);
    // a body entity opens everything above it, its own folder included
    const moon: TreeItem = { id: 'body-moon', kind: 'moon', provider: { type: 'body', bodyId: 'MOON' } };
    expect(revealKeys(moon, { bodies, bodyGroups: groups })).toEqual([bodyKey('SUN'), 'h:SUN:planet', bodyKey('EARTH'), 'h:EARTH:moon']);
  });

  it('a revealed object is in the rows once its keys are open', () => {
    const items = [item('l1', 'probe', 'MOON')];
    const keys = revealKeys(items[0], { bodies, bodyGroups: groups });
    const overrides = new Map(keys.map((k): [string, boolean] => [k, true]));
    expect(revealRowIndex(buildTreeRows(items, { ...opts, skeleton: false, overrides }), 'l1')).toBeGreaterThan(0);
  });

  it('sticky ancestors of a body in a folder are its parents and the folders on the way', () => {
    const rows = buildTreeRows([], { ...opts, openAll: true });
    const moon = rows.findIndex((r) => r.type === 'body' && r.bodyId === 'MOON');
    expect(stickyAncestors(rows, moon).map((i) => types(rows)[i])).toEqual(['B:SUN', 'G:planet', 'B:EARTH', 'G:moon']);
  });

  it('without bodyGroups nothing changes: the child bodies sit directly under their parent', () => {
    const rows = buildTreeRows([], { bodies, frameId: 'body-earth', frameBodyId: 'EARTH', skeleton: true, openAll: true });
    expect(types(rows)).toEqual(['B:SUN', 'B:MARS', 'B:EARTH', 'B:MOON', 'B:CERES']);
  });
});
