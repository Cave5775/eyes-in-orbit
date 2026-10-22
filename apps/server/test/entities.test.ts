import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EntityGraph, DEG, stateToGeodetic, type EntityRecord } from '@eio/core';
import { describe, expect, it } from 'vitest';
import { buildDemoEntities } from '../src/connectors/demo';
import { loadTrajectories } from '../src/connectors/flightclub';
import { Hub } from '../src/hub';
import { filterEntities, searchEntities } from '../src/search';
import { matchTrajectory, parseTrajectory, trajectorySamples } from '../src/trajectory';

const rec = (id: string, name: string, extra: Partial<EntityRecord> = {}): EntityRecord => ({
  id, name, kind: 'satellite', bodyId: 'EARTH', aliases: {}, updatedAt: 0, ...extra,
});

const CATALOG: EntityRecord[] = [
  rec('sat-25544', 'ISS (ZARYA)', { kind: 'station', aliases: { norad: '25544', cospar: '1998-067A', common: 'ISS' } }),
  rec('sat-49044', 'ISS (NAUKA)', { kind: 'station', aliases: { norad: '49044', cospar: '2021-066A' } }),
  rec('sat-1', 'COSMOS 2251 DEB', { kind: 'debris', aliases: { norad: '33791', cospar: '1993-036A' } }),
  rec('sat-2', 'STARLINK-1008', { group: 'starlink', aliases: { norad: '44714', cospar: '2019-074B' } }),
  rec('sat-3', 'ISSA SAT', { aliases: { norad: '10001' } }),
  rec('sat-4', 'ARISS-1', { aliases: { norad: '10002' } }),
  rec('dsn-VGR1', 'Voyager 1', { kind: 'probe', group: 'dsn', aliases: { dsn: 'VGR1' } }),
  rec('launch-abc', 'Falcon 9 Block 5 | Starlink Group 15-15', { kind: 'launch_vehicle', aliases: { ll2: 'abc' } }),
];
const ids = (q: string, limit?: number) => searchEntities(CATALOG, q, limit).map((h) => h.id);

describe('search ranking', () => {
  it('ranks exact id / alias above name prefix above substring', () => {
    expect(ids('25544')).toEqual(['sat-25544']);
    expect(ids('sat-25544')).toEqual(['sat-25544']);
    expect(ids('1998-067a')).toEqual(['sat-25544']);
    expect(ids('vgr1')).toEqual(['dsn-VGR1']);
    // "ISS": exact alias first, then name prefixes (station before satellite), then substrings
    expect(ids('iss')).toEqual(['sat-25544', 'sat-49044', 'sat-3', 'sat-4']);
  });

  it('matches word starts before inner substrings and finds launches by name', () => {
    expect(ids('starlink')).toEqual(['sat-2', 'launch-abc']);
    expect(ids('group 15')).toEqual(['launch-abc']);
    expect(ids('zzz')).toEqual([]);
    expect(ids('  ')).toEqual([]);
  });

  it('honours the limit and returns lightweight hits', () => {
    expect(ids('iss', 2)).toHaveLength(2);
    expect(searchEntities(CATALOG, '25544')[0]).toEqual({
      id: 'sat-25544', name: 'ISS (ZARYA)', kind: 'station', group: undefined, aliases: CATALOG[0].aliases,
    });
  });
});

describe('entity filters and hub', () => {
  it('filters by kind, body, group, q and limit', () => {
    expect(filterEntities(CATALOG, { kind: 'station' }).map((e) => e.id)).toEqual(['sat-25544', 'sat-49044']);
    expect(filterEntities(CATALOG, { group: 'dsn' })).toHaveLength(1);
    expect(filterEntities(CATALOG, { body: 'MARS' })).toEqual([]);
    expect(filterEntities(CATALOG, { q: 'starlink' }).map((e) => e.id)).toEqual(['sat-2', 'launch-abc']);
    expect(filterEntities(CATALOG, { limit: 3 })).toHaveLength(3);
    expect(filterEntities(CATALOG, {})).toHaveLength(CATALOG.length);
  });

  it('`since` returns only records updated after the cursor', async () => {
    const hub = new Hub(0);
    hub.upsert({ id: 'a', name: 'A', kind: 'satellite', bodyId: 'EARTH', aliases: {} });
    const cursor = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    hub.upsert({ id: 'b', name: 'B', kind: 'satellite', bodyId: 'EARTH', aliases: {} });
    expect(filterEntities(hub.graph.all(), { since: cursor }).map((e) => e.id)).toEqual(['b']);
    expect(filterEntities(hub.graph.all(), { since: 0 })).toHaveLength(2);
  });

  it('hub ignores unchanged upserts and batches entities.changed', async () => {
    const hub = new Hub(10);
    const events: string[][] = [];
    hub.on('entities.changed', (e) => events.push(e.ids));
    const a = { id: 'a', name: 'A', kind: 'satellite', bodyId: 'EARTH', aliases: {} };
    expect(hub.upsert(a, { ...a, id: 'b' })).toBe(2);
    expect(hub.upsert(a)).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual([['a', 'b']]);
    hub.upsert({ ...a, name: 'A2' });
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual([['a', 'b'], ['a']]);
  });

  it('counts topic subscribers', () => {
    const hub = new Hub();
    const seen: number[] = [];
    hub.on('topic', ({ count }) => seen.push(count));
    hub.subscribe('iss');
    hub.subscribe('iss');
    hub.unsubscribe('iss');
    hub.unsubscribe('iss');
    hub.unsubscribe('iss');
    expect(seen).toEqual([1, 2, 1, 0, 0]);
    expect(hub.subscribers('iss')).toBe(0);
  });
});

describe('trajectory files', () => {
  const json = {
    id: 'j', azimuthDeg: 90, match: { nameContains: 'Starlink' },
    rows: [{ tSec: 10, altKm: 1, speedKmS: 0.3 }, { tSec: 0, altKm: 0, speedKmS: 0 }, { tSec: 20, altKm: 4, speedKmS: 0.6 }],
  };

  it('parses JSON, sorts rows and integrates downrange from speed', () => {
    const t = parseTrajectory(JSON.stringify(json), 'j.json');
    expect(t.rows.map((r) => r.tSec)).toEqual([0, 10, 20]);
    expect(t.rows[0].downrangeKm).toBe(0);
    expect(t.rows[2].downrangeKm).toBeGreaterThan(t.rows[1].downrangeKm);
  });

  it('parses CSV with metadata comments and explicit downrange', () => {
    const t = parseTrajectory(
      '# id: c\n# azimuthDeg: 45\n# launchId: L1\ntSec,altKm,speedKmS,downrangeKm\n0,0,0,0\n10,2,0.3,1.5\n', 'c.csv',
    );
    expect(t).toMatchObject({ id: 'c', azimuthDeg: 45, match: { launchId: 'L1' } });
    expect(t.rows[1]).toEqual({ tSec: 10, altKm: 2, downrangeKm: 1.5 });
  });

  it('rejects incomplete files', () => {
    expect(() => parseTrajectory('{"rows":[]}', 'x.json')).toThrow(/rows/);
    expect(() => parseTrajectory(JSON.stringify({ ...json, match: {} }), 'x.json')).toThrow(/match/);
    expect(() => parseTrajectory(JSON.stringify({ ...json, rows: [{ tSec: 0, altKm: 0 }, { tSec: 1, altKm: 1 }] }), 'x.json')).toThrow(/downrangeKm or speedKmS/);
    expect(() => parseTrajectory('x', 'x.txt')).toThrow(/unsupported/);
  });

  it('matches launches by id first, then by name fragment', () => {
    const a = parseTrajectory(JSON.stringify(json), 'a.json');
    const b = parseTrajectory(JSON.stringify({ ...json, id: 'b', match: { launchId: 'L9' } }), 'b.json');
    expect(matchTrajectory([a, b], { id: 'L9', name: 'Starlink 1' })).toBe(b);
    expect(matchTrajectory([a, b], { id: 'L1', name: 'falcon 9 | starlink 1' })).toBe(a);
    expect(matchTrajectory([a, b], { id: 'L1', name: 'Electron' })).toBeUndefined();
  });

  it('anchors samples at liftoff and loads the shipped example', () => {
    const t = parseTrajectory(JSON.stringify(json), 'j.json');
    const s = trajectorySamples(t, { latDeg: 28.5, lonDeg: -80.6 }, 1_000_000);
    expect(s.map((x) => x[0])).toEqual([1_000_000, 1_010_000, 1_020_000]);

    const dir = mkdtempSync(join(tmpdir(), 'eio-traj-'));
    writeFileSync(join(dir, 'good.json'), JSON.stringify(json));
    writeFileSync(join(dir, 'bad.json'), '{"rows": 3}');
    const loaded = loadTrajectories(dir);
    expect(loaded.trajectories.map((x) => x.id)).toEqual(['j']);
    expect(loaded.errors).toHaveLength(1);

    const example = loadTrajectories(new URL('../../../data/trajectories', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    expect(example.errors).toEqual([]);
    expect(example.trajectories.map((x) => x.id)).toContain('example-leo-ascent');
  });
});

describe('demo entities', () => {
  const START = Date.parse('2026-10-22T12:00:00Z');

  it('builds booster, drone, rover, pads with the contract ids and kinds', () => {
    const list = buildDemoEntities(START, START + 5000);
    expect(list.map((e) => e.id).sort()).toEqual(['demo-booster', 'demo-drone', 'demo-lz', 'demo-pad', 'demo-rover']);
    expect(list.every((e) => e.group === 'demo')).toBe(true);
    const rover = list.find((e) => e.id === 'demo-rover')!;
    expect(rover).toMatchObject({ bodyId: 'MARS', provider: { type: 'geodetic', bodyId: 'MARS' } });
    expect(list.find((e) => e.id === 'demo-drone')!.provider!.type).toBe('relative');
  });

  it('booster flies pad -> ascent -> relative landing -> landed, continuously, and loops', () => {
    const g = new EntityGraph();
    for (const e of buildDemoEntities(START, START + 5000)) g.upsert({ ...e, updatedAt: 0 });
    const altAt = (t: number) => stateToGeodetic(g.stateOf('demo-booster', t)!, t, 'EARTH').alt;
    const lat = (t: number) => stateToGeodetic(g.stateOf('demo-booster', t)!, t, 'EARTH').lat / DEG;

    expect(altAt(START + 10_000)).toBeCloseTo(0, 3); // on the pad
    expect(altAt(START + 150_000 - 1)).toBeCloseTo(70, 0); // top of ascent
    expect(altAt(START + 150_000)).toBeCloseTo(70, 0); // landing arc starts where ascent ended
    expect(altAt(START + 240_000)).toBeGreaterThan(5);
    expect(altAt(START + 330_000 + 1000)).toBeCloseTo(0, 3); // landed
    expect(lat(START + 400_000)).toBeCloseTo(lat(START + 10_000), 2);
    // second cycle starts over at the pad
    expect(altAt(START + 600_000 + 10_000)).toBeCloseTo(0, 3);
    expect(altAt(START + 600_000 + 130_000)).toBeGreaterThan(10);
  });

  it('drone stays within ~150 m of the landing zone and rebuilding later windows shifts coverage', () => {
    const g = new EntityGraph();
    for (const e of buildDemoEntities(START, START + 5000)) g.upsert({ ...e, updatedAt: 0 });
    const t = START + 123_456;
    const d = g.stateIn('demo-drone', t, 'EARTH:fixed')!.r, lz = g.stateIn('demo-lz', t, 'EARTH:fixed')!.r;
    expect(Math.hypot(d[0] - lz[0], d[1] - lz[1], d[2] - lz[2])).toBeLessThan(0.2);

    const later = buildDemoEntities(START, START + 3 * 600_000 + 5000);
    const segs = (later.find((e) => e.id === 'demo-booster')!.provider as { segments: { fromMs: number }[] }).segments;
    expect(segs[0].fromMs).toBe(START + 3 * 600_000);
  });
});
