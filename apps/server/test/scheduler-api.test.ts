import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerApi } from '../src/api';
import { loadConfig } from '../src/config';
import { Scheduler, type Connector } from '../src/connector';
import { Http } from '../src/http';
import { Hub } from '../src/hub';
import { Store } from '../src/store';

function setup(connectors: Connector[], env: NodeJS.ProcessEnv = {}) {
  const hub = new Hub(0);
  const store = new Store(':memory:');
  const fetchMock = vi.fn<typeof fetch>();
  const config = loadConfig(env);
  const http = new Http(store, { fetch: fetchMock, offline: config.offline });
  const scheduler = new Scheduler({ hub, config, store, http }, connectors, 0);
  return { hub, store, http, scheduler, fetchMock };
}

describe('scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls on its interval and records health', async () => {
    let n = 0;
    const { hub, scheduler } = setup([{ id: 'c', intervalMs: 10_000, run: async () => void n++ }]);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(n).toBe(1);
    expect(hub.healthOf('c')).toMatchObject({ status: 'ok', runs: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(n).toBe(2);
    scheduler.stop();
  });

  it('backs off exponentially after errors, then recovers', async () => {
    const calls: number[] = [];
    let fail = true;
    const { hub, scheduler } = setup([{
      id: 'c', intervalMs: 1000,
      run: async () => {
        calls.push(Date.now());
        if (fail) throw new Error('boom');
      },
    }]);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.healthOf('c')).toMatchObject({ status: 'error', lastError: 'boom' });
    await vi.advanceTimersByTimeAsync(20_000);
    const gaps = calls.slice(1).map((t, i) => t - calls[i]);
    expect(gaps.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    fail = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hub.healthOf('c').status).toBe('ok');
    expect(hub.healthOf('c').lastError).toBeUndefined();
    scheduler.stop();
  });

  it('runs topic-gated connectors only while the topic has subscribers', async () => {
    let n = 0;
    const { hub, scheduler } = setup([{ id: 'iss', intervalMs: 1000, topic: 'iss', run: async () => void n++ }]);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(n).toBe(0);
    expect(hub.healthOf('iss').status).toBe('idle');

    hub.subscribe('iss');
    await vi.advanceTimersByTimeAsync(3500);
    expect(n).toBeGreaterThanOrEqual(3);
    hub.unsubscribe('iss');
    const before = n;
    await vi.advanceTimersByTimeAsync(5000);
    expect(n).toBeLessThanOrEqual(before + 1);
    expect(hub.healthOf('iss').status).toBe('idle');
    scheduler.stop();
  });

  it('marks stubs, and retries sooner when a fetch fell back to stale cache', async () => {
    const { hub, store, scheduler, fetchMock } = setup([
      { id: 'stubby', stub: () => 'later' },
      { id: 'cached', intervalMs: 3 * 3600_000, run: async (ctx) => void (await ctx.cachedFetch('k', 'https://x.test', 1000, String)) },
    ]);
    store.set('k', 'old', 1000, Date.now() - 10_000);
    fetchMock.mockRejectedValue(new Error('down'));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.healthOf('stubby')).toMatchObject({ status: 'stub', note: 'later', runs: 0 });
    expect(hub.healthOf('cached')).toMatchObject({ status: 'ok', fromCache: true, lastError: 'down' });
    const next = hub.healthOf('cached').nextRunAt! - Date.now();
    expect(next).toBeLessThanOrEqual(5 * 60_000);
    scheduler.stop();
  });

  it('OFFLINE=1 runs network connectors once and reports disabled without a cache', async () => {
    let n = 0;
    const { hub, scheduler } = setup(
      [
        { id: 'net', intervalMs: 1000, run: async (ctx) => { n++; await ctx.cachedFetch('k', 'https://x.test', 1000, String); } },
        { id: 'local', intervalMs: 1000, network: false, run: async () => void n++ },
      ],
      { OFFLINE: '1' },
    );
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(hub.healthOf('net').status).toBe('disabled');
    expect(hub.healthOf('net').runs).toBe(1);
    expect(hub.healthOf('local').runs).toBeGreaterThan(1);
    scheduler.stop();
  });
});

describe('api', () => {
  async function app() {
    const { hub, http } = setup([]);
    hub.upsert(
      { id: 'sat-25544', name: 'ISS (ZARYA)', kind: 'station', bodyId: 'EARTH', aliases: { norad: '25544' }, group: 'stations', links: { newsQuery: 'International Space Station' } },
      { id: 'sat-1', name: 'STARLINK-1', kind: 'satellite', bodyId: 'EARTH', aliases: { norad: '1' }, group: 'starlink' },
    );
    const server = Fastify();
    registerApi(server, hub, http);
    return { hub, server };
  }

  it('serves the contract routes', async () => {
    const { hub, server } = await app();
    const get = async (url: string) => (await server.inject({ url })).json();

    expect(await get('/api/health')).toMatchObject({ entityCount: 2, connectors: [] });
    expect((await get('/api/entities')).entities).toHaveLength(2);
    expect((await get('/api/entities?kind=station')).entities.map((e: any) => e.id)).toEqual(['sat-25544']);
    expect((await get('/api/entities?group=starlink&limit=5')).entities).toHaveLength(1);
    expect((await get(`/api/entities?since=${Date.now() + 1000}`)).entities).toEqual([]);
    expect(await get('/api/entities/sat-25544')).toMatchObject({ name: 'ISS (ZARYA)' });
    expect((await server.inject({ url: '/api/entities/nope' })).statusCode).toBe(404);
    expect((await get('/api/search?q=25544'))[0]).toMatchObject({ id: 'sat-25544', kind: 'station' });
    expect(await get('/api/launches')).toEqual({ launches: [] });
    expect(await get('/api/dsn')).toEqual({ fetchedAt: 0, links: [] });
    expect(await get('/api/iss')).toEqual({ telemetry: [] });
    expect((await get('/api/bodies')).map((b: any) => b.id)).toEqual(['SUN', 'EARTH', 'MOON', 'MARS']);

    hub.setArticles([{ id: 1, title: 't', url: 'u', site: 's', publishedAt: 'p' }]);
    expect((await get('/api/news')).articles).toHaveLength(1);
    expect((await server.inject({ url: '/api/news?entity=nope' })).statusCode).toBe(404);
  });

  it('news with entity or q searches SNAPI using the entity newsQuery', async () => {
    const { hub, server } = await app();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ results: [{ id: 9, title: 'x', url: 'u', news_site: 's', published_at: 'p', launches: [] }] })));
    const http = new Http(new Store(':memory:'), { fetch: fetchMock });
    const s2 = Fastify();
    registerApi(s2, hub, http);

    const res = await s2.inject({ url: '/api/news?entity=sat-25544&limit=3' });
    expect(res.json().articles[0].id).toBe(9);
    expect(String(fetchMock.mock.calls[0][0])).toContain('search=International+Space+Station');
    expect(String(fetchMock.mock.calls[0][0])).toContain('limit=3');
    await s2.inject({ url: '/api/news?entity=sat-25544&limit=3' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // cached for 10 min
    await server.close();
  });
});
