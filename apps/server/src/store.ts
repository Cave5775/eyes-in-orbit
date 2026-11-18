import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as Database } from 'node:sqlite';

// loaded via require: Vite/Vitest cannot resolve the prefix-only builtin `node:sqlite` as an ES import
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface CacheRow<T = unknown> {
  value: T;
  fetchedAt: number;
  ttlMs: number;
}

/** LIKE pattern (use with `ESCAPE '\\'`) matching keys that start with `prefix`. */
const likePrefix = (prefix: string): string => `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** SQLite key/value cache with per-row TTL (`kv`: key, value json, fetchedAt, ttl). */
export class Store {
  private db: Database;

  /** `file` may be `:memory:` (tests). */
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, fetchedAt INTEGER NOT NULL, ttl INTEGER NOT NULL)');
    // binary rows (map tiles): the bytes as fetched, with the same TTL columns and the last use for the size cap (`trimBlobs`)
    this.db.exec('CREATE TABLE IF NOT EXISTS blob (key TEXT PRIMARY KEY, data BLOB NOT NULL, fetchedAt INTEGER NOT NULL, ttl INTEGER NOT NULL, usedAt INTEGER NOT NULL)');
  }

  get<T = unknown>(key: string): CacheRow<T> | undefined {
    const row = this.db.prepare('SELECT value, fetchedAt, ttl FROM kv WHERE key = ?').get(key) as
      { value: string; fetchedAt: number; ttl: number } | undefined;
    return row && { value: JSON.parse(row.value) as T, fetchedAt: row.fetchedAt, ttlMs: row.ttl };
  }

  set(key: string, value: unknown, ttlMs: number, fetchedAt = Date.now()): void {
    this.db
      .prepare('INSERT INTO kv (key, value, fetchedAt, ttl) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetchedAt = excluded.fetchedAt, ttl = excluded.ttl')
      .run(key, JSON.stringify(value), fetchedAt, ttlMs);
  }

  /** Rows whose key starts with `prefix` (LIKE wildcards in the prefix are escaped). */
  list<T = unknown>(prefix: string): { key: string; row: CacheRow<T> }[] {
    const rows = this.db.prepare("SELECT key, value, fetchedAt, ttl FROM kv WHERE key LIKE ? ESCAPE '\\'").all(likePrefix(prefix)) as
      { key: string; value: string; fetchedAt: number; ttl: number }[];
    return rows.map((r) => ({ key: r.key, row: { value: JSON.parse(r.value) as T, fetchedAt: r.fetchedAt, ttlMs: r.ttl } }));
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  /** A binary row (`setBlob`); marks it used at `now` (at most once a minute, so reads stay reads). */
  getBlob(key: string, now = Date.now()): CacheRow<Buffer> | undefined {
    const row = this.db.prepare('SELECT data, fetchedAt, ttl, usedAt FROM blob WHERE key = ?').get(key) as
      { data: Uint8Array; fetchedAt: number; ttl: number; usedAt: number } | undefined;
    if (!row) return undefined;
    if (now - row.usedAt > 60_000) this.db.prepare('UPDATE blob SET usedAt = ? WHERE key = ?').run(now, key);
    return { value: Buffer.from(row.data.buffer, row.data.byteOffset, row.data.byteLength), fetchedAt: row.fetchedAt, ttlMs: row.ttl };
  }

  setBlob(key: string, data: Uint8Array, ttlMs: number, fetchedAt = Date.now()): void {
    this.db
      .prepare('INSERT INTO blob (key, data, fetchedAt, ttl, usedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetchedAt = excluded.fetchedAt, ttl = excluded.ttl, usedAt = excluded.usedAt')
      .run(key, data, fetchedAt, ttlMs, fetchedAt);
  }

  /** Age, TTL and size of a binary row without reading its bytes. */
  blobInfo(key: string): { fetchedAt: number; ttlMs: number; bytes: number } | undefined {
    const r = this.db.prepare('SELECT fetchedAt, ttl, LENGTH(data) AS size FROM blob WHERE key = ?').get(key) as { fetchedAt: number; ttl: number; size: number } | undefined;
    return r && { fetchedAt: r.fetchedAt, ttlMs: r.ttl, bytes: Number(r.size) };
  }

  /** Renew a binary row (a 304 answer) without rewriting its bytes. */
  touchBlob(key: string, ttlMs: number, fetchedAt = Date.now()): void {
    this.db.prepare('UPDATE blob SET fetchedAt = ?, ttl = ?, usedAt = ? WHERE key = ?').run(fetchedAt, ttlMs, fetchedAt, key);
  }

  /** Count and bytes of the binary rows whose key starts with `prefix`. */
  blobStats(prefix: string): { count: number; bytes: number } {
    const r = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS b FROM blob WHERE key LIKE ? ESCAPE '\\'").get(likePrefix(prefix)) as { n: number; b: number };
    return { count: Number(r.n), bytes: Number(r.b) };
  }

  /** Over `maxBytes`, delete the least recently used binary rows under `prefix` down to 90 % of it; returns the rows deleted. */
  trimBlobs(prefix: string, maxBytes: number): number {
    let { bytes } = this.blobStats(prefix);
    if (bytes <= maxBytes) return 0;
    const rows = this.db.prepare("SELECT key, LENGTH(data) AS size FROM blob WHERE key LIKE ? ESCAPE '\\' ORDER BY usedAt ASC").all(likePrefix(prefix)) as { key: string; size: number }[];
    const del = this.db.prepare('DELETE FROM blob WHERE key = ?');
    let n = 0;
    for (const r of rows) {
      if (bytes <= maxBytes * 0.9) break;
      del.run(r.key);
      bytes -= Number(r.size);
      n++;
    }
    return n;
  }

  /**
   * Drop rows that have been stale for longer than `maxAgeMs` past their TTL, except rows whose key starts with one of
   * `keepPrefixes` (kept at any age, e.g. the last good download of a source that may stay unreachable for weeks).
   */
  prune(maxAgeMs: number, now = Date.now(), keepPrefixes: readonly string[] = []): number {
    const keep = keepPrefixes.map(() => " AND key NOT LIKE ? ESCAPE '\\'").join('');
    const sql = `DELETE FROM kv WHERE fetchedAt + ttl < ?${keep}`;
    return Number(this.db.prepare(sql).run(now - maxAgeMs, ...keepPrefixes.map(likePrefix)).changes);
  }

  close(): void {
    this.db.close();
  }
}

export const isFresh = (row: CacheRow, now = Date.now()): boolean => now - row.fetchedAt < row.ttlMs;
