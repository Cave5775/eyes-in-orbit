import { Readable } from 'node:stream';
import { gunzipSync, gzipSync, createGzip } from 'node:zlib';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { MPCORB_SAMPLE, designationText, readContainer } from '@eio/core';
import type { ConnectorContext } from '../src/connector';
import { CHUNK_SIZE, MPCORB_KEY, MPCORB_TTL_MS, MinorPlanetData, createMinorPlanets, packMpcorbGz, registerMinorPlanets } from '../src/connectors/minor-planets';
import { Limiter } from '../src/net/limiter';
import { LIMITS } from '../src/net/limits';
import { Store } from '../src/store';

// the header and 20 real lines of MPCORB.DAT (see the fixture), gzipped here like the .gz the MPC publishes
const GZ = gzipSync(Buffer.from(MPCORB_SAMPLE, 'latin1'));
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-18T12:00:00Z');

function ctxOf(store: Store, offline = false) {
  const health: Record<string, unknown> = {};
  const softFail = vi.fn();
  const ctx = { store, config: { offline }, http: { limiter: new Limiter(store, { limits: {} }) }, health, softFail } as unknown as ConnectorContext;
  return { ctx, health, softFail };
}
const answer = (status = 200, headers: Record<string, string> = { etag: '"abc"', 'last-modified': 'Tue, 17 Nov 2026 13:09:02 GMT' }) =>
  vi.fn<typeof fetch>(async () => new Response(status === 304 || status === 503 ? null : new Uint8Array(GZ), { status, headers }));

describe('minor-planets connector', () => {
  it('downloads once, stores ONE packed row (no text, no gz) and makes no request inside the 30 days', async () => {
    const store = new Store(':memory:');
    const f = answer();
    const c = createMinorPlanets({ fetch: f, minOrbits: 10, now: () => T0 });
    const { ctx, health } = ctxOf(store);
    await c.run!(ctx);
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0][1]?.headers as Record<string, string>)['user-agent']).toMatch(/^EyesInOrbit/);
    expect(f.mock.calls[0][0]).toBe('https://www.minorplanetcenter.net/iau/MPCORB/MPCORB.DAT.gz');
    expect(store.blobStats('').count).toBe(1);
    const row = store.getBlob(MPCORB_KEY)!;
    expect(row.ttlMs).toBe(MPCORB_TTL_MS);
    const u = readContainer(row.value);
    expect(u.count).toBe(20);
    expect(u.meta).toMatchObject({ parsed: 20, skipped: 0, etag: '"abc"', lastModified: 'Tue, 17 Nov 2026 13:09:02 GMT' });
    expect(row.value.length).toBeLessThan(MPCORB_SAMPLE.length); // the packed form, not the 8 kB of text
    expect(health.note).toMatch(/20 minor planets \(downloaded/);
    await c.run!(ctx);
    expect(f).toHaveBeenCalledTimes(1);
    expect(health.fromCache).toBe(true);
  });

  it('refreshes after the TTL with a conditional request: 304 renews the row, 200 replaces it', async () => {
    const store = new Store(':memory:');
    let t = T0;
    const first = createMinorPlanets({ fetch: answer(), minOrbits: 10, now: () => t });
    await first.run!(ctxOf(store).ctx);
    const before = store.getBlob(MPCORB_KEY)!.value;
    t = T0 + 31 * DAY;
    const f304 = answer(304);
    const { ctx, health } = ctxOf(store);
    await createMinorPlanets({ fetch: f304, minOrbits: 10, now: () => t }).run!(ctx);
    const sent = f304.mock.calls[0][1]?.headers as Record<string, string>;
    expect(sent['if-none-match']).toBe('"abc"');
    expect(store.blobInfo(MPCORB_KEY)!.fetchedAt).toBe(t);
    expect(store.getBlob(MPCORB_KEY)!.value.equals(before)).toBe(true);
    expect(health.note).toMatch(/unchanged at the source/);
    t += 31 * DAY;
    const f200 = answer(200, { etag: '"def"' });
    await createMinorPlanets({ fetch: f200, minOrbits: 10, now: () => t }).run!(ctx);
    expect(readContainer(store.getBlob(MPCORB_KEY)!.value).meta.etag).toBe('"def"');
  });

  it('keeps serving stored data when the refresh fails (softFail), throws with nothing stored, honours OFFLINE=1', async () => {
    const store = new Store(':memory:');
    const bad = answer(503, {});
    const none = ctxOf(store);
    await expect(createMinorPlanets({ fetch: bad, minOrbits: 10, now: () => T0 }).run!(none.ctx)).rejects.toThrow(/HTTP 503/);
    await expect(createMinorPlanets({ fetch: bad, now: () => T0 }).run!(ctxOf(store, true).ctx)).rejects.toThrow(/offline \(OFFLINE=1\)/);
    expect(bad).toHaveBeenCalledTimes(1);

    await createMinorPlanets({ fetch: answer(), minOrbits: 10, now: () => T0 }).run!(ctxOf(store).ctx);
    const later = ctxOf(store);
    await createMinorPlanets({ fetch: bad, minOrbits: 10, now: () => T0 + 40 * DAY }).run!(later.ctx);
    expect(later.softFail).toHaveBeenCalledWith(expect.stringMatching(/HTTP 503/), expect.any(Number));
    expect(later.health.note).toMatch(/stale, refresh failed/);
    const off = ctxOf(store, true);
    const f = answer();
    await createMinorPlanets({ fetch: f, now: () => T0 + 40 * DAY }).run!(off.ctx);
    expect(f).not.toHaveBeenCalled();
    expect(off.health.note).toMatch(/OFFLINE=1/);
  });

  it('refuses an answer that is not MPCORB and keeps what is stored', async () => {
    const store = new Store(':memory:');
    const junk = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(gzipSync('<html>maintenance</html>\nnot an orbit\n')), { status: 200 }));
    await expect(createMinorPlanets({ fetch: junk, minOrbits: 10, now: () => T0 }).run!(ctxOf(store).ctx)).rejects.toThrow(/unexpected MPCORB response: 0 orbits/);
    expect(store.blobInfo(MPCORB_KEY)).toBeUndefined();
    // the real file has over a million orbits: a short but valid file is refused under the default minimum
    await expect(createMinorPlanets({ fetch: answer(), now: () => T0 }).run!(ctxOf(store).ctx)).rejects.toThrow(/unexpected MPCORB response: 20 orbits/);
  });

  it('sends the request through the limiter as its own source', async () => {
    expect(LIMITS.mpcorb.perHour).toBeLessThanOrEqual(2);
    const store = new Store(':memory:');
    const limiter = new Limiter(store, { limits: { mpcorb: { ...LIMITS.mpcorb, perHour: 1 } } });
    const ctx = { ...ctxOf(store).ctx, http: { limiter } } as unknown as ConnectorContext;
    const f = answer(503, {});
    await expect(createMinorPlanets({ fetch: f, minOrbits: 10, now: () => T0 }).run!(ctx)).rejects.toThrow(/HTTP 503/);
    await expect(createMinorPlanets({ fetch: f, minOrbits: 10, now: () => T0 }).run!(ctx)).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('the stored row is outside the tile cap: trimming tiles leaves it', async () => {
    const store = new Store(':memory:');
    await createMinorPlanets({ fetch: answer(), minOrbits: 10, now: () => T0 }).run!(ctxOf(store).ctx);
    store.setBlob('mmgis-tile:x', new Uint8Array(100), 1000);
    expect(store.trimBlobs('mmgis-tile:', 0)).toBe(1);
    store.prune(0, T0 + 1000 * DAY);
    expect(store.blobInfo(MPCORB_KEY)).toBeDefined();
  });
});

/** valid MPCORB lines (the layout of a real one, varied H and anomaly) */
function* syntheticLines(n: number): Generator<string> {
  const base = MPCORB_SAMPLE.split('\n').find((l) => l.startsWith('00001 '))!;
  for (let i = 0; i < n; i++) {
    const h = (3 + ((i * 7919) % 2700) / 100).toFixed(2).padStart(5);
    const m = (((i * 37) % 36000) / 100).toFixed(5).padStart(9);
    yield `${String((i % 99999) + 1).padStart(5, "0")}   ${h}${base.slice(13, 26)}${m}${base.slice(35)}`;
  }
}

describe('readContainer alignment', () => {
  it('reads a Node Buffer that starts off a 4-byte boundary (what SQLite hands out)', async () => {
    const { bytes } = await packMpcorbGz(Readable.from([GZ]));
    for (const shift of [1, 2, 3]) {
      const padded = Buffer.concat([Buffer.alloc(shift), Buffer.from(bytes)]);
      const view = padded.subarray(shift);
      expect(view.byteOffset % 4).not.toBe(0);
      expect(readContainer(view).count).toBe(20);
    }
  });
});

describe('GET /api/minor-planets', () => {
  async function app(withData: boolean) {
    const store = new Store(':memory:');
    if (withData) await createMinorPlanets({ fetch: answer(), minOrbits: 10, now: () => T0 }).run!(ctxOf(store).ctx);
    const server = Fastify();
    registerMinorPlanets(server, new MinorPlanetData(store, () => T0));
    await server.ready();
    return { server, store };
  }

  it('is cache only: 404 and no download before the connector stored something', async () => {
    const { server } = await app(false);
    expect((await server.inject({ url: '/api/minor-planets' })).statusCode).toBe(404);
    expect((await server.inject({ url: '/api/minor-planets?chunk=0' })).statusCode).toBe(404);
  });

  it('serves an index and gzip chunks with ETags, brightest first', async () => {
    const { server } = await app(true);
    const idx = await server.inject({ url: '/api/minor-planets' });
    expect(idx.statusCode).toBe(200);
    const j = idx.json();
    expect(j).toMatchObject({ count: 20, chunkSize: CHUNK_SIZE, hMin: 3.25, stale: false, fetchedAt: T0 });
    expect(j.chunks).toEqual([{ chunk: 0, count: 20, hFirst: 3.25, hLast: 9.54 }]);
    expect(j.credit).toMatch(/Minor Planet Center/);
    expect((await server.inject({ url: '/api/minor-planets', headers: { 'if-none-match': idx.headers.etag as string } })).statusCode).toBe(304);

    const c = await server.inject({ url: '/api/minor-planets?chunk=0', headers: { 'accept-encoding': 'gzip' } });
    expect(c.statusCode).toBe(200);
    expect(c.headers['content-encoding']).toBe('gzip');
    expect(c.headers.etag).toMatch(/^"mpc-/);
    const u = readContainer(new Uint8Array(gunzipSync(c.rawPayload)));
    expect(u.count).toBe(20);
    expect(designationText(u.desig[0])).toBe('4');
    expect((await server.inject({ url: '/api/minor-planets?chunk=0', headers: { 'if-none-match': c.headers.etag as string } })).statusCode).toBe(304);
    const raw = await server.inject({ url: '/api/minor-planets?chunk=0', headers: { 'accept-encoding': 'identity' } });
    expect(readContainer(new Uint8Array(raw.rawPayload)).count).toBe(20);
    expect((await server.inject({ url: '/api/minor-planets?chunk=1' })).statusCode).toBe(404);
    expect((await server.inject({ url: '/api/minor-planets?chunk=x' })).statusCode).toBe(400);
  });

  it('cuts a big set into chunks by H and a new download changes the ETag', async () => {
    const store = new Store(':memory:');
    const lines = [...syntheticLines(CHUNK_SIZE + 5)].join('\n');
    const { bytes } = await packMpcorbGz(Readable.from([gzipSync(lines)]));
    store.setBlob(MPCORB_KEY, bytes, MPCORB_TTL_MS, T0);
    const server = Fastify();
    registerMinorPlanets(server, new MinorPlanetData(store, () => T0));
    const j = (await server.inject({ url: '/api/minor-planets' })).json();
    expect(j.chunks.map((c: { count: number }) => c.count)).toEqual([CHUNK_SIZE, 5]);
    expect(j.chunks[0].hLast).toBeLessThanOrEqual(j.chunks[1].hFirst);
    const e1 = (await server.inject({ url: '/api/minor-planets?chunk=1' })).headers.etag;
    store.setBlob(MPCORB_KEY, bytes, MPCORB_TTL_MS, T0 + DAY);
    expect((await server.inject({ url: '/api/minor-planets?chunk=1' })).headers.etag).not.toBe(e1);
  });
});

describe('memory stays flat while streaming', () => {
  /** pack n synthetic lines (202 bytes each) through gzip, gunzip and readline; the peak of heap + buffers above the start, sampled while reading */
  async function ingest(n: number): Promise<number> {
    let peak = 0;
    const base = process.memoryUsage();
    const sample = () => {
      const m = process.memoryUsage();
      peak = Math.max(peak, m.heapUsed + m.arrayBuffers - base.heapUsed - base.arrayBuffers);
    };
    async function* text(): AsyncGenerator<Buffer> {
      let batch: string[] = [];
      let k = 0;
      for (const l of syntheticLines(n)) {
        batch.push(l);
        if (batch.length === 2000) {
          yield Buffer.from(`${batch.join('\n')}\n`, 'latin1');
          batch = [];
          if (++k % 10 === 0) sample();
        }
      }
      if (batch.length) yield Buffer.from(`${batch.join('\n')}\n`, 'latin1');
    }
    const { bytes, stats } = await packMpcorbGz(Readable.from(text()).pipe(createGzip({ level: 1 })));
    expect(stats).toMatchObject({ parsed: n, skipped: 0 });
    expect(readContainer(bytes).count).toBe(n);
    return peak;
  }

  it('four times the input (250,000 to 1,000,000 lines, 50 to 202 MB of text) costs about the packed planes, not the text', async () => {
    const small = await ingest(250_000);
    const big = await ingest(1_000_000);
    const extraText = 750_000 * 202;
    // 750,000 more lines add 24 MB of packed planes (32 bytes each, plus the one that doubles); the 151 MB of text must not show
    expect(big - small).toBeLessThan(extraText * 0.3);
  }, 180_000);
});

describe('memory of the 12-hourly check and the route', () => {
  it('the check reads two small rows, never the packed blob, and an older store without the meta row is rebuilt once', async () => {
    const store = new Store(':memory:');
    const c = createMinorPlanets({ fetch: answer(), minOrbits: 10, now: () => T0 });
    await c.run!(ctxOf(store).ctx);
    expect(store.get('mpcorb:meta:v1')?.value).toMatchObject({ count: 20, etag: '"abc"', fetchedAt: T0 });
    const spy = vi.spyOn(store, 'getBlob');
    const { ctx, health } = ctxOf(store);
    await c.run!(ctx);
    expect(spy).not.toHaveBeenCalled();
    expect(health.note).toMatch(/20 minor planets \(cached/);
    // an older store: no meta row; one read of the blob rebuilds it, the next check does not read it
    store.delete('mpcorb:meta:v1');
    await c.run!(ctxOf(store).ctx);
    expect(spy).toHaveBeenCalledTimes(1);
    await c.run!(ctxOf(store).ctx);
    expect(spy).toHaveBeenCalledTimes(1);
    // the refresh asks with the validators of the meta row
    const f304 = answer(304);
    await createMinorPlanets({ fetch: f304, minOrbits: 10, now: () => T0 + 31 * DAY }).run!(ctxOf(store).ctx);
    expect((f304.mock.calls[0][1]?.headers as Record<string, string>)['if-none-match']).toBe('"abc"');
    expect(store.get<{ fetchedAt: number }>('mpcorb:meta:v1')?.value.fetchedAt).toBe(T0 + 31 * DAY);
  });

  it('the route drops its resident copy when idle and reads it again on the next request', async () => {
    vi.useFakeTimers();
    try {
      const store = new Store(':memory:');
      await createMinorPlanets({ fetch: answer(), minOrbits: 10, now: () => T0 }).run!(ctxOf(store).ctx);
      const data = new MinorPlanetData(store, () => T0, 1000);
      expect(data.resident).toBe(false);
      expect(data.get()?.u.count).toBe(20);
      expect(data.resident).toBe(true);
      vi.advanceTimersByTime(900);
      data.get();
      vi.advanceTimersByTime(900);
      expect(data.resident).toBe(true); // a request re-armed the timer
      vi.advanceTimersByTime(200);
      expect(data.resident).toBe(false);
      expect(data.get()?.u.count).toBe(20);
      expect(data.resident).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
