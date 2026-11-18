import type { FastifyInstance } from 'fastify';
import { layerHasTile, mmgisLayer, mmgisTileUrl, type MmgisLayer } from '@eio/core';
import { USER_AGENT } from './http';
import { guardedFetch } from './net/guarded-fetch';
import { LimitedError, type Limiter } from './net/limiter';
import type { Store } from './store';

/**
 * Map tiles of the NASA rover maps (MMGIS) for the web's Mars surface patch, fetched through the local server on a miss:
 * `GET /api/tiles/mmgis/:mission/:layer/:z/:x/:y.png`. Only tiles of the cited layer table (core `MMGIS_LAYERS`) at the levels it
 * publishes and inside its bounding box are served (`layerHasTile`): this is no open proxy. The PNG bytes as NASA sent them are
 * kept in the SQLite store (`blob` rows, key `mmgis-tile:<mission>/<folder>/<z>/<x>/<y>`), the one stored form: no file cache.
 * A row is fresh for 90 days (the mosaics change with a new folder name, which is part of the key); after that a conditional
 * request renews it, and when NASA cannot be asked (OFFLINE=1, the limiter, an error) the stale row is served. The store keeps
 * at most `maxBytes` of tiles (least recently used out first). A tile NASA refuses (403 from S3 for a missing key, 404) is not
 * asked for again for 30 minutes; it does not count against the source (a clipped mosaic has absent edge tiles). An answer is
 * read with a 2 MB cap, and the 20 s timeout covers the body too.
 */

export const TILE_SOURCE = 'mmgis-tiles';
export const TILE_KEY_PREFIX = 'mmgis-tile:';
export const TILE_TTL_MS = 90 * 86_400_000;
export const TILE_CACHE_MAX_BYTES = 300 * 1024 * 1024;
/** a tile that failed is answered from memory this long */
export const TILE_NEGATIVE_MS = 30 * 60_000;
/** a tile answer larger than this is refused (the real ones are 50 to 140 kB) */
export const TILE_MAX_BYTES = 2 * 1024 * 1024;
/** the negative cache is pruned beyond this many entries */
const MAX_FAILED = 2000;
/** every this many stored tiles the size cap is checked */
const TRIM_EVERY = 25;

export const tileKey = (layer: MmgisLayer, z: number, x: number, y: number): string => `${TILE_KEY_PREFIX}${layer.mission}/${layer.dir}/${z}/${x}/${y}`;

const isPng = (b: Uint8Array): boolean => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** NASA has no such tile (HTTP 403 / 404): the route answers 404. */
export class TileMissingError extends Error {}

export interface TileResult {
  data: Buffer;
  /** answered from the store without asking NASA */
  fromCache: boolean;
  /** the stored row is past its TTL (NASA could not be asked) */
  stale: boolean;
}

export interface MmgisTileOptions {
  store: Store;
  /** every request to NASA passes this limiter (source `mmgis-tiles`) */
  limiter: Limiter;
  offline?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  maxBytes?: number;
  /** simultaneous requests to NASA */
  concurrency?: number;
  timeoutMs?: number;
}

export class MmgisTiles {
  private inflight = new Map<string, Promise<TileResult>>();
  private failed = new Map<string, { until: number; err: Error }>();
  private active = 0;
  private waiting: (() => void)[] = [];
  private stored = 0;

  constructor(private readonly opts: MmgisTileOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** The tile from the store or NASA; null when OFFLINE=1 and it is not stored. Throws `LimitedError`, `TileMissingError` or an HTTP error. */
  async get(layer: MmgisLayer, z: number, x: number, y: number): Promise<TileResult | null> {
    const key = tileKey(layer, z, x, y);
    const now = this.now();
    const row = this.opts.store.getBlob(key, now);
    if (row && now - row.fetchedAt < row.ttlMs) return { data: row.value, fromCache: true, stale: false };
    const stale = row ? { data: row.value, fromCache: true, stale: true } : null;
    if (this.opts.offline) return stale;
    const failure = this.failed.get(key);
    if (failure && failure.until > now) {
      if (stale) return stale;
      throw failure.err;
    }
    let p = this.inflight.get(key);
    if (!p) {
      p = this.download(layer, z, x, y, key, row?.fetchedAt).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    try {
      return await p;
    } catch (err) {
      if (stale) return stale; // even a refusal: the stored copy is still the best there is
      throw err;
    }
  }

  /** At most `concurrency` jobs at once; a finished job hands its slot straight to the next waiter (no window for a newcomer). */
  private async slot<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= (this.opts.concurrency ?? 2)) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private remember(key: string, err: Error): void {
    const now = this.now();
    this.failed.delete(key);
    this.failed.set(key, { until: now + TILE_NEGATIVE_MS, err });
    if (this.failed.size <= MAX_FAILED) return;
    for (const [k, v] of this.failed) if (v.until <= now) this.failed.delete(k);
    // still too many: the oldest go first (insertion order)
    for (const k of this.failed.keys()) {
      if (this.failed.size <= MAX_FAILED) break;
      this.failed.delete(k);
    }
  }

  /** Tiles remembered as failed. */
  get failedCount(): number {
    return this.failed.size;
  }

  /** Jobs holding a slot (for tests). */
  get activeCount(): number {
    return this.active;
  }

  private download(layer: MmgisLayer, z: number, x: number, y: number, key: string, storedAt?: number): Promise<TileResult> {
    return this.slot(async () => {
      try {
        const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'image/png' };
        if (storedAt !== undefined) headers['if-modified-since'] = new Date(storedAt).toUTCString();
        // user-triggered: it may wait up to 2 s for the spacing (the 2-wide queue above bounds the crowd), never longer
        const signal = AbortSignal.timeout(this.opts.timeoutMs ?? 20_000);
        const r = await guardedFetch(this.opts.limiter, TILE_SOURCE, mmgisTileUrl(layer, z, x, y), { headers, signal }, { mode: 'demand', fetch: this.opts.fetch, waitMs: 2000 });
        if ('limited' in r) throw new LimitedError(TILE_SOURCE, r.retryAt, r.reason, r.kind, r.blockKind);
        const res = r.response;
        const now = this.now();
        if (res.status === 304 && storedAt !== undefined) {
          const row = this.opts.store.getBlob(key, now);
          if (row) {
            this.opts.store.setBlob(key, row.value, TILE_TTL_MS, now);
            return { data: row.value, fromCache: true, stale: false };
          }
        }
        if (res.status === 403 || res.status === 404) throw new TileMissingError(`HTTP ${res.status} from MMGIS for ${layer.mission}/${layer.id} tile ${z}/${x}/${y}: no such tile`);
        if (!res.ok) throw new Error(`HTTP ${res.status} from MMGIS for ${layer.mission}/${layer.id} tile ${z}/${x}/${y}`);
        const buf = await readCapped(res, TILE_MAX_BYTES, signal, `${layer.mission}/${layer.id} tile ${z}/${x}/${y}`);
        if (!isPng(buf)) throw new Error(`MMGIS answered ${layer.mission}/${layer.id} tile ${z}/${x}/${y} with something that is not a PNG (${res.headers.get('content-type') ?? 'no type'}, ${buf.length} bytes)`);
        this.opts.store.setBlob(key, buf, TILE_TTL_MS, now);
        if (++this.stored % TRIM_EVERY === 0) this.opts.store.trimBlobs(TILE_KEY_PREFIX, this.opts.maxBytes ?? TILE_CACHE_MAX_BYTES);
        this.failed.delete(key);
        return { data: buf, fromCache: false, stale: false };
      } catch (err) {
        // a refused request says nothing about the tile; a failed one is remembered so a retrying client does not repeat it
        if (!(err instanceof LimitedError)) this.remember(key, err as Error);
        throw err;
      }
    });
  }

  /** Tiles held and their bytes. */
  stats(): { count: number; bytes: number } {
    return this.opts.store.blobStats(TILE_KEY_PREFIX);
  }
}

/** The body of `res`, refused past `max` bytes (Content-Length first, then while reading) or once `signal` has fired. */
export async function readCapped(res: Response, max: number, signal: AbortSignal, what: string): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) throw new Error(`MMGIS answered ${what} with ${declared} bytes (cap ${max})`);
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error(`MMGIS ${what}: timed out while reading the answer`);
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) throw new Error(`MMGIS answered ${what} with more than ${max} bytes`);
      parts.push(value);
    }
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw err;
  }
  return Buffer.concat(parts, n);
}

const NUM = /^\d{1,7}$/;

/** `GET /api/tiles/mmgis/:mission/:layer/:z/:x/:y.png` (see `MmgisTiles`). */
export function registerMmgisTiles(app: FastifyInstance, tiles: MmgisTiles): void {
  app.get<{ Params: { mission: string; layer: string; z: string; x: string; file: string } }>('/api/tiles/mmgis/:mission/:layer/:z/:x/:file', async (req, reply) => {
    const { mission, z, x } = req.params;
    const m = /^(\d{1,7})\.png$/.exec(req.params.file);
    const layer = mmgisLayer(mission, req.params.layer);
    if (!layer) return reply.code(404).send({ error: `unknown MMGIS layer ${mission}/${req.params.layer} (allowed: core MMGIS_LAYERS)` });
    const [nz, nx, ny] = [z, x, m?.[1] ?? ''].map((v) => (NUM.test(v) ? Number(v) : NaN));
    if (!layerHasTile(layer, nz, nx, ny)) {
      return reply.code(400).send({ error: `not a tile of ${mission}/${layer.id}: levels ${layer.minZoom}..${layer.maxNativeZoom}, TMS rows from the south, inside its bounding box` });
    }
    try {
      const t = await tiles.get(layer, nz, nx, ny);
      if (!t) return reply.code(404).send({ error: 'tile not stored and OFFLINE=1' });
      return reply.header('content-type', 'image/png').header('cache-control', 'public, max-age=86400')
        .header('x-eio-cache', t.stale ? 'stale' : t.fromCache ? 'hit' : 'miss').send(t.data);
    } catch (err) {
      if (err instanceof LimitedError) {
        return reply.code(429).header('retry-after', String(Math.max(Math.ceil((err.retryAt - Date.now()) / 1000), 1))).send({ error: err.message, limited: true, retryAt: err.retryAt });
      }
      if (err instanceof TileMissingError) return reply.code(404).send({ error: err.message });
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
