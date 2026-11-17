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
