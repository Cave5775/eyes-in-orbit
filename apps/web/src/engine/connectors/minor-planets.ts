import { OrbitBuilder, readContainer, readMpcorb, sliceOrbits, type MpcReadStats, type PackedMeta, type UnpackedOrbits } from '@eio/core';
import { LimitedError, type Limiter } from '../net/limiter';
import { guardedFetch } from '../net/guarded-fetch';
import type { Connector } from '../scheduler';
import type { KvStore } from '../store';

/**
 * Minor planets from the Minor Planet Center's MPCORB (about 1.4 million osculating orbits, https://www.minorplanetcenter.net/iau/MPCORB.html),
 * drawn as a point cloud. The browser streams MPCORB.DAT.gz (about 70 MB) straight from the MPC (it answers `Access-Control-Allow-Origin: *`,
 * no relay) through `DecompressionStream('gzip')`, `TextDecoderStream` and a line splitter into core's `readMpcorb` / `OrbitBuilder`
 * (memory holds the packed orbits, 32 bytes each, never the text), packs them sorted by H (brightest first) and keeps THAT as the stored
 * form: blob rows `mpcorb:v1:chunk:<k>` of `CHUNK_SIZE` (64k) orbits, each an MPCB container, plus the kv row `mpcorb:meta:v1`. No raw text
 * or gz is kept. The rows are outside the blob size cap of the tiles (`trimBlobs` only touches the prefix it is given) and the startup
 * prune keeps `mpcorb:` kv rows at any age.
 *
 * Atomic write: the meta row is the commit marker and is written LAST, after every chunk (and after surplus chunks of an older, longer
 * download are deleted). It records the chunk count, their total bytes and the build time, which every chunk container also carries
 * (`meta.builtAt`). `storedMinorPlanets` accepts the stored data only when the chunk rows add up to what the meta row says, and
 * `readMinorPlanetChunk` checks the chunk's build time against the meta row, so a write cut short (tab closed, quota) reads as "nothing
 * stored" and is downloaded again instead of serving a mixture of two downloads. (The store has no multi-row transaction; this is
 * the same guarantee without one. A failed refresh that got as far as overwriting chunks does lose the older download.)
 *
 * Refresh: a download is fresh for 30 days. Past that, one HEAD request compares `Last-Modified` (a CORS-safelisted response header, so it
 * is readable; `If-Modified-Since` / `If-None-Match` are not safelisted request headers and would add a preflight, and `ETag` is not
 * readable) with the stored one: equal renews the rows without the 70 MB download, different (or unreadable) downloads.
 *
 * Whether the connector downloads on its own is `EngineConfig.minorPlanetsAuto` (default off, the download is big): while off, the
 * connector only reports what is stored, and `downloadMinorPlanets` is the trigger for a button.
 *
 * Credit: Minor Planet Center. Its file header asks that software which includes the data keeps that attribution and says where to get
 * updated copies (https://www.minorplanetcenter.org/iau/MPCORB/MPCORB.DAT); both are in the UI and docs/reference.md.
 */
export const MPCORB_URL = 'https://www.minorplanetcenter.net/iau/MPCORB/MPCORB.DAT.gz';
export const MPCORB_SOURCE = 'mpcorb';
/** the HEAD staleness check has its own limiter source so the GET that follows is not held back by the download source's spacing */
export const MPCORB_HEAD_SOURCE = 'mpcorb-head';
export const MPCORB_TTL_MS = 30 * 86_400_000;
export const MPCORB_CHUNK_PREFIX = 'mpcorb:v1:chunk:';
export const mpcorbChunkKey = (k: number): string => `${MPCORB_CHUNK_PREFIX}${k}`;
/** a small kv row beside the chunks: what the 12-hourly check and the refresh need without reading 45 MB */
export const MPCORB_META_KEY = 'mpcorb:meta:v1';
/** orbits per chunk row (2 MB packed) */
export const CHUNK_SIZE = 1 << 16;
/** the real file has about 1.4 million orbits; fewer than this means the answer is not MPCORB and the stored data is kept */
export const MIN_ORBITS = 100_000;
/** more than this share of unreadable data lines means the layout changed: nothing is stored */
export const MAX_SKIPPED_SHARE = 0.02;
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
const HEAD_TIMEOUT_MS = 30_000;
/** a failed refresh is retried after this long while stored data is served */
const STALE_RETRY_MS = 6 * 3600_000;
export const CREDIT = 'Minor Planet Center (IAU), https://www.minorplanetcenter.net/iau/MPCORB.html';

/** Split a stream of text pieces into lines (the `\n` is dropped; a last line without one is kept). */
export async function* splitLines(text: ReadableStream<string>): AsyncGenerator<string> {
  const reader = text.getReader();
  let carry = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      let from = 0;
      for (let nl = value.indexOf('\n', from); nl >= 0; nl = value.indexOf('\n', from)) {
        yield carry ? carry + value.slice(from, nl) : value.slice(from, nl);
        carry = '';
        from = nl + 1;
      }
      carry += value.slice(from);
    }
    if (carry) yield carry;
  } finally {
    reader.releaseLock();
  }
}

/**
 * The lines of a (normally gzipped) MPCORB body. A body that starts with the gzip magic is decompressed; one that does not was already
 * decoded on the way (a `Content-Encoding: gzip` the browser undid, which cross-origin code cannot see) and is read as text.
 */
export function mpcorbLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  return (async function* () {
    const reader = body.getReader();
    // peek at the first piece (at least two bytes) to tell gzip from plain text
    let head: Uint8Array = new Uint8Array(0);
    while (head.length < 2) {
      const r = await reader.read();
      if (r.done) break;
      head = concat(head, r.value);
    }
    if (!head.length) return;
    let first: Uint8Array | undefined = head;
    // the peeked bytes first, then the rest of the body (the stream is made after the peek: its first pull starts at construction)
    const bytes = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (first) {
          controller.enqueue(first);
          first = undefined;
          return;
        }
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    const gzip = head[0] === 0x1f && head[1] === 0x8b;
    const plain = gzip ? bytes.pipeThrough(transform<Uint8Array, Uint8Array>(new DecompressionStream('gzip'))) : bytes;
    // MPCORB is ASCII; latin1 keeps one byte per character should anything else slip in
    yield* splitLines(plain.pipeThrough(transform<Uint8Array, string>(new TextDecoderStream('latin1'))));
  })();
}

/** the DOM typings of the stream transforms and `pipeThrough` disagree on the buffer type (`BufferSource` against `Uint8Array`); the data is the same */
const transform = <I, O>(t: unknown): ReadableWritablePair<O, I> => t as ReadableWritablePair<O, I>;

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/** Stream a gzipped MPCORB body into packed form. Memory: the packed planes only. */
export async function packMpcorbStream(
  body: ReadableStream<Uint8Array>,
  meta: { source?: string; etag?: string | null; lastModified?: string | null; builtAt?: number } = {},
): Promise<{ bytes: Uint8Array; stats: MpcReadStats }> {
  const builder = new OrbitBuilder();
  const stats = await readMpcorb(mpcorbLines(body), builder);
  return { bytes: builder.finish({ ...meta, skipped: stats.skipped }), stats };
}

/** What the meta row holds: the packed meta plus how the chunk rows were cut, to check that the rows belong together. */
export interface StoredMeta extends PackedMeta {
  count: number;
  chunks: number;
  chunkSize: number;
  /** total bytes of the chunk rows */
  bytes: number;
  fetchedAt: number;
}

/** The stored download as the cheap check sees it: meta row, age and TTL (no chunk is read). */
export interface StoredMinorPlanets {
  meta: StoredMeta;
  fetchedAt: number;
  ttlMs: number;
}

/** The stored data, or undefined when nothing was downloaded or the rows do not add up to the meta row (an interrupted write). */
export async function storedMinorPlanets(store: KvStore): Promise<StoredMinorPlanets | undefined> {
  const row = await store.get<StoredMeta>(MPCORB_META_KEY);
  if (!row) return undefined;
  const stats = await store.blobStats(MPCORB_CHUNK_PREFIX);
  if (stats.count !== row.value.chunks || stats.bytes !== row.value.bytes) return undefined;
  return { meta: row.value, fetchedAt: row.fetchedAt, ttlMs: row.ttlMs };
}

/** Chunk `k` (orbits `k * CHUNK_SIZE` ..), brightest first; undefined past the end, or when it is not part of the stored download. */
export async function readMinorPlanetChunk(store: KvStore, k: number): Promise<UnpackedOrbits | undefined> {
  const have = await storedMinorPlanets(store);
  if (!have || k < 0 || k >= have.meta.chunks) return undefined;
  const row = await store.getBlob(mpcorbChunkKey(k));
  if (!row) return undefined;
  const u = readContainer(row.data);
  return u.meta.builtAt === have.meta.builtAt ? u : undefined;
}

export interface MinorPlanetsDeps {
  store: KvStore;
  limiter: Limiter;
  /** skip the network and serve what is stored */
  offline?: boolean;
  url?: string;
  fetch?: typeof fetch;
  minOrbits?: number;
  now?: () => number;
}

export type MinorPlanetsOutcome = 'cached' | 'unchanged' | 'downloaded' | 'offline';

export interface MinorPlanetsResult {
  outcome: MinorPlanetsOutcome;
  meta: StoredMeta;
  /** data lines of the file that were not understood (downloaded only) */
  skipped?: number;
}

/** Write a packed container as chunk rows and then the meta row (see the atomic-write note above). */
async function storePacked(store: KvStore, bytes: Uint8Array, now: number): Promise<StoredMeta> {
  const u = readContainer(bytes);
  const chunks = Math.ceil(u.count / CHUNK_SIZE);
  let chunkBytes = 0;
  for (let k = 0; k < chunks; k++) {
    const chunk = sliceOrbits(u, k * CHUNK_SIZE, (k + 1) * CHUNK_SIZE);
    chunkBytes += chunk.length;
    await store.putBlob(mpcorbChunkKey(k), chunk, MPCORB_TTL_MS, now);
  }
  // surplus rows of an older, longer download
  for (let k = chunks; await store.blobInfo(mpcorbChunkKey(k)); k++) await store.deleteBlob(mpcorbChunkKey(k));
  const meta: StoredMeta = { ...u.meta, count: u.count, chunks, chunkSize: CHUNK_SIZE, bytes: chunkBytes, fetchedAt: now };
  await store.put(MPCORB_META_KEY, meta, MPCORB_TTL_MS, now);
  return meta;
}

/** Renew a stored download without downloading it (the source says it is unchanged). */
async function renew(store: KvStore, have: StoredMinorPlanets, now: number): Promise<StoredMeta> {
  for (let k = 0; k < have.meta.chunks; k++) await store.touchBlob(mpcorbChunkKey(k), MPCORB_TTL_MS, now);
  const meta: StoredMeta = { ...have.meta, fetchedAt: now };
  await store.put(MPCORB_META_KEY, meta, MPCORB_TTL_MS, now);
  return meta;
}

/**
 * The download trigger (a button, or the connector when `minorPlanetsAuto` is on). Fresh data is returned as it is (`cached`) unless
 * `force`; otherwise one HEAD request decides between `unchanged` (same `Last-Modified`: rows renewed) and a full download
 * (`downloaded`). With stored data a failed refresh throws and leaves the data alone (nothing is written before the whole file was read and
 * checked); `LimitedError` means the limiter refused and nothing was sent.
 */
export async function downloadMinorPlanets(deps: MinorPlanetsDeps, opts: { force?: boolean } = {}): Promise<MinorPlanetsResult> {
  const { store, limiter } = deps;
  const url = deps.url ?? MPCORB_URL;
  const minOrbits = deps.minOrbits ?? MIN_ORBITS;
  const now = deps.now ?? Date.now;
  const have = await storedMinorPlanets(store);
  if (have && !opts.force && now() - have.fetchedAt < have.ttlMs) return { outcome: 'cached', meta: have.meta };
  if (deps.offline) {
    if (!have) throw new Error('offline and nothing stored');
    return { outcome: 'offline', meta: have.meta };
  }
  const send = async (source: string, init: RequestInit) => {
    const r = await guardedFetch(limiter, source, url, init, { mode: 'poll', fetch: deps.fetch });
    if ('limited' in r) throw new LimitedError(source, r.retryAt, r.reason, r.kind, r.blockKind);
    return r.response;
  };
  if (have && !opts.force) {
    // a cheap staleness check: the file's Last-Modified against the stored one
    const head = await send(MPCORB_HEAD_SOURCE, { method: 'HEAD', signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) });
    if (!head.ok) throw new Error(`HTTP ${head.status} for ${url}`);
    const modified = head.headers.get('last-modified');
    if (modified && modified === have.meta.lastModified) return { outcome: 'unchanged', meta: await renew(store, have, now()) };
  }
  const res = await send(MPCORB_SOURCE, { headers: { accept: 'application/gzip, */*' }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const { bytes, stats } = await packMpcorbStream(res.body, { source: url, lastModified: res.headers.get('last-modified'), builtAt: now() });
  if (stats.parsed < minOrbits || stats.skipped > (stats.parsed + stats.skipped) * MAX_SKIPPED_SHARE) {
    throw new Error(`unexpected MPCORB response: ${stats.parsed} orbits read, ${stats.skipped} lines not understood${stats.samples[0] ? ` (first: "${stats.samples[0]}")` : ''}`);
  }
  return { outcome: 'downloaded', meta: await storePacked(store, bytes, now()), skipped: stats.skipped };
}

export interface MinorPlanetsOptions {
  url?: string;
  fetch?: typeof fetch;
  minOrbits?: number;
  now?: () => number;
}

const describe = (m: StoredMeta, how: string): string =>
  `${m.count.toLocaleString('en')} minor planets (${how}, ${new Date(m.builtAt ?? m.fetchedAt).toISOString().slice(0, 10)}), MPCORB`;

/**
 * The connector: a check every 12 h that costs two small reads. With `config.minorPlanetsAuto` off (the default) it never touches the
 * network and only reports what is stored; with it on it runs `downloadMinorPlanets` (a HEAD check, then a download once the rows are past 30 days).
 */
export function createMinorPlanets(opts: MinorPlanetsOptions = {}): Connector {
  return {
    id: 'minor-planets',
    intervalMs: 12 * 3600_000,
    startDelayMs: 20_000,
    async run(ctx) {
      const deps: MinorPlanetsDeps = { ...opts, store: ctx.store, limiter: ctx.http.limiter, offline: ctx.config.offline || ctx.http.offline };
      const have = await storedMinorPlanets(ctx.store);
      if (!ctx.config.minorPlanetsAuto) {
        ctx.health.fromCache = true;
        ctx.health.note = have ? describe(have.meta, 'stored; refreshed on request') : 'not downloaded (about 70 MB, on request)';
        return;
      }
      try {
        const r = await downloadMinorPlanets(deps);
        ctx.health.fromCache = r.outcome !== 'downloaded';
        ctx.health.note = r.outcome === 'offline' ? describe(r.meta, 'cached, offline')
          : r.outcome === 'unchanged' ? describe(r.meta, 'unchanged at the source')
          : `${describe(r.meta, r.outcome)}${r.skipped ? `, ${r.skipped} lines skipped` : ''}`;
      } catch (err) {
        if (!have || err instanceof LimitedError) throw err;
        // stored data keeps being served; the connector retries in hours, not in 12 h
        ctx.softFail((err as Error).message, STALE_RETRY_MS);
        ctx.health.note = describe(have.meta, 'stale, refresh failed');
      }
    },
  };
}

export const minorPlanets: Connector = createMinorPlanets();
