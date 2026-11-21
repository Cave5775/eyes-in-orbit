import {
  BLOB_USED_THROTTLE_MS, isPrunable, lruVictims,
  type BlobInfo, type BlobRow, type CacheRow, type KvStore,
} from './types';

interface BlobEntry { data: Uint8Array; fetchedAt: number; ttlMs: number; usedAt: number }

/** In-memory KvStore (tests, and the engine when IndexedDB is unavailable). Values are cloned like IndexedDB would. */
export class MemoryKv implements KvStore {
  private kv = new Map<string, CacheRow>();
  private blobs = new Map<string, BlobEntry>();

  async get<T = unknown>(key: string): Promise<CacheRow<T> | undefined> {
    const r = this.kv.get(key);
    return r && { value: structuredClone(r.value) as T, fetchedAt: r.fetchedAt, ttlMs: r.ttlMs };
  }

  async put(key: string, value: unknown, ttlMs: number, fetchedAt = Date.now()): Promise<void> {
    this.kv.set(key, { value: structuredClone(value), fetchedAt, ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.kv.delete(key);
  }

  async list<T = unknown>(prefix: string): Promise<{ key: string; row: CacheRow<T> }[]> {
    return [...this.kv].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, r]) => ({ key, row: { value: structuredClone(r.value) as T, fetchedAt: r.fetchedAt, ttlMs: r.ttlMs } }));
  }

  async getBlob(key: string, now = Date.now()): Promise<BlobRow | undefined> {
    const b = this.blobs.get(key);
    if (!b) return undefined;
    if (now - b.usedAt > BLOB_USED_THROTTLE_MS) b.usedAt = now;
    return { data: b.data.slice(), fetchedAt: b.fetchedAt, ttlMs: b.ttlMs };
  }

  async putBlob(key: string, data: Uint8Array, ttlMs: number, fetchedAt = Date.now()): Promise<void> {
    this.blobs.set(key, { data: data.slice(), fetchedAt, ttlMs, usedAt: fetchedAt });
  }

  async deleteBlob(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  async blobInfo(key: string): Promise<BlobInfo | undefined> {
    const b = this.blobs.get(key);
    return b && { fetchedAt: b.fetchedAt, ttlMs: b.ttlMs, bytes: b.data.byteLength };
  }

  async touchBlob(key: string, ttlMs: number, fetchedAt = Date.now()): Promise<void> {
    const b = this.blobs.get(key);
    if (b) Object.assign(b, { fetchedAt, ttlMs, usedAt: fetchedAt });
  }

  async blobStats(prefix: string): Promise<{ count: number; bytes: number }> {
    let count = 0, bytes = 0;
    for (const [k, b] of this.blobs) if (k.startsWith(prefix)) { count++; bytes += b.data.byteLength; }
    return { count, bytes };
  }

  async trimBlobs(prefix: string, maxBytes: number): Promise<number> {
    const rows = [...this.blobs].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, bytes: b.data.byteLength, usedAt: b.usedAt }));
    const victims = lruVictims(rows, maxBytes);
    for (const k of victims) this.blobs.delete(k);
    return victims.length;
  }

  async prune(maxAgeMs: number, now = Date.now(), keepPrefixes: readonly string[] = []): Promise<number> {
    let n = 0;
    for (const [k, r] of this.kv) if (isPrunable(r, k, maxAgeMs, now, keepPrefixes)) { this.kv.delete(k); n++; }
    return n;
  }
}
