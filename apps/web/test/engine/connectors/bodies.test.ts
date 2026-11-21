import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyEntityRecords } from '@eio/core';
import { engineConfig } from '../../../src/engine/config';
import { bodies } from '../../../src/engine/connectors/bodies';
import { Http } from '../../../src/engine/http';
import { Hub } from '../../../src/engine/hub';
import { Limiter } from '../../../src/engine/net/limiter';
import { Scheduler } from '../../../src/engine/scheduler';
import { MemoryKv } from '../../../src/engine/store';

const IDS = bodyEntityRecords().map((b) => b.id).sort();

function setup(over: { offline?: boolean } = {}) {
  const hub = new Hub(0);
  const store = new MemoryKv();
  const config = engineConfig(over);
  const http = new Http(store, { fetch: vi.fn<typeof fetch>(), offline: config.offline, limiter: new Limiter(store, { limits: {} }) });
  const scheduler = new Scheduler({ hub, config, store, http }, [bodies], 0);
  return { hub, scheduler };
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

  it('registers the body entities (62: Sun, 8 planets, 5 dwarf planets, 11 asteroids, 37 moons including the Moon) when offline and runs once', async () => {
    const { hub, scheduler } = setup({ offline: true });
    await scheduler.start();
    // registered by start(), before any timer fires
    expect(hub.graph.all().map((e) => e.id).sort()).toEqual(IDS);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hub.healthOf('bodies')).toMatchObject({ status: 'ok', runs: 1, note: '62 bodies' });
    expect(hub.healthOf('bodies').nextRunAt).toBeUndefined();
    const moon = hub.graph.get('body-moon')!;
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
});
