import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, gunzipSync, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { OrbitBuilder, readContainer, readMpcorb, sliceOrbits, type MpcReadStats, type PackedMeta, type UnpackedOrbits } from '@eio/core';
import type { Connector } from '../connector';
import { USER_AGENT } from '../http-util';
import { guardedFetch } from '../net/guarded-fetch';
import { LimitedError } from '../net/limiter';
import type { Store } from '../store';

/**
 * Minor planets from the Minor Planet Center's MPCORB (about 1.4 million osculating orbits, https://www.minorplanetcenter.net/iau/MPCORB.html),
 * drawn by the browser as a point cloud. The connector downloads MPCORB.DAT.gz (about 70 MB), streams it through gunzip and readline
 * line by line (memory holds the packed orbits, 32 bytes each, never the text), packs it sorted by H (brightest first, core `mpcorb.ts`)
 * and keeps THAT as the one stored form: one row of the SQLite `blob` table, key `mpcorb:v1`. No raw text or gz is kept, and the row is
 * outside the blob size cap: `Store.trimBlobs` only touches the prefix it is given (map tiles), and `prune` only reads `kv`.
 * It is refreshed monthly: a row is fresh for 30 days, then one conditional request (If-None-Match / If-Modified-Since, the validators
 * are inside the packed meta) either renews it (304) or replaces it. `GET /api/minor-planets` serves the stored data and never downloads.
 *
 * Credit: Minor Planet Center. Its file header asks that software which includes the data keeps that attribution and says where to get
 * updated copies (https://www.minorplanetcenter.org/iau/MPCORB/MPCORB.DAT); both are in the UI, docs/reference.md and the route's index.
 */
export const MPCORB_URL = 'https://www.minorplanetcenter.net/iau/MPCORB/MPCORB.DAT.gz';
export const MPCORB_SOURCE = 'mpcorb';
export const MPCORB_KEY = 'mpcorb:v1';
export const MPCORB_TTL_MS = 30 * 86_400_000;
/** a small `kv` row beside the blob: what the 12-hourly check and the conditional request need without reading 45 MB (written with the blob, same TTL) */
export const MPCORB_META_KEY = 'mpcorb:meta:v1';
/** the route's resident copy of the packed orbits is dropped after this long without a request */
export const RESIDENT_IDLE_MS = 5 * 60_000;
/** objects per chunk of `GET /api/minor-planets?chunk=k` (2 MB packed) */
export const CHUNK_SIZE = 1 << 16;
/** the real file has about 1.4 million orbits; fewer than this means the answer is not MPCORB and the stored data is kept */
export const MIN_ORBITS = 100_000;
/** more than this share of unreadable data lines means the layout changed: nothing is stored */
export const MAX_SKIPPED_SHARE = 0.02;
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
/** a failed refresh is retried after this long while stored data is served */
const STALE_RETRY_MS = 6 * 3600_000;
export const CREDIT = 'Minor Planet Center (IAU), https://www.minorplanetcenter.net/iau/MPCORB.html';

/** Stream a gzipped MPCORB through gunzip and readline into packed form. Memory: the packed planes only. */
export async function packMpcorbGz(
  gz: AsyncIterable<Uint8Array> | NodeJS.ReadableStream,
  meta: { source?: string; etag?: string | null; lastModified?: string | null; builtAt?: number } = {},
): Promise<{ bytes: Uint8Array; stats: MpcReadStats }> {
  const builder = new OrbitBuilder();
  let stats!: MpcReadStats;
  await pipeline(gz as NodeJS.ReadableStream, createGunzip(), async (plain: AsyncIterable<Buffer>) => {
    const rl = createInterface({ input: Readable.from(plain, { objectMode: false }), crlfDelay: Infinity });
    stats = await readMpcorb(rl, builder);
  });
  return { bytes: builder.finish({ ...meta, skipped: stats.skipped }), stats };
}

/** What the meta row holds: the packed meta plus the blob's size and time, to check that the two rows belong together. */
export interface StoredMeta extends PackedMeta {
  count: number;
  bytes: number;
  fetchedAt: number;
}

/**
 * Read the packed row for the route: the 45 MB are read out of SQLite once and kept while requests keep coming (a chunk request
 * must not copy tens of MB out of SQLite each time); after `idleMs` without one the copy is dropped (`release`), because a browser
 * fetches the chunks once and then the memory is better free. The next request reads it again.
 */
export class MinorPlanetData {
  private cache?: { fetchedAt: number; u: UnpackedOrbits };
  private gz = new Map<number, Buffer>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly store: Store, private readonly now: () => number = Date.now, private readonly idleMs = RESIDENT_IDLE_MS) {}

  /** Is the packed copy in memory? */
  get resident(): boolean {
    return this.cache !== undefined;
  }

  release(): void {
    clearTimeout(this.timer);
    this.cache = undefined;
    this.gz.clear();
  }

  private touch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.release(), this.idleMs);
    this.timer.unref?.();
  }

  /** The stored orbits with their age, or undefined when nothing was downloaded yet. */
  get(): { u: UnpackedOrbits; fetchedAt: number; stale: boolean } | undefined {
    const info = this.store.blobInfo(MPCORB_KEY);
    if (!info) return undefined;
    if (this.cache?.fetchedAt !== info.fetchedAt) {
      const row = this.store.getBlob(MPCORB_KEY, this.now());
      if (!row) return undefined;
      this.cache = { fetchedAt: row.fetchedAt, u: readContainer(row.value) };
      this.gz.clear();
    }
    this.touch();
    return { u: (this.cache as NonNullable<typeof this.cache>).u, fetchedAt: info.fetchedAt, stale: this.now() - info.fetchedAt >= info.ttlMs };
  }

  /** Chunk k gzipped (memoised, the last 6), or null past the end. */
  async chunk(k: number): Promise<Buffer | null> {
    const d = this.get();
    if (!d || k * CHUNK_SIZE >= d.u.count) return null;
    const hit = this.gz.get(k);
    if (hit) return hit;
    const out = await promisify(gzip)(sliceOrbits(d.u, k * CHUNK_SIZE, (k + 1) * CHUNK_SIZE), { level: 6 });
    this.gz.set(k, out);
    while (this.gz.size > 6) this.gz.delete(this.gz.keys().next().value as number);
    return out;
  }
}

export interface MinorPlanetsOptions {
  url?: string;
  fetch?: typeof fetch;
  minOrbits?: number;
  now?: () => number;
}

/** The blob's size and age and its meta row, without reading the blob; a missing or mismatched meta row is rebuilt once from the blob (an older store). */
function storedState(store: Store): { info: { fetchedAt: number; ttlMs: number; bytes: number }; meta: StoredMeta } | undefined {
  const info = store.blobInfo(MPCORB_KEY);
  if (!info) return undefined;
  const row = store.get<StoredMeta>(MPCORB_META_KEY)?.value;
  if (row && row.bytes === info.bytes && row.fetchedAt === info.fetchedAt) return { info, meta: row };
  const blob = store.getBlob(MPCORB_KEY);
  if (!blob) return undefined;
  const u = readContainer(blob.value);
  const meta: StoredMeta = { ...u.meta, count: u.count, bytes: info.bytes, fetchedAt: info.fetchedAt };
  store.set(MPCORB_META_KEY, meta, info.ttlMs, info.fetchedAt);
  return { info, meta };
}

export function createMinorPlanets(opts: MinorPlanetsOptions = {}): Connector {
  const url = opts.url ?? MPCORB_URL;
  const minOrbits = opts.minOrbits ?? MIN_ORBITS;
  const now = opts.now ?? Date.now;
  return {
    id: 'minor-planets',
    // a cheap check every 12 h (two small SQLite reads); the download happens when the stored row is past its 30 days
    intervalMs: 12 * 3600_000,
    startDelayMs: 20_000,
    async run(ctx) {
      const have = storedState(ctx.store);
      const describe = (m: StoredMeta, how: string): string =>
        `${m.count.toLocaleString('en')} minor planets (${how}, ${new Date(m.builtAt ?? m.fetchedAt).toISOString().slice(0, 10)}), MPCORB`;
      if (have && now() - have.info.fetchedAt < have.info.ttlMs) {
        ctx.health.fromCache = true;
        ctx.health.note = describe(have.meta, 'cached');
        return;
      }
      if (ctx.config.offline) {
        if (!have) throw new Error('offline (OFFLINE=1)');
        ctx.health.note = describe(have.meta, 'cached, OFFLINE=1');
        return;
      }
      try {
        const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'application/gzip, */*' };
        if (have?.meta.etag) headers['if-none-match'] = have.meta.etag;
        else if (have?.meta.lastModified) headers['if-modified-since'] = have.meta.lastModified;
        const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
        const r = await guardedFetch(ctx.http.limiter, MPCORB_SOURCE, url, { headers, signal }, { mode: 'poll', fetch: opts.fetch });
        if ('limited' in r) throw new LimitedError(MPCORB_SOURCE, r.retryAt, r.reason, r.kind, r.blockKind);
        const res = r.response;
        if (res.status === 304 && have) {
          const t = now();
          ctx.store.touchBlob(MPCORB_KEY, MPCORB_TTL_MS, t);
          const meta: StoredMeta = { ...have.meta, fetchedAt: t };
          ctx.store.set(MPCORB_META_KEY, meta, MPCORB_TTL_MS, t);
          ctx.health.fromCache = true;
          ctx.health.note = describe(meta, 'unchanged at the source');
          return;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
        const { bytes, stats } = await packMpcorbGz(Readable.fromWeb(res.body as never), {
          source: url, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), builtAt: now(),
        });
        if (stats.parsed < minOrbits || stats.skipped > (stats.parsed + stats.skipped) * MAX_SKIPPED_SHARE) {
          throw new Error(`unexpected MPCORB response: ${stats.parsed} orbits read, ${stats.skipped} lines not understood${stats.samples[0] ? ` (first: "${stats.samples[0]}")` : ''}`);
        }
        const t = now();
        ctx.store.setBlob(MPCORB_KEY, bytes, MPCORB_TTL_MS, t);
        const meta: StoredMeta = { ...readContainer(bytes).meta, count: stats.parsed, bytes: bytes.length, fetchedAt: t };
        ctx.store.set(MPCORB_META_KEY, meta, MPCORB_TTL_MS, t);
        ctx.health.note = `${describe(meta, 'downloaded')}${stats.skipped ? `, ${stats.skipped} lines skipped` : ''}`;
      } catch (err) {
        if (!have) throw err;
        if (err instanceof LimitedError) throw err;
        // stored data keeps being served; the connector retries in hours, not in 12 h
        ctx.softFail((err as Error).message, STALE_RETRY_MS);
        ctx.health.note = describe(have.meta, 'stale, refresh failed');
      }
    },
  };
}

export const minorPlanets: Connector = createMinorPlanets();

/** Read a local gz file through the same pipeline (tests and the measuring script). */
export const packMpcorbGzFile = (path: string, meta?: Parameters<typeof packMpcorbGz>[1]) => packMpcorbGz(createReadStream(path), meta);

/**
 * `GET /api/minor-planets`: the index (JSON). `GET /api/minor-planets?chunk=k`: chunk k (objects k*CHUNK_SIZE ..), a packed container
 * (core `mpcorb.ts`), gzip-compressed, brightest first. Cache only: 404 until the connector has stored a download. ETag per chunk.
 */
export function registerMinorPlanets(app: FastifyInstance, data: MinorPlanetData): void {
  app.get<{ Querystring: { chunk?: string } }>('/api/minor-planets', async (req, reply) => {
    const d = data.get();
    if (!d) return reply.code(404).send({ error: 'minor planets not downloaded yet (the minor-planets connector stores them; this route never downloads)' });
    const tag = (k: number | 'index'): string => `"mpc-${d.fetchedAt}-${d.u.count}-${k}"`;
    const q = req.query.chunk;
    if (q === undefined) {
      const chunks = Math.ceil(d.u.count / CHUNK_SIZE);
      const etag = tag('index');
      if (req.headers['if-none-match'] === etag) return reply.code(304).header('etag', etag).send();
      const list = Array.from({ length: chunks }, (_, k) => {
        const from = k * CHUNK_SIZE, to = Math.min(d.u.count, from + CHUNK_SIZE) - 1;
        const h = (i: number): number | null => (d.u.h[i] === 65535 ? null : d.u.h[i] / 100 - 10);
        return { chunk: k, count: to - from + 1, hFirst: h(from), hLast: h(to) };
      });
      const meta: PackedMeta = d.u.meta;
      return reply.header('etag', etag).header('cache-control', 'no-cache').send({
        count: d.u.count, chunkSize: CHUNK_SIZE, chunks: list, fetchedAt: d.fetchedAt, stale: d.stale,
        hMin: meta.hMin ?? null, hMax: meta.hMax ?? null, epochMin: meta.epochMin ?? null, epochMax: meta.epochMax ?? null,
        skipped: meta.skipped, source: meta.source ?? MPCORB_URL, sourceLastModified: meta.lastModified ?? null, credit: CREDIT,
        format: 'MPCB v1, see packages/core/src/mpcorb.ts',
      });
    }
    if (!/^\d{1,4}$/.test(q)) return reply.code(400).send({ error: 'chunk must be a whole number' });
    const k = Number(q);
    const etag = tag(k);
    if (k * CHUNK_SIZE >= d.u.count) return reply.code(404).send({ error: `no chunk ${k}: ${Math.ceil(d.u.count / CHUNK_SIZE)} chunks` });
    if (req.headers['if-none-match'] === etag) return reply.code(304).header('etag', etag).send();
    const gz = await data.chunk(k);
    if (!gz) return reply.code(404).send({ error: `no chunk ${k}` });
    reply.header('etag', etag).header('cache-control', 'public, max-age=3600').header('content-type', 'application/octet-stream').header('vary', 'accept-encoding');
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) return reply.header('content-encoding', 'gzip').send(gz);
    return reply.send(gunzipSync(gz));
  });
}
