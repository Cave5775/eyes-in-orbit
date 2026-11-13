import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerApi } from '../src/api';
import { loadConfig } from '../src/config';
import { DescribeService } from '../src/describe/service';
import { Http } from '../src/http';
import { Hub } from '../src/hub';
import { ImageryCache } from '../src/imagery';
import { Limiter } from '../src/net/limiter';
import { LIMITS } from '../src/net/limits';
import { Store } from '../src/store';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('limited answers over the REST API', () => {
  it('/api/news answers 429 with Retry-After when the lookup limit is used up and nothing is cached, and never calls SNAPI', async () => {
    const store = new Store(':memory:');
    const limiter = new Limiter(store, { limits: LIMITS });
    limiter.block('snapi', 10 * 60_000, 'HTTP 429');
    const fetchMock = vi.fn<typeof fetch>();
    const http = new Http(store, { fetch: fetchMock, limiter });
    const app = Fastify();
    registerApi(app, new Hub(0), http);
    const res = await app.inject({ url: '/api/news?q=starship' });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(500);
    expect(res.json()).toMatchObject({ limited: true });
    expect(res.json().retryAt).toBeGreaterThan(Date.now());
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('/api/imagery answers 429 with Retry-After while NASA GIBS is blocked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eio-limits-'));
    dirs.push(dir);
    const store = new Store(':memory:');
    const limiter = new Limiter(store, { limits: LIMITS });
    limiter.block('gibs', 15 * 60_000, 'HTTP 503');
    const fetchMock = vi.fn<typeof fetch>();
    const app = Fastify();
    registerApi(app, new Hub(0), new Http(store, { limiter }), store, undefined, new ImageryCache(dir, { limiter, fetch: fetchMock }));
    const res = await app.inject({ url: '/api/imagery/3/0/0.jpg' });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(800);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('/api/describe returns the description with limitedUntil and does not cache it', async () => {
    const store = new Store(':memory:');
    const limiter = new Limiter(store, { limits: LIMITS });
    limiter.block('wikimedia', 5 * 60_000, 'HTTP 429');
    const hub = new Hub(0);
    hub.upsert({ id: 'sat-25544', name: 'ISS (ZARYA)', kind: 'station', bodyId: 'EARTH', aliases: { norad: '25544' }, group: 'stations' });
    hub.flush();
    const fetchMock = vi.fn<typeof fetch>();
    const http = new Http(store, { fetch: fetchMock, limiter });
    const svc = new DescribeService({ store, http, config: loadConfig({}), hub });
    const app = Fastify();
    registerApi(app, hub, http, store, undefined, undefined, svc);
    const res = await app.inject({ url: '/api/describe/sat-25544' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ entityId: 'sat-25544', sources: { wikidata: 'limited' } });
    expect(res.json().limitedUntil).toBeGreaterThan(Date.now());
    expect(res.json().fallback).toBeTruthy();
    expect(store.get('describe:v1:sat-25544')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });
});
