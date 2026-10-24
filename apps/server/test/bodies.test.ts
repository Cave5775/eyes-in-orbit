import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyEntityRecords } from '@eio/core';
import { registerApi } from '../src/api';
import { loadConfig } from '../src/config';
import { Scheduler } from '../src/connector';
import { bodies } from '../src/connectors/bodies';
import { Http } from '../src/http';
import { Hub } from '../src/hub';
import { Store } from '../src/store';

const IDS = bodyEntityRecords().map((b) => b.id).sort();

function setup(env: NodeJS.ProcessEnv = {}) {
  const hub = new Hub(0);
  const store = new Store(':memory:');
  const config = loadConfig(env);
  const http = new Http(store, { fetch: vi.fn<typeof fetch>(), offline: config.offline });
  const scheduler = new Scheduler({ hub, config, store, http }, [bodies], 0);
  const server = Fastify();
  registerApi(server, hub, http);
  const get = async (url: string) => (await server.inject({ url })).json();
  return { hub, scheduler, get };
}

describe('bodies connector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('registers the four body entities under OFFLINE=1 and runs once', async () => {
    const { hub, scheduler, get } = setup({ OFFLINE: '1' });
    await scheduler.start();
    // registered by start(), before any timer fires
    expect(hub.graph.all().map((e) => e.id).sort()).toEqual(IDS);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hub.healthOf('bodies')).toMatchObject({ status: 'ok', runs: 1, note: '4 bodies' });
    expect(hub.healthOf('bodies').nextRunAt).toBeUndefined();
    const moon = (await get('/api/entities/body-moon'));
    expect(moon).toMatchObject({
      kind: 'moon', group: 'bodies', parentId: 'body-earth', bodyId: 'EARTH', provider: { type: 'body', bodyId: 'MOON' },
    });
    expect(moon.createdAt).toBeGreaterThan(0);
    expect(moon.updatedAt).toBe(moon.createdAt);
    scheduler.stop();
  });

  it('sets createdAt once and keeps it; updatedAt only moves on a change', () => {
    const hub = new Hub(0);
    vi.setSystemTime(1_000);
    hub.upsert(...bodyEntityRecords());
    const first = hub.graph.get('body-mars')!;
    expect(first).toMatchObject({ createdAt: 1_000, updatedAt: 1_000 });

    vi.setSystemTime(5_000);
    expect(hub.upsert(...bodyEntityRecords())).toBe(0); // unchanged: ignored, nothing stamped
    expect(hub.graph.get('body-mars')).toMatchObject({ createdAt: 1_000, updatedAt: 1_000 });

    expect(hub.upsert({ ...bodyEntityRecords().find((b) => b.id === 'body-mars')!, name: 'Mars!' })).toBe(1);
    expect(hub.graph.get('body-mars')).toMatchObject({ name: 'Mars!', createdAt: 1_000, updatedAt: 5_000 });

    // a record that carries its own createdAt is honoured on first insert only
    hub.upsert({ id: 'x', name: 'X', kind: 'probe', bodyId: 'EARTH', aliases: {}, createdAt: 42 });
    hub.upsert({ id: 'x', name: 'X2', kind: 'probe', bodyId: 'EARTH', aliases: {}, createdAt: 99 });
    expect(hub.graph.get('x')).toMatchObject({ name: 'X2', createdAt: 42 });
  });

  it('serves bodies through the entity, search and filter routes; /api/bodies is the unchanged registry', async () => {
    const { scheduler, get } = setup();
    await scheduler.start();
    const ids = (r: { entities: { id: string }[] }) => r.entities.map((e) => e.id).sort();
    expect(ids(await get('/api/entities?group=bodies'))).toEqual(IDS);
    expect(ids(await get('/api/entities?kind=moon'))).toEqual(['body-moon']);
    expect(ids(await get('/api/entities?kind=planet'))).toEqual(['body-earth', 'body-mars']);
    expect(ids(await get('/api/entities?kind=star'))).toEqual(['body-sun']);
    expect(ids(await get('/api/entities?q=luna'))).toEqual(['body-moon']);

    const moon = await get('/api/search?q=moon');
    expect(moon[0]).toMatchObject({ id: 'body-moon', kind: 'moon', group: 'bodies' });
    expect((await get('/api/search?q=luna'))[0].id).toBe('body-moon');
    expect((await get('/api/search?q=MARS'))[0].id).toBe('body-mars');

    expect((await get('/api/bodies')).map((b: { id: string }) => b.id)).toEqual(['SUN', 'EARTH', 'MOON', 'MARS']);
    expect((await get('/api/health')).entityCount).toBe(4);
    scheduler.stop();
  });
});
