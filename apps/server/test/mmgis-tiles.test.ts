import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { mmgisLayer } from '@eio/core';
import { MmgisTiles, TILE_KEY_PREFIX, TILE_NEGATIVE_MS, TILE_TTL_MS, registerMmgisTiles, tileKey } from '../src/mmgis-tiles';
import { Limiter } from '../src/net/limiter';
import { LIMITS } from '../src/net/limits';
import { Store } from '../src/store';

// a real tile (Perseverance's area, colour basemap level 11, fetched 2026-11-17); the web mock serves the same file
const PNG = readFileSync(new URL('../../web/src/mock/fixtures/mmgis-tiles/m20-color-11-1463-1130.png', import.meta.url));
const URL_1463 = 'https://mars.nasa.gov/mmgis-maps/M20/Layers/M20_HiRISE_RGB_CTX_mosaic_25cm_v7_Merge_LERC_clip/11/1463/1130.png';
const ROUTE = '/api/tiles/mmgis/M20/color/11/1463/1130.png';

const noLimits = (store = new Store(':memory:')) => new Limiter(store, { limits: {} });
const png = () => new Response(new Uint8Array(PNG), { status: 200, headers: { 'content-type': 'image/png' } });

async function build(opts: { fetch: typeof fetch; store?: Store; offline?: boolean; now?: () => number; limiter?: Limiter }) {
  const store = opts.store ?? new Store(':memory:');
  const tiles = new MmgisTiles({ store, limiter: opts.limiter ?? noLimits(), fetch: opts.fetch, offline: opts.offline, now: opts.now });
  const app = Fastify();
  registerMmgisTiles(app, tiles);
  await app.ready();
  return { app, store, tiles };
}

describe('GET /api/tiles/mmgis/:mission/:layer/:z/:x/:y.png', () => {
  it('fetches a miss once from NASA, stores the PNG in SQLite and serves it from there afterwards', async () => {
    const f = vi.fn<typeof fetch>(async () => png());
    const { app, store, tiles } = await build({ fetch: f });
    const a = await app.inject({ url: ROUTE });
    expect(a.statusCode).toBe(200);
    expect(a.headers['content-type']).toBe('image/png');
    expect(a.headers['x-eio-cache']).toBe('miss');
    expect(a.rawPayload.equals(PNG)).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe(URL_1463);
    expect((f.mock.calls[0][1]?.headers as Record<string, string>)['user-agent']).toMatch(/^EyesInOrbit/);
    const b = await app.inject({ url: ROUTE });
    expect(b.headers['x-eio-cache']).toBe('hit');
    expect(b.rawPayload.equals(PNG)).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    const row = store.getBlob(tileKey(mmgisLayer('M20', 'color')!, 11, 1463, 1130));
    expect(row?.value.equals(PNG)).toBe(true);
    expect(row?.ttlMs).toBe(TILE_TTL_MS);
    expect(tiles.stats()).toEqual({ count: 1, bytes: PNG.length });
    await app.close();
  });

  it('is no open proxy: unknown layers, other levels, tiles outside the box and odd names never reach NASA', async () => {
    const f = vi.fn<typeof fetch>(async () => png());
    const { app } = await build({ fetch: f });
    for (const [url, code] of [
      ['/api/tiles/mmgis/M20/labels/11/1463/1130.png', 404],
      ['/api/tiles/mmgis/M2020/color/11/1463/1130.png', 404],
      ['/api/tiles/mmgis/M20/color/9/731/565.png', 400], // under the layer's first level
      ['/api/tiles/mmgis/M20/color/20/0/0.png', 400],
      ['/api/tiles/mmgis/M20/color/11/1400/1130.png', 400], // outside the bounding box
      ['/api/tiles/mmgis/M20/color/11/1463/917.png', 400], // the XYZ row: TMS counts from the south
      ['/api/tiles/mmgis/M20/color/11/1463/1130.jpg', 400],
      ['/api/tiles/mmgis/M20/color/11/-1/1130.png', 400],
      ['/api/tiles/mmgis/M20/color/11/1463/..%2F1130.png', 400],
    ] as const) {
      expect((await app.inject({ url })).statusCode, url).toBe(code);
    }
    expect(f).not.toHaveBeenCalled();
    await app.close();
  });

  it('OFFLINE=1: a stored tile is served at any age, a missing one is 404 without a request', async () => {
    const store = new Store(':memory:');
    store.setBlob(tileKey(mmgisLayer('M20', 'color')!, 11, 1463, 1130), PNG, TILE_TTL_MS, Date.now() - 2 * TILE_TTL_MS);
    const f = vi.fn<typeof fetch>(async () => png());
    const { app } = await build({ fetch: f, store, offline: true });
    const a = await app.inject({ url: ROUTE });
    expect(a.statusCode).toBe(200);
    expect(a.headers['x-eio-cache']).toBe('stale');
    expect((await app.inject({ url: '/api/tiles/mmgis/M20/color/11/1464/1130.png' })).statusCode).toBe(404);
    expect(f).not.toHaveBeenCalled();
    await app.close();
  });

  it('an expired tile is renewed by a conditional request (304) and served stale when NASA fails', async () => {
    const store = new Store(':memory:');
    const key = tileKey(mmgisLayer('M20', 'color')!, 11, 1463, 1130);
    const old = Date.now() - TILE_TTL_MS - 1000;
    store.setBlob(key, PNG, TILE_TTL_MS, old);
    const notModified = vi.fn<typeof fetch>(async () => new Response(null, { status: 304 }));
    const one = await build({ fetch: notModified, store });
    const a = await one.app.inject({ url: ROUTE });
    expect(a.statusCode).toBe(200);
    expect((notModified.mock.calls[0][1]?.headers as Record<string, string>)['if-modified-since']).toBe(new Date(old).toUTCString());
    expect(store.getBlob(key)!.fetchedAt).toBeGreaterThan(old);
    await one.app.close();

    store.setBlob(key, PNG, TILE_TTL_MS, old);
    const failing = vi.fn<typeof fetch>(async () => new Response('oops', { status: 500 }));
    const two = await build({ fetch: failing, store });
    const b = await two.app.inject({ url: ROUTE });
    expect(b.statusCode).toBe(200);
    expect(b.headers['x-eio-cache']).toBe('stale');
    await two.app.close();
  });

  it('a refused tile (S3 403) is 404 and not asked for again for 30 min; a non-PNG answer is 502', async () => {
    let t = Date.now();
    const refused = vi.fn<typeof fetch>(async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }));
    const { app } = await build({ fetch: refused, now: () => t });
    expect((await app.inject({ url: ROUTE })).statusCode).toBe(404);
    expect((await app.inject({ url: ROUTE })).statusCode).toBe(404);
    expect(refused).toHaveBeenCalledTimes(1);
    t += TILE_NEGATIVE_MS + 1;
    await app.inject({ url: ROUTE });
    expect(refused).toHaveBeenCalledTimes(2);
    await app.close();

    const html = vi.fn<typeof fetch>(async () => new Response('<html>maintenance</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const other = await build({ fetch: html });
    const r = await other.app.inject({ url: ROUTE });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/not a PNG/);
    await other.app.close();
  });

  it('uses its own limiter source: HTTP 429 blocks it for 15 min and later tiles get 429 without a request', async () => {
    const store = new Store(':memory:');
    const limiter = new Limiter(store, { limits: LIMITS });
    const throttled = vi.fn<typeof fetch>(async () => new Response('slow down', { status: 429 }));
    const { app } = await build({ fetch: throttled, store, limiter });
    expect((await app.inject({ url: ROUTE })).statusCode).toBe(502);
    const r = await app.inject({ url: '/api/tiles/mmgis/M20/color/11/1464/1130.png' });
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(14 * 60);
    expect(throttled).toHaveBeenCalledTimes(1);
    expect(limiter.status('mmgis-tiles')!.blockedUntil).toBeGreaterThan(Date.now() + 14 * 60_000);
    // the waypoint feed of the same host is a separate source and stays open
    expect(limiter.status('mmgis')?.blockedUntil).toBeUndefined();
    await app.close();
  });

  it('5 refusals within 10 min stop the source for an hour', async () => {
    const store = new Store(':memory:');
    const limiter = new Limiter(store, { limits: { 'mmgis-tiles': { ...LIMITS['mmgis-tiles'], minSpacingMs: 0 } } });
    const refused = vi.fn<typeof fetch>(async () => new Response('denied', { status: 403 }));
    const tiles = new MmgisTiles({ store, limiter, fetch: refused });
    const l = mmgisLayer('M20', 'syrtis')!;
    for (let x = 0; x < 5; x++) await expect(tiles.get(l, 12, 2816 + x, 2234)).rejects.toThrow(/no such tile/);
    await expect(tiles.get(l, 12, 2830, 2234)).rejects.toThrow(/until/);
    expect(refused).toHaveBeenCalledTimes(5);
    expect(limiter.status('mmgis-tiles')!.blockedUntil).toBeGreaterThan(Date.now() + 55 * 60_000);
  });

  it('one download for simultaneous requests of the same tile', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const f = vi.fn<typeof fetch>(async () => { await gate; return png(); });
    const { tiles } = await build({ fetch: f });
    const l = mmgisLayer('M20', 'color')!;
    const both = Promise.all([tiles.get(l, 11, 1463, 1130), tiles.get(l, 11, 1463, 1130)]);
    release();
    const [a, b] = await both;
    expect(a!.data.equals(PNG) && b!.data.equals(PNG)).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('Store binary rows', () => {
  it('trims the least recently used rows under a prefix down to 90 % of the cap', () => {
    const store = new Store(':memory:');
    const now = Date.now();
    for (let i = 0; i < 6; i++) store.setBlob(`${TILE_KEY_PREFIX}t${i}`, Buffer.alloc(10_000, i), TILE_TTL_MS, now + i * 120_000);
    store.setBlob('other:x', Buffer.alloc(50_000), TILE_TTL_MS, now);
    store.getBlob(`${TILE_KEY_PREFIX}t0`, now + 10 * 120_000); // t0 used last
    expect(store.trimBlobs(TILE_KEY_PREFIX, 35_000)).toBe(3);
    const left = [0, 1, 2, 3, 4, 5].filter((i) => store.getBlob(`${TILE_KEY_PREFIX}t${i}`));
    expect(left).toEqual([0, 4, 5]);
    expect(store.blobStats(TILE_KEY_PREFIX)).toEqual({ count: 3, bytes: 30_000 });
    expect(store.getBlob('other:x')).toBeDefined(); // another prefix is not touched
    expect(store.trimBlobs(TILE_KEY_PREFIX, 35_000)).toBe(0);
  });
});
