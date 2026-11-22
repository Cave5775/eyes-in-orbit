import { OrbitBuilder, readContainer, readMpcorb, sliceOrbits, type MpcReadStats, type PackedMeta, type UnpackedOrbits } from '@eio/core';
import { LimitedError, type Limiter } from '../net/limiter';
import { guardedFetch } from '../net/guarded-fetch';
import { inProcessLock, type WithLock } from '../net/lock';
import type { Connector } from '../scheduler';
import type { KvStore } from '../store';

/**
 * Minor planets from the Minor Planet Center's MPCORB (about 1.4 million osculating orbits, https://www.minorplanetcenter.net/iau/MPCORB.html),
 * drawn as a point cloud. The browser streams MPCORB.DAT.gz (about 70 MB) straight from the MPC (it answers `Access-Control-Allow-Origin: *`,
 * no relay) through `DecompressionStream('gzip')`, `TextDecoderStream` and a line splitter into core's `readMpcorb` / `OrbitBuilder`
 * (memory holds the packed orbits, 32 bytes each, never the text), packs them sorted by H (brightest first) and keeps THAT as the stored
 * form: blob rows `mpcorb:v1:g<gen>:chunk:<k>` of `CHUNK_SIZE` (64k) orbits, each an MPCB container, plus the kv row `mpcorb:meta:v1`. No raw
 * text or gz is kept. The rows are outside the blob size cap of the tiles (`trimBlobs` only touches the prefix it is given) and the startup
 * prune keeps `mpcorb:` kv rows at any age.
 *
 * Generations, atomic by construction: a download writes all its chunks under its own generation (`gen` = the build time), then the meta
 * row `{ gen, chunks, bytes, chunkBytes[] }` LAST, and only then deletes the rows of the other generations. Readers take the generation
 * from the meta row, so until the meta row is replaced they read the previous download, whatever state a cut-short write left behind (a
 * tab closed, a quota error). A `pending` row names the generation being written, so the next download can delete the orphan chunks
 * of an attempt that died (the store cannot list blob keys). The whole download-and-write runs under `withLock('eio:mpcorb')`, so two
 * tabs (or a button and the connector) never interleave; the second one finds the fresh data and returns `cached`.
 *
 * Memory: the builder holds planes of the next power of two (1.5 M orbits: 2^21 x 32 B = about 67 MB), `finish()` adds the sort keys and
 * order (about 18 MB) and the 48 MB container: a peak of about 135 MB (estimated from the code, not measured in a browser). The builder is
 * unreachable once `packMpcorbStream` returns, so the writes then hold only the container (48 MB) plus one 2 MB chunk at a time, and the
 * container goes when `storePacked` returns. (Trimming the planes before `finish()` would copy them and raise the peak, so it is not done.)
 *
 * Refresh: a download is fresh for 30 days. Past that, one HEAD request compares `Last-Modified` (a CORS-safelisted response header, so it
 * is readable; `If-Modified-Since` / `If-None-Match` are not safelisted request headers and would add a preflight, and `ETag` is not
 * readable) with the stored one: equal renews the rows without the 70 MB download, different (or unreadable, or the HEAD failed) downloads.
 *
 * Abort: `deps.signal` (the connector's `stop()`, a layer switched off) and a stall timeout (no data for `idleMs`, not a total time: a slow
 * link is fine, a dead one is not) both abort the request and the read.
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
/** prefix of every chunk row of every generation */
export const MPCORB_CHUNK_PREFIX = 'mpcorb:v1:g';
export const mpcorbChunkKey = (gen: number, k: number): string => `${MPCORB_CHUNK_PREFIX}${gen}:chunk:${k}`;
/** a small kv row beside the chunks: what the 12-hourly check and the readers need without reading 45 MB */
export const MPCORB_META_KEY = 'mpcorb:meta:v1';
/** the generation being written (kv), so an attempt that died leaves no unreachable chunk rows behind */
export const MPCORB_PENDING_KEY = 'mpcorb:pending:v1';
export const MPCORB_LOCK = 'eio:mpcorb';
/** orbits per chunk row (2 MB packed) */
export const CHUNK_SIZE = 1 << 16;
/** the real file has about 1.4 million orbits; fewer than this means the answer is not MPCORB and the stored data is kept */
export const MIN_ORBITS = 100_000;
/** more than this share of unreadable data lines means the layout changed: nothing is stored */
export const MAX_SKIPPED_SHARE = 0.02;
/** no data (response headers, then every piece of the body) for this long aborts the request */
export const IDLE_TIMEOUT_MS = 60_000;
const HEAD_TIMEOUT_MS = 30_000;
/** a failed refresh is retried after this long while stored data is served */
const STALE_RETRY_MS = 6 * 3600_000;
export const CREDIT = 'Minor Planet Center (IAU), https://www.minorplanetcenter.net/iau/MPCORB.html';

/** Split a stream of text pieces into lines (the `\n` is dropped; a last line without one is kept). Leaving early cancels the stream. */
export async function* splitLines(text: ReadableStream<string>): AsyncGenerator<string> {
  const reader = text.getReader();
  let carry = '';
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
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
    // an early exit (the consumer stopped, or threw) must not leave the download running
    if (!finished) await reader.cancel().catch(() => undefined);
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
  /** the generation of the chunk rows (the build time) */
  gen: number;
  chunks: number;
  chunkSize: number;
  /** total bytes of the chunk rows */
  bytes: number;
  /** bytes of each chunk row, in order */
  chunkBytes: number[];
  fetchedAt: number;
}

/** The stored download as the cheap check sees it: meta row, age and TTL (no chunk is read). */
export interface StoredMinorPlanets {
  meta: StoredMeta;
  fetchedAt: number;
  ttlMs: number;
}

/**
 * The stored data, or undefined when nothing was downloaded or a chunk row of the meta row's generation is gone or has another size
 * (evicted under storage pressure). Reads the meta row and the metadata of each chunk row, never a chunk's bytes.
 */
export async function storedMinorPlanets(store: KvStore): Promise<StoredMinorPlanets | undefined> {
  const row = await store.get<StoredMeta>(MPCORB_META_KEY);
  if (!row) return undefined;
  const m = row.value;
  for (let k = 0; k < m.chunks; k++) {
    if ((await store.blobInfo(mpcorbChunkKey(m.gen, k)))?.bytes !== m.chunkBytes[k]) return undefined;
  }
  return { meta: m, fetchedAt: row.fetchedAt, ttlMs: row.ttlMs };
}

/**
 * Chunk `k` (orbits `k * CHUNK_SIZE` ..), brightest first; undefined past the end, or when the row is gone. One meta read and one chunk
 * read: no scan of the store. The generation comes from the meta row, so a download that is being written is never read half way.
 */
export async function readMinorPlanetChunk(store: KvStore, k: number): Promise<UnpackedOrbits | undefined> {
  const meta = (await store.get<StoredMeta>(MPCORB_META_KEY))?.value;
  if (!meta || k < 0 || k >= meta.chunks) return undefined;
  const row = await store.getBlob(mpcorbChunkKey(meta.gen, k));
  if (!row || row.data.length !== meta.chunkBytes[k]) return undefined;
  return readContainer(row.data);
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
  /** aborts the request and the read (the connector's stop, a layer switched off) */
  signal?: AbortSignal;
  /** no data for this long aborts (default `IDLE_TIMEOUT_MS`) */
  idleMs?: number;
  /** the lock around the whole download and write (default: this realm only; the worker passes Web Locks) */
  withLock?: WithLock;
  /** what the download is doing now, for a progress display: `checking` (HEAD), `downloading` (the file is read, unzipped and packed as it arrives), `storing` (chunk rows written) */
  onPhase?: (phase: MinorPlanetsPhase) => void;
}

export type MinorPlanetsPhase = 'checking' | 'downloading' | 'storing';

export type MinorPlanetsOutcome = 'cached' | 'unchanged' | 'downloaded' | 'offline';

export interface MinorPlanetsResult {
  outcome: MinorPlanetsOutcome;
  meta: StoredMeta;
  /** data lines of the file that were not understood (downloaded only) */
  skipped?: number;
}

/** Delete the chunk rows of one generation (rows are found by probing: the store cannot list blob keys). */
async function dropGeneration(store: KvStore, gen: number): Promise<void> {
  for (let k = 0; await store.blobInfo(mpcorbChunkKey(gen, k)); k++) await store.deleteBlob(mpcorbChunkKey(gen, k));
}

/** Write a packed container as a new generation of chunk rows, then the meta row, then drop the older generations. */
async function storePacked(store: KvStore, bytes: Uint8Array, now: number): Promise<StoredMeta> {
  const u = readContainer(bytes);
  const gen = now;
  const old = (await store.get<StoredMeta>(MPCORB_META_KEY))?.value;
  const orphan = (await store.get<{ gen: number }>(MPCORB_PENDING_KEY))?.value;
  await store.put(MPCORB_PENDING_KEY, { gen }, MPCORB_TTL_MS, now);
  const chunks = Math.ceil(u.count / CHUNK_SIZE);
  const chunkBytes: number[] = [];
  for (let k = 0; k < chunks; k++) {
    const chunk = sliceOrbits(u, k * CHUNK_SIZE, (k + 1) * CHUNK_SIZE);
    chunkBytes.push(chunk.length);
    await store.putBlob(mpcorbChunkKey(gen, k), chunk, MPCORB_TTL_MS, now);
  }
  const meta: StoredMeta = {
    ...u.meta, count: u.count, gen, chunks, chunkSize: CHUNK_SIZE, bytes: chunkBytes.reduce((a, b) => a + b, 0), chunkBytes, fetchedAt: now,
  };
  await store.put(MPCORB_META_KEY, meta, MPCORB_TTL_MS, now); // the commit
  await store.delete(MPCORB_PENDING_KEY);
  for (const g of new Set([old?.gen, orphan?.gen])) if (g !== undefined && g !== gen) await dropGeneration(store, g);
  return meta;
}

/** Renew a stored download without downloading it (the source says it is unchanged). */
async function renew(store: KvStore, have: StoredMinorPlanets, now: number): Promise<StoredMeta> {
  for (let k = 0; k < have.meta.chunks; k++) await store.touchBlob(mpcorbChunkKey(have.meta.gen, k), MPCORB_TTL_MS, now);
  const meta: StoredMeta = { ...have.meta, fetchedAt: now };
  await store.put(MPCORB_META_KEY, meta, MPCORB_TTL_MS, now);
  return meta;
}

/** The body with a stall timer: every piece re-arms it, and `arm` aborts the request when it fires. */
function watched(body: ReadableStream<Uint8Array>, arm: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();
      arm();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/**
 * The download trigger (a button, or the connector when `minorPlanetsAuto` is on). Fresh data is returned as it is (`cached`) unless
 * `force`; otherwise one HEAD request decides between `unchanged` (same `Last-Modified`: rows renewed) and a full download
 * (`downloaded`); a HEAD that fails or has no `Last-Modified` falls through to the download under the normal limiter. With stored data a
 * failed refresh throws and leaves the data alone (the old generation is read until the new meta row is written, and that is after the whole
 * file was read and checked); `LimitedError` means the limiter refused and nothing was sent. The work runs under `withLock('eio:mpcorb')`.
 */
export function downloadMinorPlanets(deps: MinorPlanetsDeps, opts: { force?: boolean } = {}): Promise<MinorPlanetsResult> {
  return (deps.withLock ?? defaultLock)(MPCORB_LOCK, () => download(deps, opts));
}

const defaultLock = inProcessLock();

async function download(deps: MinorPlanetsDeps, opts: { force?: boolean }): Promise<MinorPlanetsResult> {
  const { store, limiter } = deps;
  const url = deps.url ?? MPCORB_URL;
  const minOrbits = deps.minOrbits ?? MIN_ORBITS;
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? IDLE_TIMEOUT_MS;
  // read again inside the lock: another tab may just have finished the same download
  const have = await storedMinorPlanets(store);
  if (have && !opts.force && now() - have.fetchedAt < have.ttlMs) return { outcome: 'cached', meta: have.meta };
  if (deps.offline) {
    if (!have) throw new Error('offline and nothing stored');
    return { outcome: 'offline', meta: have.meta };
  }
  deps.signal?.throwIfAborted();
  const stall = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, stall.signal]) : stall.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms = idleMs): void => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(new Error(`no data for ${Math.round(ms / 1000)} s`)), ms);
  };
  const send = async (source: string, init: RequestInit) => {
    const r = await guardedFetch(limiter, source, url, { ...init, signal }, { mode: 'poll', fetch: deps.fetch });
    if ('limited' in r) throw new LimitedError(source, r.retryAt, r.reason, r.kind, r.blockKind);
    return r.response;
  };
  try {
    if (have && !opts.force) {
      // a cheap staleness check: the file's Last-Modified against the stored one. Whatever goes wrong with it (CORS, network, a status,
      // a limit on the HEAD source) only costs the check: the download below has its own limiter source
      try {
        arm(HEAD_TIMEOUT_MS);
        deps.onPhase?.('checking');
        const head = await send(MPCORB_HEAD_SOURCE, { method: 'HEAD' });
        const modified = head.ok ? head.headers.get('last-modified') : null;
        if (modified && modified === have.meta.lastModified) return { outcome: 'unchanged', meta: await renew(store, have, now()) };
      } catch (err) {
        if (deps.signal?.aborted) throw err;
      }
    }
    arm();
    deps.onPhase?.('downloading');
    const res = await send(MPCORB_SOURCE, { headers: { accept: 'application/gzip, */*' } });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
    const { bytes, stats } = await packMpcorbStream(watched(res.body, arm), { source: url, lastModified: res.headers.get('last-modified'), builtAt: now() });
    clearTimeout(timer);
    if (stats.parsed < minOrbits || stats.skipped > (stats.parsed + stats.skipped) * MAX_SKIPPED_SHARE) {
      throw new Error(`unexpected MPCORB response: ${stats.parsed} orbits read, ${stats.skipped} lines not understood${stats.samples[0] ? ` (first: "${stats.samples[0]}")` : ''}`);
    }
    deps.onPhase?.('storing');
    return { outcome: 'downloaded', meta: await storePacked(store, bytes, now()), skipped: stats.skipped };
  } finally {
    clearTimeout(timer);
  }
}

export interface MinorPlanetsOptions {
  url?: string;
  fetch?: typeof fetch;
  minOrbits?: number;
  now?: () => number;
  idleMs?: number;
  withLock?: WithLock;
}

const describe = (m: StoredMeta, how: string): string =>
  `${m.count.toLocaleString('en')} minor planets (${how}, ${new Date(m.builtAt ?? m.fetchedAt).toISOString().slice(0, 10)}), MPCORB`;

/**
 * The connector: a check every 12 h that costs two small reads. With `config.minorPlanetsAuto` off (the default) it never touches the
 * network and only reports what is stored; with it on it runs `downloadMinorPlanets` (a HEAD check, then a download once the rows are past 30 days).
 * `stop()` aborts a download in progress.
 */
export function createMinorPlanets(opts: MinorPlanetsOptions = {}): Connector {
  let running: AbortController | undefined;
  return {
    id: 'minor-planets',
    intervalMs: 12 * 3600_000,
    startDelayMs: 20_000,
    stop() {
      running?.abort(new Error('stopped'));
    },
    async run(ctx) {
      const ctl = (running = new AbortController());
      const deps: MinorPlanetsDeps = { ...opts, store: ctx.store, limiter: ctx.http.limiter, offline: ctx.config.offline || ctx.http.offline, signal: ctl.signal };
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
        if (!have || err instanceof LimitedError || ctl.signal.aborted) throw err;
        // stored data keeps being served; the connector retries in hours, not in 12 h
        ctx.softFail((err as Error).message, STALE_RETRY_MS);
        ctx.health.note = describe(have.meta, 'stale, refresh failed');
      } finally {
        if (running === ctl) running = undefined;
      }
    },
  };
}

export const minorPlanets: Connector = createMinorPlanets();
