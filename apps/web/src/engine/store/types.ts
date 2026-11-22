/**
 * The engine's storage interface: two row kinds (small keyed values and binary blobs with metadata).
 *  - kv rows: `{ key, value, fetchedAt, ttlMs }`, the value any structured-cloneable JSON-like value (key names such as
 *    `celestrak:<group>`, `limit:<source>`, `backoff:<source>` are unchanged)
 *  - blob rows: `{ key, data, bytes, fetchedAt, ttlMs, usedAt }`, bytes as fetched, with the last use for the LRU size cap
 * Everything is async so the same code runs over memory (tests) and IndexedDB (browser).
 */
export interface CacheRow<T = unknown> {
  value: T;
  fetchedAt: number;
  ttlMs: number;
}

export interface BlobRow {
  data: Uint8Array;
  fetchedAt: number;
  ttlMs: number;
}

export interface BlobInfo {
  fetchedAt: number;
  ttlMs: number;
  bytes: number;
}

/** `getBlob` marks a row used at most this often, so reads stay reads. */
export const BLOB_USED_THROTTLE_MS = 60_000;

/** `trimBlobs` deletes down to this share of the cap, so one trim is not followed by another at once. */
export const BLOB_TRIM_TARGET = 0.9;

export interface KvStore {
  get<T = unknown>(key: string): Promise<CacheRow<T> | undefined>;
  put(key: string, value: unknown, ttlMs: number, fetchedAt?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Rows whose key starts with `prefix` (a literal prefix: no wildcards). */
  list<T = unknown>(prefix: string): Promise<{ key: string; row: CacheRow<T> }[]>;

  /** A binary row; marks it used at `now` (at most once a minute). */
  getBlob(key: string, now?: number): Promise<BlobRow | undefined>;
  putBlob(key: string, data: Uint8Array, ttlMs: number, fetchedAt?: number): Promise<void>;
  deleteBlob(key: string): Promise<void>;
  /** Age, TTL and size of a binary row. */
  blobInfo(key: string): Promise<BlobInfo | undefined>;
  /** Renew a binary row (a 304 answer) without rewriting its bytes. */
  touchBlob(key: string, ttlMs: number, fetchedAt?: number): Promise<void>;
  /** Count and bytes of the binary rows whose key starts with `prefix`. */
  blobStats(prefix: string): Promise<{ count: number; bytes: number }>;
  /** Over `maxBytes`, delete the least recently used binary rows under `prefix` down to 90 % of it; returns the rows deleted. */
  trimBlobs(prefix: string, maxBytes: number): Promise<number>;

  /**
   * Drop kv rows that have been stale for longer than `maxAgeMs` past their TTL, except rows whose key starts with one of
   * `keepPrefixes` (kept at any age, e.g. the last good download of a source that may stay unreachable for weeks).
   * Blob rows are not touched (they are capped by `trimBlobs`).
   */
  prune(maxAgeMs: number, now?: number, keepPrefixes?: readonly string[]): Promise<number>;
}

export const isFresh = (row: Pick<CacheRow, 'fetchedAt' | 'ttlMs'>, now = Date.now()): boolean => now - row.fetchedAt < row.ttlMs;

/** The prune rule shared by every implementation. */
export const isPrunable = (row: Pick<CacheRow, 'fetchedAt' | 'ttlMs'>, key: string, maxAgeMs: number, now: number, keepPrefixes: readonly string[]): boolean =>
  row.fetchedAt + row.ttlMs < now - maxAgeMs && !keepPrefixes.some((p) => key.startsWith(p));

/** The startup prune of the server: 30 days past the TTL, but the last good CelesTrak and MPCORB downloads are kept at any age. */
export const PRUNE_MAX_AGE_MS = 30 * 86_400_000;
export const PRUNE_KEEP_PREFIXES: readonly string[] = ['celestrak:', 'mpcorb:'];

/** Rows to delete (oldest use first) so `bytes` falls to 90 % of `maxBytes`; empty while within the cap. */
export function lruVictims(rows: { key: string; bytes: number; usedAt: number }[], maxBytes: number): string[] {
  let bytes = rows.reduce((n, r) => n + r.bytes, 0);
  if (bytes <= maxBytes) return [];
  const out: string[] = [];
  for (const r of [...rows].sort((a, b) => a.usedAt - b.usedAt)) {
    if (bytes <= maxBytes * BLOB_TRIM_TARGET) break;
    out.push(r.key);
    bytes -= r.bytes;
  }
  return out;
}

export const isQuotaError = (err: unknown): boolean =>
  !!err && typeof err === 'object' && ((err as { name?: unknown }).name === 'QuotaExceededError' || (err as { code?: unknown }).code === 22);
