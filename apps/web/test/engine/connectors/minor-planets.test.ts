import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { MPCORB_SAMPLE, designationText } from '@eio/core';
import {
  CHUNK_SIZE, MPCORB_HEAD_SOURCE, MPCORB_META_KEY, MPCORB_TTL_MS, MPCORB_URL, createMinorPlanets, downloadMinorPlanets, mpcorbChunkKey, mpcorbLines,
  packMpcorbStream, readMinorPlanetChunk, splitLines, storedMinorPlanets, type MinorPlanetsDeps,
} from '../../../src/engine/connectors/minor-planets';
import { engineConfig } from '../../../src/engine/config';
import { Http } from '../../../src/engine/http';
import { LimitedError, Limiter } from '../../../src/engine/net/limiter';
import { LIMITS } from '../../../src/engine/net/limits';
import { setUpstreams, defaultUpstreams } from '../../../src/engine/net/upstream';
import { inProcessLock } from '../../../src/engine/net/lock';
import { MemoryKv, PRUNE_KEEP_PREFIXES, type KvStore } from '../../../src/engine/store';

// the header and 20 real lines of MPCORB.DAT (see the fixture in core), gzipped here like the .gz the MPC publishes
const GZ = gzipSync(Buffer.from(MPCORB_SAMPLE, 'latin1'));
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-18T12:00:00Z');
const LAST_MODIFIED = 'Tue, 17 Nov 2026 13:09:02 GMT';

/** a byte stream cut into `size`-byte pieces, like the network delivers it */
const pieces = (bytes: Uint8Array, size: number): ReadableStream<Uint8Array> => {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
};
const textStream = (parts: string[]): ReadableStream<string> => new ReadableStream<string>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } });
const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => { const out: T[] = []; for await (const x of it) out.push(x); return out; };

/** valid MPCORB lines (the layout of a real one, varied H and anomaly) */
function* syntheticLines(n: number): Generator<string> {
  const base = MPCORB_SAMPLE.split('\n').find((l) => l.startsWith('00001 '))!;
  for (let i = 0; i < n; i++) {
    const h = (3 + ((i * 7919) % 2700) / 100).toFixed(2).padStart(5);
    const m = (((i * 37) % 36000) / 100).toFixed(5).padStart(9);
    yield `${String((i % 99999) + 1).padStart(5, '0')}   ${h}${base.slice(13, 26)}${m}${base.slice(35)}`;
  }
}

/** a fake MPC: GET answers the gz, HEAD only the headers */
function fakeMpc(over: { gz?: Uint8Array; lastModified?: string | null; status?: number; headStatus?: number } = {}) {
  const calls: { method: string; url: string }[] = [];
  const impl = vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url: String(input) });
    const headers: Record<string, string> = over.lastModified === null ? {} : { 'last-modified': over.lastModified ?? LAST_MODIFIED };
    if (method === 'HEAD') return new Response(null, { status: over.headStatus ?? 200, headers });
    return new Response(over.status && over.status !== 200 ? null : pieces(over.gz ?? GZ, 97), { status: over.status ?? 200, headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function depsOf(f: { impl: typeof fetch }, over: Partial<MinorPlanetsDeps> = {}, t = { now: T0 }): MinorPlanetsDeps & { t: { now: number } } {
  const store = over.store ?? new MemoryKv();
  return { store, limiter: new Limiter(store, { limits: LIMITS, now: () => t.now }), fetch: f.impl, minOrbits: 10, now: () => t.now, t, ...over };
}

describe('line reading', () => {
  it('splitLines joins pieces cut anywhere, keeps an unterminated last line and drops the newline', async () => {
    expect(await collect(splitLines(textStream(['ab', 'c\nde', '\n\nf', 'g\nh'])))).toEqual(['abc', 'de', '', 'fg', 'h']);
    expect(await collect(splitLines(textStream(['one\n', 'two\n'])))).toEqual(['one', 'two']);
    expect(await collect(splitLines(textStream([])))).toEqual([]);
  });

  it('mpcorbLines gunzips a body delivered in tiny pieces', async () => {
    const lines = await collect(mpcorbLines(pieces(GZ, 7)));
    expect(lines.join('\n')).toBe(MPCORB_SAMPLE.replace(/\n$/, ''));
  });

  it('mpcorbLines reads a body that is already plain text (a Content-Encoding the browser undid)', async () => {
    const lines = await collect(mpcorbLines(pieces(new Uint8Array(Buffer.from(MPCORB_SAMPLE, 'latin1')), 1)));
    expect(lines.join('\n')).toBe(MPCORB_SAMPLE.replace(/\n$/, ''));
    expect(await collect(mpcorbLines(pieces(new Uint8Array(0), 4)))).toEqual([]);
  });

  it('packMpcorbStream packs the 20 sample orbits, brightest first, with the source meta', async () => {
    const { bytes, stats } = await packMpcorbStream(pieces(GZ, 1000), { source: 'x', lastModified: LAST_MODIFIED, builtAt: T0 });
    expect(stats).toMatchObject({ parsed: 20, skipped: 0 });
    const store = new MemoryKv();
    expect(bytes.length).toBeLessThan(MPCORB_SAMPLE.length);
    await store.putBlob('k', bytes, 1);
    expect((await store.getBlob('k'))!.data.length).toBe(bytes.length);
  });
});

describe('downloadMinorPlanets', () => {
  it('streams the file, stores chunk rows and the meta row (nothing else), and makes no request inside the 30 days', async () => {
    const f = fakeMpc();
    const d = depsOf(f);
    const r = await downloadMinorPlanets(d);
    expect(r).toMatchObject({ outcome: 'downloaded', skipped: 0, meta: { count: 20, chunks: 1, chunkSize: CHUNK_SIZE, lastModified: LAST_MODIFIED, parsed: 20, fetchedAt: T0, source: MPCORB_URL } });
    expect(f.calls).toEqual([{ method: 'GET', url: MPCORB_URL }]);
    expect(await d.store.blobStats('')).toMatchObject({ count: 1 });
    expect(r.meta.gen).toBe(T0);
    expect(await d.store.blobInfo(mpcorbChunkKey(T0, 0))).toBeDefined();
    const meta = (await d.store.get(MPCORB_META_KEY))!;
    expect(meta.ttlMs).toBe(MPCORB_TTL_MS);
    const u = (await readMinorPlanetChunk(d.store, 0))!;
    expect(u.count).toBe(20);
    expect(designationText(u.desig[0])).toBe('4');
    expect(u.h[0]).toBeLessThanOrEqual(u.h[19]);
    expect(await readMinorPlanetChunk(d.store, 1)).toBeUndefined();
    d.t.now = T0 + 29 * DAY;
    expect((await downloadMinorPlanets(d)).outcome).toBe('cached');
    expect(f.calls).toHaveLength(1);
  });

  it('the stored rows survive the startup prune and live outside the tile cap', async () => {
    const d = depsOf(fakeMpc());
    await downloadMinorPlanets(d);
    await d.store.putBlob('mmgis-tile:x', new Uint8Array(100), 1000);
    expect(await d.store.trimBlobs('mmgis-tile:', 0)).toBe(1);
    expect(await d.store.prune(0, T0 + 1000 * DAY, PRUNE_KEEP_PREFIXES)).toBeGreaterThanOrEqual(0);
    expect(await storedMinorPlanets(d.store)).toBeDefined();
    expect(PRUNE_KEEP_PREFIXES).toContain('mpcorb:');
  });

  it('past the TTL one HEAD decides: the same Last-Modified renews the rows without the download', async () => {
    const f = fakeMpc();
    const d = depsOf(f);
    const gen0 = (await downloadMinorPlanets(d)).meta.gen;
    d.t.now = T0 + 31 * DAY;
    const r = await downloadMinorPlanets(d);
    expect(r.outcome).toBe('unchanged');
    expect(f.calls.map((c) => c.method)).toEqual(['GET', 'HEAD']);
    expect((await storedMinorPlanets(d.store))!.fetchedAt).toBe(T0 + 31 * DAY);
    expect((await d.store.blobInfo(mpcorbChunkKey(gen0, 0)))!.fetchedAt).toBe(T0 + 31 * DAY);
    d.t.now += DAY;
    expect((await downloadMinorPlanets(d)).outcome).toBe('cached');
  });

  it('a different Last-Modified (or none readable) downloads again and replaces the rows', async () => {
    const d = depsOf(fakeMpc());
    await downloadMinorPlanets(d);
    d.t.now = T0 + 31 * DAY;
    const newer = fakeMpc({ lastModified: 'Tue, 15 Dec 2026 13:00:00 GMT' });
    const r = await downloadMinorPlanets({ ...d, fetch: newer.impl });
    expect(r.outcome).toBe('downloaded');
    expect(newer.calls.map((c) => c.method)).toEqual(['HEAD', 'GET']);
    expect(r.meta.lastModified).toBe('Tue, 15 Dec 2026 13:00:00 GMT');
    d.t.now = T0 + 62 * DAY;
    const none = fakeMpc({ lastModified: null });
    expect((await downloadMinorPlanets({ ...d, fetch: none.impl })).outcome).toBe('downloaded');
    expect(none.calls.map((c) => c.method)).toEqual(['HEAD', 'GET']);
  });

  it('force skips the freshness and HEAD checks', async () => {
    const f = fakeMpc();
    const d = depsOf(f);
    await downloadMinorPlanets(d);
    d.t.now = T0 + 2 * 60_000; // past the 60 s spacing of the download source
    expect((await downloadMinorPlanets(d, { force: true })).outcome).toBe('downloaded');
    expect(f.calls.map((c) => c.method)).toEqual(['GET', 'GET']);
  });

  it('a failed refresh throws and leaves the stored data alone; with nothing stored it throws too; offline serves the store', async () => {
    const empty = depsOf(fakeMpc({ status: 503 }));
    await expect(downloadMinorPlanets(empty)).rejects.toThrow(/HTTP 503/);
    expect(await storedMinorPlanets(empty.store)).toBeUndefined();
    await expect(downloadMinorPlanets({ ...depsOf(fakeMpc()), offline: true })).rejects.toThrow(/offline and nothing stored/);
    const d = depsOf(fakeMpc());
    await downloadMinorPlanets(d);
    d.t.now = T0 + 40 * DAY;
    await expect(downloadMinorPlanets({ ...d, fetch: fakeMpc({ headStatus: 503, status: 503 }).impl })).rejects.toThrow(/HTTP 503/);
    expect((await readMinorPlanetChunk(d.store, 0))!.count).toBe(20);
    const off = fakeMpc();
    expect((await downloadMinorPlanets({ ...d, fetch: off.impl, offline: true })).outcome).toBe('offline');
    expect(off.calls).toHaveLength(0);
  });

  it('refuses an answer that is not MPCORB and keeps what is stored', async () => {
    const d = depsOf(fakeMpc());
    await downloadMinorPlanets(d); // something is stored first, so a refusal has something to keep
    d.t.now = T0 + 40 * DAY;
    const junk = fakeMpc({ lastModified: 'Wed, 18 Nov 2026 01:00:00 GMT', gz: new Uint8Array(gzipSync('<html>maintenance</html>\nnot an orbit\n')) });
    await expect(downloadMinorPlanets({ ...d, fetch: junk.impl })).rejects.toThrow(/unexpected MPCORB response: 0 orbits/);
    expect(await storedMinorPlanets(d.store)).toMatchObject({ meta: { count: 20, gen: T0 } });
    expect((await readMinorPlanetChunk(d.store, 0))!.count).toBe(20);
    // the real file has over a million orbits: a short but valid file is refused under the default minimum
    d.t.now += 2 * 60_000; // past the 60 s spacing
    await expect(downloadMinorPlanets({ ...d, minOrbits: undefined, fetch: fakeMpc({ lastModified: 'Wed, 18 Nov 2026 01:00:00 GMT' }).impl })).rejects.toThrow(/unexpected MPCORB response: 20 orbits/);
    expect(await storedMinorPlanets(d.store)).toMatchObject({ meta: { gen: T0 } });
  });

  it('the request goes through the limiter: HEAD and GET are separate sources, a refused one sends nothing', async () => {
    expect(LIMITS.mpcorb.perHour).toBeLessThanOrEqual(2);
    expect(LIMITS[MPCORB_HEAD_SOURCE]).toBeDefined();
    const f = fakeMpc({ status: 503 });
    const store = new MemoryKv();
    const t = { now: T0 };
    const d = depsOf(f, { store, limiter: new Limiter(store, { limits: { mpcorb: { ...LIMITS.mpcorb, perHour: 1 } }, now: () => t.now }) }, t);
    await expect(downloadMinorPlanets(d)).rejects.toThrow(/HTTP 503/);
    await expect(downloadMinorPlanets(d)).rejects.toBeInstanceOf(LimitedError);
    expect(f.calls).toHaveLength(1);
  });

  it('is called directly: no upstream table entry for the MPC', async () => {
    const prev = setUpstreams(defaultUpstreams());
    try {
      const f = fakeMpc();
      await downloadMinorPlanets(depsOf(f));
      expect(f.calls[0].url).toBe(MPCORB_URL);
    } finally {
      setUpstreams(prev);
    }
  });
});

describe('chunks and the atomic write', () => {
  const big = async () => {
    const gz = new Uint8Array(gzipSync(Array.from(syntheticLines(CHUNK_SIZE + 5)).join('\n')));
    const d = depsOf(fakeMpc({ gz }));
    await downloadMinorPlanets(d);
    return d;
  };

  it('cuts a big set into chunks of 64k brightest first', async () => {
    const d = await big();
    const have = (await storedMinorPlanets(d.store))!;
    expect(have.meta).toMatchObject({ count: CHUNK_SIZE + 5, chunks: 2, chunkSize: CHUNK_SIZE });
    const c0 = (await readMinorPlanetChunk(d.store, 0))!, c1 = (await readMinorPlanetChunk(d.store, 1))!;
    expect([c0.count, c1.count]).toEqual([CHUNK_SIZE, 5]);
    expect(c0.h[CHUNK_SIZE - 1]).toBeLessThanOrEqual(c1.h[0]);
    expect(have.meta.bytes).toBe((await d.store.blobStats('mpcorb:v1:g')).bytes);
    expect(have.meta.chunkBytes).toHaveLength(2);
  }, 30_000);

  it('a write that dies half way keeps the previous generation readable, and the next download removes the orphan rows', async () => {
    const d = depsOf(fakeMpc());
    const first = (await downloadMinorPlanets(d)).meta;
    expect(first.gen).toBe(T0);
    d.t.now = T0 + 31 * DAY;
    const bigGz = new Uint8Array(gzipSync(Array.from(syntheticLines(CHUNK_SIZE + 5)).join('\n')));
    let puts = 0;
    const flaky: KvStore = new Proxy(d.store, {
      get(target, prop) {
        if (prop === 'putBlob') return async (...a: Parameters<KvStore['putBlob']>) => { if (++puts === 2) throw new Error('QuotaExceededError'); return target.putBlob(...a); };
        const v = (target as never)[prop];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const newer = 'Wed, 18 Nov 2026 01:00:00 GMT';
    await expect(downloadMinorPlanets({ ...d, store: flaky, fetch: fakeMpc({ gz: bigGz, lastModified: newer }).impl })).rejects.toThrow(/Quota/);
    // the meta row still names the old generation, whose rows are intact
    expect(await storedMinorPlanets(d.store)).toMatchObject({ meta: { gen: T0, count: 20 } });
    expect((await readMinorPlanetChunk(d.store, 0))!.count).toBe(20);
    expect(await d.store.blobInfo(mpcorbChunkKey(T0 + 31 * DAY, 0))).toBeDefined(); // the orphan of the attempt that died
    // the next download (two days later, so the limiter spacing has passed) replaces everything and drops old and orphan rows
    d.t.now = T0 + 33 * DAY;
    const r = await downloadMinorPlanets({ ...d, fetch: fakeMpc({ gz: bigGz, lastModified: newer }).impl });
    expect(r.meta).toMatchObject({ gen: T0 + 33 * DAY, count: CHUNK_SIZE + 5, chunks: 2 });
    expect(await d.store.blobInfo(mpcorbChunkKey(T0, 0))).toBeUndefined();
    expect(await d.store.blobInfo(mpcorbChunkKey(T0 + 31 * DAY, 0))).toBeUndefined();
    expect(await d.store.blobStats('mpcorb:v1:g')).toMatchObject({ count: 2 });
    expect(await d.store.get('mpcorb:pending:v1')).toBeUndefined();
  }, 60_000);

  it('a missing chunk row (evicted) reads as nothing stored', async () => {
    const d = await big();
    const g = (await storedMinorPlanets(d.store))!.meta.gen;
    await d.store.deleteBlob(mpcorbChunkKey(g, 1));
    expect(await storedMinorPlanets(d.store)).toBeUndefined();
    expect(await readMinorPlanetChunk(d.store, 1)).toBeUndefined();
    expect((await readMinorPlanetChunk(d.store, 0))!.count).toBe(CHUNK_SIZE);
  }, 30_000);

  it('two downloads at once do not interleave: the lock runs them one after the other and one generation is left', async () => {
    const store = new MemoryKv();
    const t = { now: T0 };
    const order: string[] = [];
    const impl = vi.fn(async (_u: string, init: RequestInit = {}) => {
      if (init.method === 'HEAD') return new Response(null, { headers: { 'last-modified': LAST_MODIFIED } });
      order.push('get-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('get-end');
      t.now += 5 * 60_000;
      return new Response(pieces(GZ, 97), { headers: { 'last-modified': LAST_MODIFIED } });
    }) as unknown as typeof fetch;
    const lock = inProcessLock();
    const mk = (): MinorPlanetsDeps => ({ store, limiter: new Limiter(store, { limits: {}, now: () => t.now }), fetch: impl, minOrbits: 10, now: () => t.now, withLock: lock });
    const [a, b] = await Promise.all([downloadMinorPlanets(mk(), { force: true }), downloadMinorPlanets(mk(), { force: true })]);
    expect(order).toEqual(['get-start', 'get-end', 'get-start', 'get-end']);
    expect(a.meta.gen).not.toBe(b.meta.gen);
    expect(await storedMinorPlanets(store)).toMatchObject({ meta: { gen: b.meta.gen } });
    expect(await store.blobStats('mpcorb:v1:g')).toMatchObject({ count: 1 });
    // without force the second one, inside the lock, finds the fresh rows and sends nothing
    (impl as unknown as { mockClear(): void }).mockClear();
    const [c, e] = await Promise.all([downloadMinorPlanets(mk()), downloadMinorPlanets(mk())]);
    expect([c.outcome, e.outcome]).toEqual(['cached', 'cached']);
    expect(impl).not.toHaveBeenCalled();
  });

  it('reading a chunk takes one meta read and one chunk read: no scan of the store', async () => {
    const d = await big();
    const spies = [vi.spyOn(d.store, 'blobStats'), vi.spyOn(d.store, 'list'), vi.spyOn(d.store, 'blobInfo')];
    const blob = vi.spyOn(d.store, 'getBlob');
    expect((await readMinorPlanetChunk(d.store, 1))!.count).toBe(5);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(blob).toHaveBeenCalledTimes(1);
  }, 30_000);
});

function connectorCtx(store: MemoryKv, f: typeof fetch, config = engineConfig()) {
  const http = new Http(store, { fetch: f, limiter: new Limiter(store, { limits: LIMITS }), offline: config.offline });
  return { store, http, health: {} as { note?: string; fromCache?: boolean }, config, softFail: vi.fn() } as never;
}

describe('abort and stall', () => {
  /** a GET whose body sends one piece and then waits, ending (with the signal's reason) only when the request is aborted */
  const stalling = (gz: Uint8Array) => vi.fn(async (_u: string, init: RequestInit = {}) => {
    if (init.method === 'HEAD') return new Response(null, { headers: { 'last-modified': LAST_MODIFIED } });
    const signal = init.signal!;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(gz.slice(0, 40));
        signal.addEventListener('abort', () => c.error(signal.reason), { once: true });
      },
    });
    return new Response(body, { headers: { 'last-modified': LAST_MODIFIED } });
  }) as unknown as typeof fetch;

  it('a body that stops delivering aborts after the idle time (not a total time) and stores nothing', async () => {
    const d = depsOf({ impl: stalling(GZ) }, { idleMs: 60 });
    await expect(downloadMinorPlanets(d)).rejects.toThrow(/no data for/);
    expect(await storedMinorPlanets(d.store)).toBeUndefined();
    expect(await d.store.blobStats('')).toMatchObject({ count: 0 });
  });

  it('a slow but steady body is not cut by the idle time', async () => {
    let at = 0;
    const slow = vi.fn(async (_u: string, init: RequestInit = {}) => {
      if (init.method === 'HEAD') return new Response(null);
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          if (at >= GZ.length) return c.close();
          await new Promise((r) => setTimeout(r, 15));
          c.enqueue(GZ.slice(at, at + 200));
          at += 200;
        },
      });
      return new Response(body);
    }) as unknown as typeof fetch;
    const d = depsOf({ impl: slow }, { idleMs: 80 });
    expect((await downloadMinorPlanets(d)).outcome).toBe('downloaded'); // longer in total than idleMs, but never silent that long
  });

  it("the caller's signal aborts the request and the read", async () => {
    const ctl = new AbortController();
    const d = depsOf({ impl: stalling(GZ) }, { signal: ctl.signal });
    const p = downloadMinorPlanets(d);
    setTimeout(() => ctl.abort(new Error('layer off')), 30);
    await expect(p).rejects.toThrow(/layer off/);
    expect(await storedMinorPlanets(d.store)).toBeUndefined();
    // an already aborted signal sends nothing
    const g = stalling(GZ);
    await expect(downloadMinorPlanets(depsOf({ impl: g }, { signal: AbortSignal.abort(new Error('off')) }))).rejects.toThrow(/off/);
    expect(g).not.toHaveBeenCalled();
  });

  it('splitLines cancels the stream when the consumer stops early', async () => {
    const cancel = vi.fn();
    const s = new ReadableStream<string>({ pull(c) { c.enqueue('a\nb\nc\n'); }, cancel });
    for await (const line of splitLines(s)) { if (line === 'b') break; }
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('the connector stop() aborts a download in progress', async () => {
    const f = stalling(GZ);
    const c = createMinorPlanets({ fetch: f, minOrbits: 10, idleMs: 5000 });
    const p = c.run!(connectorCtx(new MemoryKv(), f, engineConfig({ minorPlanetsAuto: true })));
    setTimeout(() => c.stop!(), 30);
    await expect(p).rejects.toThrow(/stopped/);
  });
});

describe('the HEAD check never blocks the refresh', () => {
  const stale = async () => {
    const d = depsOf(fakeMpc());
    await downloadMinorPlanets(d);
    d.t.now = T0 + 31 * DAY;
    return d;
  };
  const NEWER = 'Wed, 18 Nov 2026 01:00:00 GMT';

  it('a HEAD that answers an error status falls back to the GET', async () => {
    const d = await stale();
    const f = fakeMpc({ headStatus: 503, lastModified: NEWER });
    expect((await downloadMinorPlanets({ ...d, fetch: f.impl })).outcome).toBe('downloaded');
    expect(f.calls.map((c) => c.method)).toEqual(['HEAD', 'GET']);
  });

  it('a HEAD that fails outright (CORS, network) falls back to the GET', async () => {
    const d = await stale();
    const f = fakeMpc({ lastModified: NEWER });
    const impl = vi.fn(async (u: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') throw new TypeError('Failed to fetch');
      return f.impl(u, init);
    }) as unknown as typeof fetch;
    expect((await downloadMinorPlanets({ ...d, fetch: impl })).outcome).toBe('downloaded');
    expect(f.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('a HEAD refused by its own limit falls back to the GET', async () => {
    const d = await stale();
    const f = fakeMpc({ lastModified: NEWER });
    await d.limiter.block(MPCORB_HEAD_SOURCE, 3600_000, 'test block');
    expect((await downloadMinorPlanets({ ...d, fetch: f.impl })).outcome).toBe('downloaded');
    expect(f.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('a good HEAD that reports a change followed by a failing GET throws and keeps the stored data', async () => {
    const d = await stale();
    const f = fakeMpc({ lastModified: NEWER });
    const impl = vi.fn(async (u: string, init?: RequestInit) => (init?.method === 'HEAD' ? f.impl(u, init) : new Response(null, { status: 503 }))) as unknown as typeof fetch;
    await expect(downloadMinorPlanets({ ...d, fetch: impl })).rejects.toThrow(/HTTP 503/);
    expect(f.calls.map((c) => c.method)).toEqual(['HEAD']);
    expect(await storedMinorPlanets(d.store)).toMatchObject({ meta: { gen: T0, count: 20 } });
    expect((await readMinorPlanetChunk(d.store, 0))!.count).toBe(20);
  });
});

describe('minor-planets connector', () => {
  function ctxOf(store: MemoryKv, f: { impl: typeof fetch }, config = engineConfig()) {
    const http = new Http(store, { fetch: f.impl, limiter: new Limiter(store, { limits: LIMITS }), offline: config.offline });
    const health: { note?: string; fromCache?: boolean } = {};
    const softFail = vi.fn();
    return { ctx: { store, http, health, config, softFail } as never, health, softFail };
  }

  it('does not touch the network while the auto flag is off (the default), and reports what is stored', async () => {
    expect(engineConfig().minorPlanetsAuto).toBe(false);
    const store = new MemoryKv();
    const f = fakeMpc();
    const { ctx, health } = ctxOf(store, f);
    const c = createMinorPlanets({ fetch: f.impl, minOrbits: 10 });
    await c.run!(ctx);
    expect(f.calls).toHaveLength(0);
    expect(health.note).toMatch(/not downloaded/);
    await downloadMinorPlanets({ store, limiter: new Limiter(store, { limits: LIMITS }), fetch: f.impl, minOrbits: 10 });
    await c.run!(ctx);
    expect(health.note).toMatch(/20 minor planets \(stored/);
    expect(f.calls).toHaveLength(1);
  });

  it('with the auto flag on it downloads once, then only reports (cached)', async () => {
    const store = new MemoryKv();
    const f = fakeMpc();
    const { ctx, health } = ctxOf(store, f, engineConfig({ minorPlanetsAuto: true }));
    const c = createMinorPlanets({ fetch: f.impl, minOrbits: 10 });
    await c.run!(ctx);
    expect(health.note).toMatch(/20 minor planets \(downloaded/);
    expect(health.fromCache).toBe(false);
    await c.run!(ctx);
    expect(f.calls).toHaveLength(1);
    expect(health.note).toMatch(/20 minor planets \(cached/);
    expect(health.fromCache).toBe(true);
  });

  it('with the auto flag on, a failed refresh keeps serving the stored data as a soft failure; with nothing stored it throws', async () => {
    const t = T0 + 40 * DAY;
    const empty = fakeMpc({ status: 503 });
    await expect(createMinorPlanets({ fetch: empty.impl, minOrbits: 10 }).run!(ctxOf(new MemoryKv(), empty, engineConfig({ minorPlanetsAuto: true })).ctx)).rejects.toThrow(/HTTP 503/);
    const store = new MemoryKv();
    const bad = fakeMpc({ headStatus: 503, status: 503 });
    const { ctx, health, softFail } = ctxOf(store, bad, engineConfig({ minorPlanetsAuto: true }));
    const good = fakeMpc();
    await downloadMinorPlanets({ store, limiter: new Limiter(store, { limits: {} }), fetch: good.impl, minOrbits: 10, now: () => T0 });
    await createMinorPlanets({ fetch: bad.impl, minOrbits: 10, now: () => t }).run!(ctx);
    expect(softFail).toHaveBeenCalledWith(expect.stringMatching(/HTTP 503/), expect.any(Number));
    expect(health.note).toMatch(/stale, refresh failed/);
  });
});
