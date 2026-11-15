import type { EntityRecord } from '@eio/core';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerApi } from '../src/api';
import { Http } from '../src/http';
import { Hub } from '../src/hub';
import { Store } from '../src/store';
import { MAX_PAGE, filterEntities, pageEntities } from '../src/search';

const rec = (i: number, extra: Partial<EntityRecord> = {}): EntityRecord => ({
  id: `sat-${i}`, name: `SAT ${i}`, kind: i % 5 === 0 ? 'debris' : 'satellite', bodyId: 'EARTH', aliases: { norad: String(i) }, updatedAt: i, ...extra,
});
const CATALOG = Array.from({ length: 25 }, (_, i) => rec(i));

describe('pageEntities', () => {
  it('with no limit or offset it is the whole answer, as before (no next, no total)', () => {
    const p = pageEntities(CATALOG, {});
    expect(p.entities).toHaveLength(25);
    expect(p.next).toBeUndefined();
    expect(p.total).toBeUndefined();
    expect(p.entities).toEqual(filterEntities(CATALOG, {}));
  });

  it('pages in catalog order and fit together: every record once, `next` chains the pages, `total` on the first page', () => {
    const seen: string[] = [];
    let offset: number | undefined = 0;
    let pages = 0;
    let first: ReturnType<typeof pageEntities> | undefined;
    while (offset !== undefined) {
      const p = pageEntities(CATALOG, { limit: 10, offset });
      first ??= p;
      seen.push(...p.entities.map((e) => e.id));
      offset = p.next;
      pages++;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(CATALOG.map((e) => e.id));
    expect(first!.total).toBe(25);
    expect(first!.entities).toHaveLength(10);
    expect(first!.next).toBe(10);
  });

  it('the last page has no next, and a page exactly filling the catalog does not invent one', () => {
    expect(pageEntities(CATALOG, { limit: 10, offset: 20 })).toEqual({ entities: CATALOG.slice(20) });
    expect(pageEntities(CATALOG, { limit: 25 })).not.toHaveProperty('next');
    expect(pageEntities(CATALOG, { limit: 25 }).entities).toHaveLength(25);
    expect(pageEntities(CATALOG, { limit: 10, offset: 99 }).entities).toEqual([]);
  });

  it('offset counts matches, not catalog positions, so filters and `since` page correctly', () => {
    const debris = CATALOG.filter((e) => e.kind === 'debris');
    const a = pageEntities(CATALOG, { kind: 'debris', limit: 2 });
    expect(a.entities.map((e) => e.id)).toEqual(debris.slice(0, 2).map((e) => e.id));
    expect(a.total).toBe(5);
    const b = pageEntities(CATALOG, { kind: 'debris', limit: 2, offset: a.next });
    expect(b.entities.map((e) => e.id)).toEqual(debris.slice(2, 4).map((e) => e.id));
    expect(pageEntities(CATALOG, { since: 20, limit: 10 }).entities.map((e) => e.id)).toEqual(['sat-21', 'sat-22', 'sat-23', 'sat-24']);
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

describe('GET /api/entities paging', () => {
  it('serves pages with serverTime, next and total, and the unpaged form is unchanged', async () => {
    const hub = new Hub(0);
    for (const e of CATALOG) hub.upsert({ id: e.id, name: e.name, kind: e.kind, bodyId: e.bodyId, aliases: e.aliases });
    const store = new Store(':memory:');
    const app = Fastify();
    registerApi(app, hub, new Http(store, { fetch: (async () => new Response('{}')) as typeof fetch }), store);
    const get = async (qs: string) => (await app.inject({ url: `/api/entities${qs}` })).json() as { serverTime: number; entities: EntityRecord[]; next?: number; total?: number };
    const whole = await get('');
    expect(whole.entities).toHaveLength(25);
    expect(whole).not.toHaveProperty('next');
    const p1 = await get('?limit=10');
    expect(p1.entities).toHaveLength(10);
    expect([p1.next, p1.total]).toEqual([10, 25]);
    expect(typeof p1.serverTime).toBe('number');
    const p3 = await get('?limit=10&offset=20');
    expect(p3.entities).toHaveLength(5);
    expect(p3).not.toHaveProperty('next');
    const junk = await get('?limit=abc&offset=-5');
    expect(junk.entities).toHaveLength(25);
    await app.close();
  });
});
