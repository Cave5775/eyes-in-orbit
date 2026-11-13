import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerApi } from '../src/api';
import { Http } from '../src/http';
import { Hub } from '../src/hub';
import { IMAGERY_LAYER, ImageryCache, NEGATIVE_CACHE_MS, parseTile, tileBbox, tileUrl } from '../src/imagery';
import { Limiter } from '../src/net/limiter';
import { LIMITS } from '../src/net/limits';
import { Store } from '../src/store';

/** allows everything: most tests here are about tiles, the limits are tested below and in limiter.test.ts */
const noLimits = () => new Limiter(new Store(':memory:'), { limits: {} });

const jpeg = (n = 4000, fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, fill)]);
const okResponse = (buf: Buffer) => new Response(new Uint8Array(buf), { status: 200, headers: { 'content-type': 'image/jpeg' } });

describe('tile grid', () => {
  it('accepts only tiles inside the grid and the supported levels', () => {
    expect(parseTile('3', '0', '0')).toEqual({ z: 3, x: 0, y: 0 });
    expect(parseTile('3', '15', '7')).toEqual({ z: 3, x: 15, y: 7 });
    expect(parseTile('6', '127', '63')).toEqual({ z: 6, x: 127, y: 63 });
    expect(parseTile('3', '16', '0')).toBeNull(); // 2^(z+1) = 16 columns
    expect(parseTile('3', '0', '8')).toBeNull(); // 2^z = 8 rows
    expect(parseTile('2', '0', '0')).toBeNull(); // coarser than the base map
    expect(parseTile('7', '0', '0')).toBeNull(); // finer than the layer's own resolution
    expect(parseTile('3', '-1', '0')).toBeNull();
    expect(parseTile('3', '1.5', '0')).toBeNull();
    expect(parseTile('3', 'abc', '0')).toBeNull();
    expect(parseTile('3', '../1', '0')).toBeNull();
    expect(parseTile(undefined, '0', '0')).toBeNull();
  });

  it('covers the globe with square tiles, row 0 at the north pole', () => {
    expect(tileBbox({ z: 3, x: 0, y: 0 })).toEqual([-180, 67.5, -157.5, 90]);
    expect(tileBbox({ z: 3, x: 15, y: 7 })).toEqual([157.5, -90, 180, -67.5]);
    // a level-6 tile is 2.8125 degrees on a side (the Cape Canaveral tile is 35 / 21)
    const [w, s, e, n] = tileBbox({ z: 6, x: 35, y: 21 });
    expect(e - w).toBeCloseTo(2.8125, 9);
    expect(n - s).toBeCloseTo(2.8125, 9);
    expect(w).toBeCloseTo(-180 + 35 * 2.8125, 9);
    expect(n).toBeCloseTo(90 - 21 * 2.8125, 9);
  });

  it('asks GIBS for a 512 pixel JPEG of the bathymetry layer over that box', () => {
    const url = new URL(tileUrl({ z: 3, x: 0, y: 0 }));
    expect(url.hostname).toBe('gibs.earthdata.nasa.gov');
    expect(url.searchParams.get('LAYERS')).toBe(IMAGERY_LAYER);
    expect(url.searchParams.get('FORMAT')).toBe('image/jpeg');
    expect(url.searchParams.get('SRS')).toBe('EPSG:4326');
    expect(url.searchParams.get('WIDTH')).toBe('512');
    expect(url.searchParams.get('HEIGHT')).toBe('512');
    expect(url.searchParams.get('BBOX')).toBe('-180,67.5,-157.5,90');
  });
});

describe('ImageryCache', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eio-imagery-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('downloads a tile once, then serves it from disk', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => okResponse(jpeg()));
    const cache = new ImageryCache(dir, { limiter: noLimits(), fetch: fetchMock });
    const id = { z: 4, x: 3, y: 2 };
    const a = await cache.get(id);
    const b = await cache.get(id);
    expect(a!.length).toBe(4004);
    expect(b!.equals(a!)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, IMAGERY_LAYER, '4', '3', '2.jpg'))).toBe(true);
    // a new cache object (a server restart) still finds it
    const fresh = vi.fn<typeof fetch>();
    expect((await new ImageryCache(dir, { limiter: noLimits(), fetch: fresh }).get(id))!.length).toBe(4004);
    expect(fresh).not.toHaveBeenCalled();
  });

  it('shares one download between simultaneous requests for the same tile', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.fn<typeof fetch>(async () => {
      await gate;
      return okResponse(jpeg());
    });
    const cache = new ImageryCache(dir, { limiter: noLimits(), fetch: fetchMock });
    const all = Promise.all([1, 2, 3].map(() => cache.get({ z: 5, x: 1, y: 1 })));
    release();
    const bufs = await all;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bufs.every((b) => b!.length === 4004)).toBe(true);
  });

  it('limits simultaneous requests to NASA', async () => {
    let active = 0, peak = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return okResponse(jpeg());
    });
    const cache = new ImageryCache(dir, { limiter: noLimits(), fetch: fetchMock, concurrency: 2 });
    await Promise.all(Array.from({ length: 8 }, (_, i) => cache.get({ z: 5, x: i, y: 0 })));
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('serves only what is on disk when OFFLINE=1', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => okResponse(jpeg()));
    await new ImageryCache(dir, { limiter: noLimits(), fetch: fetchMock }).get({ z: 3, x: 1, y: 1 });
    const offline = new ImageryCache(dir, { limiter: noLimits(), fetch: fetchMock, offline: true });
    expect((await offline.get({ z: 3, x: 1, y: 1 }))!.length).toBe(4004);
    expect(await offline.get({ z: 3, x: 2, y: 2 })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects errors and non-JPEG answers without caching them', async () => {
    const id = { z: 3, x: 5, y: 3 };
    const notFound = new ImageryCache(dir, { limiter: noLimits(), fetch: vi.fn<typeof fetch>(async () => new Response('nope', { status: 503 })) });
    await expect(notFound.get(id)).rejects.toThrow(/HTTP 503/);
    const xml = new ImageryCache(dir, { limiter: noLimits(), fetch: vi.fn<typeof fetch>(async () => new Response('<ServiceException>bad layer</ServiceException>'.padEnd(2000, ' '), { headers: { 'content-type': 'text/xml' } })) });
    await expect(xml.get(id)).rejects.toThrow(/not a JPEG/);
    expect(existsSync(join(dir, IMAGERY_LAYER, '3', '5', '3.jpg'))).toBe(false);
    // the failure is not remembered: the next request tries again
    const ok = new ImageryCache(dir, { limiter: noLimits(), fetch: vi.fn<typeof fetch>(async () => okResponse(jpeg())) });
    expect((await ok.get(id))!.length).toBe(4004);
  });

  it('negative-caches a failed tile for 10 min and does not ask NASA again meanwhile', async () => {
    let t = Date.parse('2026-11-01T10:00:00Z');
    const failing = vi.fn<typeof fetch>(async () => new Response('x', { status: 500 }));
    const cache = new ImageryCache(dir, { limiter: noLimits(), fetch: failing, now: () => t });
    const id = { z: 3, x: 2, y: 1 };
    await expect(cache.get(id)).rejects.toThrow(/HTTP 500/);
    await expect(cache.get(id)).rejects.toThrow(/not retried for 10 min/);
    expect(failing).toHaveBeenCalledTimes(1);
    t += NEGATIVE_CACHE_MS + 1;
    await expect(cache.get(id)).rejects.toThrow(/HTTP 500/);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('uses the gibs source: HTTP 429 blocks it for 15 min, then tiles are refused without a request', async () => {
    const store = new Store(':memory:');
    const limiter = new Limiter(store, { limits: LIMITS });
    const throttled = vi.fn<typeof fetch>(async () => new Response('slow down', { status: 429 }));
    const cache = new ImageryCache(dir, { limiter, fetch: throttled });
    await expect(cache.get({ z: 3, x: 0, y: 0 })).rejects.toThrow(/HTTP 429/);
    await expect(cache.get({ z: 3, x: 1, y: 0 })).rejects.toThrow(/rate limited until/);
    expect(throttled).toHaveBeenCalledTimes(1);
    expect(limiter.status('gibs')).toMatchObject({ used: 1, cap: 1000, window: 'hour' });
    expect(limiter.status('gibs')!.blockedUntil).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it('deletes the least recently used tiles once the cap is passed', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => okResponse(jpeg(10_000)));
    const cache = new ImageryCache(dir, { limiter: noLimits(), fetch: fetchMock, maxBytes: 35_000, concurrency: 1 });
    for (let x = 0; x < 6; x++) {
      await cache.get({ z: 4, x, y: 0 });
      await new Promise((r) => setTimeout(r, 12)); // distinct modification times
    }
    const tile = (x: number) => join(dir, IMAGERY_LAYER, '4', String(x), '0.jpg');
    const left = readdirSync(join(dir, IMAGERY_LAYER, '4')).map(Number).filter((x) => existsSync(tile(x))).sort((a, b) => a - b);
    const bytes = left.reduce((n, x) => n + statSync(tile(x)).size, 0);
    expect(bytes).toBeLessThanOrEqual(35_000);
    expect(left).toContain(5); // the newest survives
    expect(left).not.toContain(0); // the oldest went first
  });
});

describe('GET /api/imagery/:z/:x/:y.jpg', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eio-imagery-api-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const build = async (cache: ImageryCache) => {
    const app = Fastify();
    const store = new Store(':memory:');
    registerApi(app, new Hub(0), new Http(store), store, undefined, cache);
    await app.ready();
    return app;
  };

  it('returns the tile as a cacheable JPEG', async () => {
    const app = await build(new ImageryCache(dir, { limiter: noLimits(), fetch: vi.fn<typeof fetch>(async () => okResponse(jpeg())) }));
    const res = await app.inject({ url: '/api/imagery/6/35/21.jpg' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toMatch(/max-age=\d+/);
    expect(res.rawPayload.length).toBe(4004);
    await app.close();
  });

  it('answers 400 for tiles outside the grid or malformed names, 404 offline when uncached, 502 when NASA fails', async () => {
    const app = await build(new ImageryCache(dir, { limiter: noLimits(), fetch: vi.fn<typeof fetch>(async () => new Response('x', { status: 500 })) }));
    for (const bad of ['/api/imagery/2/0/0.jpg', '/api/imagery/3/16/0.jpg', '/api/imagery/3/0/8.jpg', '/api/imagery/3/0/0.png', '/api/imagery/3/0/abc.jpg']) {
      expect((await app.inject({ url: bad })).statusCode, bad).toBe(400);
    }
    expect((await app.inject({ url: '/api/imagery/3/0/0.jpg' })).statusCode).toBe(502);
    await app.close();

    const off = await build(new ImageryCache(dir, { limiter: noLimits(), offline: true }));
    expect((await off.inject({ url: '/api/imagery/3/0/0.jpg' })).statusCode).toBe(404);
    await off.close();
  });
});
