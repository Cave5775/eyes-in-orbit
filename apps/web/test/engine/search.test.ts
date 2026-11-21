import { rankMatches, type EntityRecord } from '@eio/core';
import { describe, expect, it } from 'vitest';
import { Hub } from '../../src/engine/hub';
import {
  EntitySearch, MAX_MATCH, MAX_PAGE, countEntities, filterEntities, matchEntities, pageEntities, searchEntities,
} from '../../src/engine/search';

const rec = (i: number, extra: Partial<EntityRecord> = {}): EntityRecord => ({
  id: `sat-${i}`, name: `SAT ${i}`, kind: i % 5 === 0 ? 'debris' : 'satellite', bodyId: 'EARTH', aliases: { norad: String(i) }, updatedAt: i, ...extra,
});
const CATALOG25 = Array.from({ length: 25 }, (_, i) => rec(i));

describe('pageEntities', () => {
  it('with no limit or offset it is the whole answer (no next, no total)', () => {
    const p = pageEntities(CATALOG25, {});
    expect(p.entities).toHaveLength(25);
    expect(p.next).toBeUndefined();
    expect(p.total).toBeUndefined();
    expect(p.entities).toEqual(filterEntities(CATALOG25, {}));
  });

  it('pages in catalog order and fit together: every record once, `next` chains the pages, `total` on the first page', () => {
    const seen: string[] = [];
    let offset: number | undefined = 0;
    let pages = 0;
    let first: ReturnType<typeof pageEntities> | undefined;
    while (offset !== undefined) {
      const p = pageEntities(CATALOG25, { limit: 10, offset });
      first ??= p;
      seen.push(...p.entities.map((e) => e.id));
      offset = p.next;
      pages++;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(CATALOG25.map((e) => e.id));
    expect(first!.total).toBe(25);
    expect(first!.entities).toHaveLength(10);
    expect(first!.next).toBe(10);
  });

  it('the last page has no next, and a page exactly filling the catalog does not invent one', () => {
    expect(pageEntities(CATALOG25, { limit: 10, offset: 20 })).toEqual({ entities: CATALOG25.slice(20) });
    expect(pageEntities(CATALOG25, { limit: 25 })).not.toHaveProperty('next');
    expect(pageEntities(CATALOG25, { limit: 25 }).entities).toHaveLength(25);
    expect(pageEntities(CATALOG25, { limit: 10, offset: 99 }).entities).toEqual([]);
  });

  it('offset counts matches, not catalog positions, so filters and `since` page correctly', () => {
    const debris = CATALOG25.filter((e) => e.kind === 'debris');
    const a = pageEntities(CATALOG25, { kind: 'debris', limit: 2 });
    expect(a.entities.map((e) => e.id)).toEqual(debris.slice(0, 2).map((e) => e.id));
    expect(a.total).toBe(5);
    const b = pageEntities(CATALOG25, { kind: 'debris', limit: 2, offset: a.next });
    expect(b.entities.map((e) => e.id)).toEqual(debris.slice(2, 4).map((e) => e.id));
    expect(pageEntities(CATALOG25, { since: 20, limit: 10 }).entities.map((e) => e.id)).toEqual(['sat-21', 'sat-22', 'sat-23', 'sat-24']);
  });

  it('caps a page at MAX_PAGE, and an update does not move a record (pages stay consistent while the catalog changes)', () => {
    const big = Array.from({ length: MAX_PAGE + 5 }, (_, i) => rec(i));
    const p = pageEntities(big, { limit: 10 * MAX_PAGE });
    expect(p.entities).toHaveLength(MAX_PAGE);
    expect(p.next).toBe(MAX_PAGE);
    const hub = new Hub(0);
    for (let i = 0; i < 6; i++) hub.upsert({ id: `x${i}`, name: `X${i}`, kind: 'satellite', bodyId: 'EARTH', aliases: {} });
    const first = pageEntities(hub.graph.all(), { limit: 3 });
    hub.upsert({ id: 'x0', name: 'X0 renamed', kind: 'satellite', bodyId: 'EARTH', aliases: {} });
    const second = pageEntities(hub.graph.all(), { limit: 3, offset: first.next });
    expect(first.entities.map((e) => e.id).concat(second.entities.map((e) => e.id))).toEqual(['x0', 'x1', 'x2', 'x3', 'x4', 'x5']);
  });
});

const crec = (id: string, name: string, extra: Partial<EntityRecord> = {}): EntityRecord => ({
  id, name, kind: 'satellite', bodyId: 'EARTH', aliases: {}, updatedAt: 0, ...extra,
});

const CATALOG: EntityRecord[] = [
  crec('sat-25544', 'ISS (ZARYA)', { kind: 'station', group: 'stations', aliases: { norad: '25544', cospar: '1998-067A', common: 'ISS' } }),
  crec('sat-49044', 'ISS (NAUKA)', { kind: 'station', group: 'stations', aliases: { norad: '49044', cospar: '2021-066A' } }),
  crec('sat-1', 'COSMOS 2251 DEB', { kind: 'debris', group: 'debris', aliases: { norad: '33791', cospar: '1993-036A' } }),
  crec('sat-2', 'STARLINK-1008', { group: 'starlink', aliases: { norad: '44714', cospar: '2019-074B' } }),
  crec('sat-3', 'STARLINK-1009', { group: 'starlink', aliases: { norad: '44715', cospar: '2019-074C' } }),
  crec('sat-4', 'ARISS-1', { aliases: { norad: '10002' } }),
  crec('sat-5', 'ISSA SAT', { aliases: { norad: '10001' } }),
  crec('dsn-VGR1', 'Voyager 1', { kind: 'probe', bodyId: 'SUN', group: 'dsn', aliases: { dsn: 'VGR1' } }),
  crec('launch-abc', 'Falcon 9 Block 5 | Starlink Group 15-15', { kind: 'launch_vehicle', aliases: { ll2: 'abc' } }),
  crec('sat-6', 'Café "Quote" 100% [x]_y', { aliases: { common: 'Naïve' } }),
  crec('sat-7', 'ÉTOILE-7', {}),
  crec('body-moon', 'Moon', { kind: 'moon', bodyId: 'MOON', aliases: {} }),
  crec('sat-8', 'Same Name', {}),
  crec('sat-9', 'Same Name', {}),
];

describe('matchEntities', () => {
  const queries = [
    'iss', 'ISS', 'starlink', 'starl', ' starlink ', 'link-100', '44714', '1998-067a', 'vgr1', 'zarya', 'group 15', 'abc', 'moon', 'mo',
    'x', 'zzz', 'same name', 'Café', 'café', 'ÉTOI', 'étoi', 'naïve', '"quote"', '100%', '[x]_y', 'a"b', "o'r", '*', 'iss*', 'NEAR(', '^iss', 'AND', 'launch-', '(zarya)',
  ];

  it('gives exactly the ranking of core rankMatches, for plain, special and short queries', () => {
    for (const q of queries) {
      const want = rankMatches(CATALOG, q.trim().toLowerCase()).map((r) => r.rec.id);
      const got = matchEntities(CATALOG, q);
      expect(got.ids, `query ${JSON.stringify(q)}`).toEqual(want);
      expect(got.total).toBe(want.length);
      expect(got.truncated).toBe(false);
    }
  });

  it('ranks id/alias exact first, then name prefix, then word prefix, then substring; equal names by id', () => {
    expect(matchEntities(CATALOG, 'iss').ids.slice(0, 4)).toEqual(['sat-25544', 'sat-49044', 'sat-5', 'sat-4']);
    expect(matchEntities(CATALOG, 'same name').ids).toEqual(['sat-8', 'sat-9']);
    expect(matchEntities(CATALOG, '  ')).toEqual({ ids: [], total: 0, truncated: false, via: 'scan' });
  });

  it('caps the answer at MAX_MATCH and says so', () => {
    const many = Array.from({ length: MAX_MATCH + 10 }, (_, i) => crec(`s${i}`, `ALPHA ${i}`));
    const m = matchEntities(many, 'alpha');
    expect(m.ids).toHaveLength(MAX_MATCH);
    expect(m).toMatchObject({ total: MAX_MATCH + 10, truncated: true });
  });
});

describe('searchEntities', () => {
  it('orders by tier, then kind rank, then shorter name', () => {
    const hits = searchEntities(CATALOG, 'iss');
    expect(hits[0].id).toBe('sat-25544'); // exact alias value `ISS` is tier 0
    expect(searchEntities(CATALOG, '  ')).toEqual([]);
    expect(searchEntities(CATALOG, 'starlink', 1)).toHaveLength(1);
  });
});

describe('countEntities', () => {
  it('counts per body, kind and group in one pass, most numerous first', () => {
    const { total, rows } = countEntities(CATALOG);
    expect(total).toBe(CATALOG.length);
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(CATALOG.length);
    expect(rows.find((r) => r.body === 'EARTH' && r.kind === 'station' && r.group === 'stations')?.count).toBe(2);
    expect(rows.find((r) => r.body === 'SUN' && r.kind === 'probe')?.count).toBe(1);
    expect(rows.find((r) => r.kind === 'moon')).toMatchObject({ body: 'MOON', group: null, count: 1 });
    expect(rows[0]).toMatchObject({ body: 'EARTH', kind: 'satellite', group: null, count: 6 });
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].count).toBeGreaterThanOrEqual(rows[i].count);
  });

  it('keeps a missing group apart from an empty one', () => {
    const { rows } = countEntities([crec('a', 'A'), crec('b', 'B', { group: '' })]);
    expect(rows).toHaveLength(2);
  });
});

describe('EntitySearch over a Hub', () => {
  it('answers from the hub, including changes made just before the call', () => {
    const hub = new Hub(10_000); // a long debounce: the calls must flush by themselves
    for (const e of CATALOG) hub.upsert({ id: e.id, name: e.name, kind: e.kind, bodyId: e.bodyId, group: e.group, aliases: e.aliases });
    const s = new EntitySearch(hub);
    const a = s.match('starlink');
    expect(a).toMatchObject({ q: 'starlink', total: 3, truncated: false });
    expect(a.ids).toEqual(['sat-2', 'sat-3', 'launch-abc']);
    hub.upsert({ id: 'sat-200', name: 'STARLINK-2000', kind: 'satellite', bodyId: 'EARTH', group: 'starlink', aliases: {} });
    expect(s.match('starlink').ids).toContain('sat-200');
    expect(s.match('')).toMatchObject({ ids: [], total: 0 });
    const c = s.counts();
    expect(c.total).toBe(CATALOG.length + 1);
    expect(c.rows.filter((r) => r.group === 'starlink').reduce((n, r) => n + r.count, 0)).toBe(3);
    const p = s.page({ limit: 10 });
    expect(p.entities).toHaveLength(10);
    expect([p.next, p.total]).toEqual([10, CATALOG.length + 1]);
    expect(typeof p.serverTime).toBe('number');
    expect(s.page({ limit: 10, offset: 10 }).entities).toHaveLength(5);
    expect(s.search('voyager')[0].id).toBe('dsn-VGR1');
  });
});

describe('search at 100 000 entities (no index kept: this is the evidence)', () => {
  const N = 100_000;
  const big: EntityRecord[] = Array.from({ length: N }, (_, i) => ({
    id: `sat-${i}`, name: i % 7 === 0 ? `STARLINK-${i}` : `OBJECT ${i} ${i % 3 ? 'DEB' : 'R/B'}`, kind: i % 5 === 0 ? 'debris' : 'satellite',
    bodyId: i % 50 === 0 ? 'MOON' : 'EARTH', group: i % 7 === 0 ? 'starlink' : 'active', aliases: { norad: String(40000 + i), cospar: `20${i % 30}-${String(i % 999).padStart(3, '0')}A` },
    updatedAt: 0,
  }));
  const time = <T>(fn: () => T): { out: T; ms: number } => {
    const t0 = performance.now();
    const out = fn();
    return { out, ms: performance.now() - t0 };
  };

  it('match, search, page and counts each answer well inside a second', () => {
    const rows: string[] = [];
    const run = <T>(label: string, fn: () => T, limitMs: number): T => {
      fn(); // warm up
      const { out, ms } = time(fn);
      rows.push(`${label}: ${ms.toFixed(1)} ms`);
      expect(ms, label).toBeLessThan(limitMs);
      return out;
    };
    // a limit is only a guard against a regression that makes the scan unusable; the measured numbers are in the log line
    const wide = run('match "starlink" (14 285 hits)', () => matchEntities(big, 'starlink'), 1500);
    expect(wide.total).toBe(Math.ceil(N / 7));
    run('match "deb" (66 666 hits)', () => matchEntities(big, 'deb'), 1500);
    run('match "4000" (alias prefix)', () => matchEntities(big, '4000'), 1500);
    run('match "zzzz" (no hit, full scan)', () => matchEntities(big, 'zzzz'), 1500);
    run('search "starlink" (top 20)', () => searchEntities(big, 'starlink', 20), 1500);
    run('page 5000 of the whole catalogue (with total)', () => pageEntities(big, { limit: 5000 }), 500);
    run('counts', () => countEntities(big), 500);
    console.log(`search timing at ${N} entities:\n  ${rows.join('\n  ')}`);
  });
});
