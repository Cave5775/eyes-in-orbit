import { rankMatches, type EntityRecord } from '@eio/core';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerApi } from '../src/api';
import { Http } from '../src/http';
import { Hub } from '../src/hub';
import { MIN_INDEXED, SearchIndex, ftsPhrase } from '../src/search-index';
import { Store } from '../src/store';

const rec = (id: string, name: string, extra: Partial<EntityRecord> = {}): EntityRecord => ({
  id, name, kind: 'satellite', bodyId: 'EARTH', aliases: {}, updatedAt: 0, ...extra,
});

const CATALOG: EntityRecord[] = [
  rec('sat-25544', 'ISS (ZARYA)', { kind: 'station', group: 'stations', aliases: { norad: '25544', cospar: '1998-067A', common: 'ISS' } }),
  rec('sat-49044', 'ISS (NAUKA)', { kind: 'station', group: 'stations', aliases: { norad: '49044', cospar: '2021-066A' } }),
  rec('sat-1', 'COSMOS 2251 DEB', { kind: 'debris', group: 'debris', aliases: { norad: '33791', cospar: '1993-036A' } }),
  rec('sat-2', 'STARLINK-1008', { group: 'starlink', aliases: { norad: '44714', cospar: '2019-074B' } }),
  rec('sat-3', 'STARLINK-1009', { group: 'starlink', aliases: { norad: '44715', cospar: '2019-074C' } }),
  rec('sat-4', 'ARISS-1', { aliases: { norad: '10002' } }),
  rec('sat-5', 'ISSA SAT', { aliases: { norad: '10001' } }),
  rec('dsn-VGR1', 'Voyager 1', { kind: 'probe', bodyId: 'SUN', group: 'dsn', aliases: { dsn: 'VGR1' } }),
  rec('launch-abc', 'Falcon 9 Block 5 | Starlink Group 15-15', { kind: 'launch_vehicle', aliases: { ll2: 'abc' } }),
  rec('sat-6', 'Café "Quote" 100% [x]_y', { aliases: { common: 'Naïve' } }),
  rec('sat-7', 'ÉTOILE-7', {}),
  rec('body-moon', 'Moon', { kind: 'moon', bodyId: 'MOON', aliases: {} }),
  rec('sat-8', 'Same Name', {}),
  rec('sat-9', 'Same Name', {}),
];

const mk = (recs = CATALOG) => {
  const byId = new Map(recs.map((r) => [r.id, r]));
  const index = new SearchIndex((id) => byId.get(id));
  index.rebuild(recs);
  return { index, byId };
};

describe('SearchIndex.match', () => {
  const queries = [
    'iss', 'ISS', 'starlink', 'starl', ' starlink ', 'link-100', '44714', '1998-067a', 'vgr1', 'zarya', 'group 15', 'abc', 'moon', 'mo',
    'x', 'zzz', 'same name', 'Café', 'café', 'ÉTOI', 'étoi', 'naïve', '"quote"', '100%', '[x]_y', 'a"b', "o'r", '*', 'iss*', 'NEAR(', '^iss', 'AND', 'launch-', '(zarya)',
  ];

  it('gives exactly the ranking of the whole catalogue, in the same order, for plain, special and short queries', () => {
    const { index } = mk();
    for (const q of queries) {
      const want = rankMatches(CATALOG, q).map((r) => r.rec.id);
      const got = index.match(q, () => CATALOG);
      expect(got.ids, `query ${JSON.stringify(q)}`).toEqual(want);
      expect(got.total).toBe(want.length);
      expect(got.truncated).toBe(false);
    }
  });

  it('uses the index from three characters and scans below that', () => {
    const { index } = mk();
    expect(MIN_INDEXED).toBe(3);
    expect(index.match('iss', () => CATALOG).via).toBe('index');
    expect(index.match('is', () => CATALOG).via).toBe('scan');
    expect(index.match('  ', () => CATALOG)).toEqual({ ids: [], total: 0, truncated: false, via: 'scan' });
  });

  it('ranks id/alias exact first, then name prefix, then word prefix, then substring; equal names by id', () => {
    const { index } = mk();
    expect(index.match('iss', () => CATALOG).ids.slice(0, 4)).toEqual(['sat-25544', 'sat-49044', 'sat-5', 'sat-4']);
    expect(index.match('same name', () => CATALOG).ids).toEqual(['sat-8', 'sat-9']);
  });

  it('a query cannot span two indexed fields (a line break cannot be typed, and a control character becomes a space)', () => {
    const { index } = mk();
    expect(index.match('1\ncosmos', () => CATALOG).ids).toEqual([]);
  });
});

describe('SearchIndex upkeep', () => {
  it('sync indexes new and changed records and drops gone ones', () => {
    const live = new Map(CATALOG.map((r) => [r.id, r]));
    const index = new SearchIndex((id) => live.get(id));
    index.rebuild([...live.values()]);
    expect(index.size).toBe(CATALOG.length);
    const all = () => live.values();
    expect(index.match('nauka', all).ids).toEqual(['sat-49044']);
    live.set('sat-49044', rec('sat-49044', 'ISS (RENAMED)', { kind: 'station' }));
    live.set('sat-100', rec('sat-100', 'NEW SATELLITE'));
    live.delete('sat-3');
    index.sync(['sat-49044', 'sat-100', 'sat-3']);
    expect(index.match('nauka', all).ids).toEqual([]);
    expect(index.match('renamed', all).ids).toEqual(['sat-49044']);
    expect(index.match('new sat', all).ids).toEqual(['sat-100']);
    expect(index.match('starlink-1009', all).ids).toEqual([]);
    expect(index.size).toBe(CATALOG.length); // +1 added, -1 removed
    for (const q of ['iss', 'starlink', 'sat']) expect(index.match(q, all).ids).toEqual(rankMatches(live.values(), q).map((r) => r.rec.id));
  });

  it('counts per body, kind and group with one GROUP BY', () => {
    const { index } = mk();
    const rows = index.counts();
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(CATALOG.length);
    expect(rows.find((r) => r.body === 'EARTH' && r.kind === 'station' && r.group === 'stations')?.count).toBe(2);
    expect(rows.find((r) => r.body === 'SUN' && r.kind === 'probe')?.count).toBe(1);
    expect(rows.find((r) => r.kind === 'moon')).toMatchObject({ body: 'MOON', group: null, count: 1 });
  });

  it('quotes a query as an FTS phrase', () => {
    expect(ftsPhrase('a"b')).toBe('"a""b"');
    expect(ftsPhrase('x\ny')).toBe('"x y"');
  });
});

describe('GET /api/match and /api/counts', () => {
  it('answers from the hub, including changes made just before the request', async () => {
    const hub = new Hub(10_000); // a long debounce: the route must flush by itself
    for (const e of CATALOG) hub.upsert({ id: e.id, name: e.name, kind: e.kind, bodyId: e.bodyId, group: e.group, aliases: e.aliases });
    const store = new Store(':memory:');
    const app = Fastify();
    registerApi(app, hub, new Http(store, { fetch: (async () => new Response('{}')) as typeof fetch }), store);
    const get = async (url: string) => (await app.inject({ url })).json();
    const a = await get('/api/match?q=starlink');
    expect(a).toMatchObject({ q: 'starlink', total: 3, truncated: false, via: 'index' });
    expect(a.ids).toEqual(['sat-2', 'sat-3', 'launch-abc']);
    hub.upsert({ id: 'sat-200', name: 'STARLINK-2000', kind: 'satellite', bodyId: 'EARTH', group: 'starlink', aliases: {} });
    expect((await get('/api/match?q=starlink')).ids).toContain('sat-200');
    expect(await get('/api/match')).toMatchObject({ ids: [], total: 0 });
    const c = await get('/api/counts');
    expect(c.total).toBe(CATALOG.length + 1);
    expect(c.rows.filter((r: { group: string }) => r.group === 'starlink').reduce((n: number, r: { count: number }) => n + r.count, 0)).toBe(3);
    await app.close();
  });
});
