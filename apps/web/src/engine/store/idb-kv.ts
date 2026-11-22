import { MemoryKv } from './memory-kv';
import {
  BLOB_USED_THROTTLE_MS, isQuotaError, lruVictims,
  type BlobInfo, type BlobRow, type CacheRow, type KvStore,
} from './types';

/** One IndexedDB database, object stores `kv` and `blob`/`blobmeta`. */
export const DB_NAME = 'eio';
/**
 * Bump when a store or index changes and add a step to `upgrade`; per-key `v1`/`v2` suffixes stay for value formats.
 *  1: `kv`, `blob` (with the bytes and their accounting in one row)
 *  2: `kv` gains the `expiresAt` index (prune reads keys, not values); the blob accounting moves to `blobmeta`, so size,
 *     age and LRU never load the bytes
 */
export const DB_VERSION = 2;
export const KV_STORE = 'kv';
export const BLOB_STORE = 'blob';
export const BLOB_META_STORE = 'blobmeta';
export const USED_AT_INDEX = 'usedAt';
export const EXPIRES_AT_INDEX = 'expiresAt';

/** How long a pending open may wait for another tab to release an older version before it is given up. */
const BLOCKED_OPEN_TIMEOUT_MS = 10_000;

interface KvRecord { key: string; value: unknown; fetchedAt: number; ttlMs: number; expiresAt: number }
interface BlobRecord { key: string; data: Uint8Array }
interface BlobMeta { key: string; bytes: number; fetchedAt: number; ttlMs: number; usedAt: number }

/** Called when a write failed with QuotaExceededError. Free space (trim tiles, then MPCORB chunks) and return true to retry the write once. */
export type QuotaHook = (err: unknown, info: { store: 'kv' | 'blob'; key: string }) => Promise<boolean> | boolean;

export interface IdbKvOptions {
  /** the IndexedDB factory (default `indexedDB`; tests pass a fake) */
  factory?: IDBFactory;
  /** the matching `IDBKeyRange` (default the global one; tests pass the fake's) */
  keyRange?: typeof IDBKeyRange;
  name?: string;
  onQuotaExceeded?: QuotaHook;
}

/** Create the stores and indexes of every version after `oldVersion`; `tx` is the upgrade transaction (needed to migrate rows). */
export function upgrade(db: IDBDatabase, oldVersion: number, tx: IDBTransaction): void {
  if (oldVersion < 1) {
    db.createObjectStore(KV_STORE, { keyPath: 'key' });
    db.createObjectStore(BLOB_STORE, { keyPath: 'key' });
  }
  if (oldVersion < 2) {
    const kv = tx.objectStore(KV_STORE);
    const blob = tx.objectStore(BLOB_STORE);
    kv.createIndex(EXPIRES_AT_INDEX, 'expiresAt');
    const meta = db.createObjectStore(BLOB_META_STORE, { keyPath: 'key' });
    meta.createIndex(USED_AT_INDEX, 'usedAt');
    if (oldVersion >= 1) {
      // rows written by version 1 get their expiry, and the blob accounting is split off the bytes
      const kvCur = kv.openCursor();
      kvCur.onsuccess = () => {
        const cur = kvCur.result;
        if (!cur) return;
        const r = cur.value as Omit<KvRecord, 'expiresAt'>;
        cur.update({ ...r, expiresAt: r.fetchedAt + r.ttlMs });
        cur.continue();
      };
      {
        if (blob.indexNames.contains(USED_AT_INDEX)) blob.deleteIndex(USED_AT_INDEX);
        const cur = blob.openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return;
          const r = c.value as BlobRecord & Partial<BlobMeta>;
          const bytes = r.bytes ?? r.data.byteLength;
          meta.put({ key: r.key, bytes, fetchedAt: r.fetchedAt ?? 0, ttlMs: r.ttlMs ?? 0, usedAt: r.usedAt ?? r.fetchedAt ?? 0 } satisfies BlobMeta);
          c.update({ key: r.key, data: r.data } satisfies BlobRecord);
          c.continue();
        };
      }
    }
  }
}

/** Run `write`; on QuotaExceededError ask `hook` to free space and run it once more when the hook says so. */
export async function withQuotaRetry<T>(write: () => Promise<T>, hook: QuotaHook | undefined, info: { store: 'kv' | 'blob'; key: string }): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (!hook || !isQuotaError(err) || !(await hook(err, info))) throw err;
    return write();
  }
}

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** Open the database. A pending open that another tab blocks is given up after a while and closed if it succeeds later (no leaked connection). */
function openDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(name, DB_VERSION);
    let abandoned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    open.onupgradeneeded = (e) => upgrade(open.result, e.oldVersion, open.transaction!);
    open.onsuccess = () => {
      clearTimeout(timer);
      if (abandoned) open.result.close();
      else resolve(open.result);
    };
    open.onerror = () => { clearTimeout(timer); reject(open.error); };
    open.onblocked = () => {
      timer ??= setTimeout(() => { abandoned = true; reject(new Error('the IndexedDB upgrade is blocked by another tab')); }, BLOCKED_OPEN_TIMEOUT_MS);
    };
  });
}

export class IdbKv implements KvStore {
  private db?: IDBDatabase;
  private opening?: Promise<IDBDatabase>;
  private factory: IDBFactory;
  private keyRange: typeof IDBKeyRange;
  private name: string;
  private hook?: QuotaHook;

  private constructor(opts: IdbKvOptions) {
    this.factory = opts.factory ?? indexedDB;
    this.keyRange = opts.keyRange ?? IDBKeyRange;
    this.name = opts.name ?? DB_NAME;
    this.hook = opts.onQuotaExceeded;
  }

  static async open(opts: IdbKvOptions = {}): Promise<IdbKv> {
    const kv = new IdbKv(opts);
    await kv.conn();
    return kv;
  }

  /** The open connection; reopened lazily after another tab's upgrade closed it. */
  private conn(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    this.opening ??= openDb(this.factory, this.name).then((db) => {
      // another tab upgrading the database must not be held up by this connection; the next operation reopens
      db.onversionchange = () => { db.close(); if (this.db === db) this.db = undefined; };
      db.onclose = () => { if (this.db === db) this.db = undefined; };
      this.db = db;
      return db;
    }).finally(() => { this.opening = undefined; });
    return this.opening;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private prefixRange(prefix: string): IDBKeyRange | undefined {
    return prefix ? this.keyRange.bound(prefix, `${prefix}￿`) : undefined;
  }

  private async begin(stores: string[], mode: IDBTransactionMode): Promise<IDBTransaction> {
    try {
      return (await this.conn()).transaction(stores, mode);
    } catch (err) {
      if (!(err instanceof DOMException) || err.name !== 'InvalidStateError') throw err;
      this.db = undefined; // closed under us: open again once
      return (await this.conn()).transaction(stores, mode);
    }
  }

  /** Run `fn` in one transaction; resolves with its result once the transaction committed. */
  private async tx<T>(stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const tx = await this.begin(stores, mode);
    return new Promise<T>((resolve, reject) => {
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new DOMException('transaction aborted', 'AbortError'));
      fn(tx).then((r) => { result = r; }, (err) => { reject(err); try { tx.abort(); } catch { /* already finished */ } });
    });
  }

  async get<T = unknown>(key: string): Promise<CacheRow<T> | undefined> {
    const r = await this.tx([KV_STORE], 'readonly', (tx) => req<KvRecord | undefined>(tx.objectStore(KV_STORE).get(key)));
    return r && { value: r.value as T, fetchedAt: r.fetchedAt, ttlMs: r.ttlMs };
  }

  put(key: string, value: unknown, ttlMs: number, fetchedAt = Date.now()): Promise<void> {
    const rec: KvRecord = { key, value, fetchedAt, ttlMs, expiresAt: fetchedAt + ttlMs };
    return withQuotaRetry(() => this.tx([KV_STORE], 'readwrite', async (tx) => void (await req(tx.objectStore(KV_STORE).put(rec)))), this.hook, { store: 'kv', key });
  }

  delete(key: string): Promise<void> {
    return this.tx([KV_STORE], 'readwrite', async (tx) => void (await req(tx.objectStore(KV_STORE).delete(key))));
  }

  async list<T = unknown>(prefix: string): Promise<{ key: string; row: CacheRow<T> }[]> {
    const rows = await this.tx([KV_STORE], 'readonly', (tx) => req<KvRecord[]>(tx.objectStore(KV_STORE).getAll(this.prefixRange(prefix))));
    return rows.map((r) => ({ key: r.key, row: { value: r.value as T, fetchedAt: r.fetchedAt, ttlMs: r.ttlMs } }));
  }

  async getBlob(key: string, now = Date.now()): Promise<BlobRow | undefined> {
    const got = await this.tx([BLOB_STORE, BLOB_META_STORE], 'readonly', async (tx) => {
      const [data, meta] = await Promise.all([
        req<BlobRecord | undefined>(tx.objectStore(BLOB_STORE).get(key)),
        req<BlobMeta | undefined>(tx.objectStore(BLOB_META_STORE).get(key)),
      ]);
      return data && meta ? { data: data.data, meta } : undefined;
    });
    if (!got) return undefined;
    if (now - got.meta.usedAt > BLOB_USED_THROTTLE_MS) {
      // only the small accounting row is touched, and a failure here (near quota, say) never fails the read
      void this.tx([BLOB_META_STORE], 'readwrite', async (tx) => {
        const os = tx.objectStore(BLOB_META_STORE);
        const m = await req<BlobMeta | undefined>(os.get(key));
        if (m) await req(os.put({ ...m, usedAt: now }));
      }).catch(() => undefined);
    }
    return { data: got.data, fetchedAt: got.meta.fetchedAt, ttlMs: got.meta.ttlMs };
  }

  putBlob(key: string, data: Uint8Array, ttlMs: number, fetchedAt = Date.now()): Promise<void> {
    // a view into a larger buffer would be stored whole by structured clone: keep exactly the viewed bytes
    const exact = data.byteOffset === 0 && data.buffer.byteLength === data.byteLength ? data : data.slice();
    const rec: BlobRecord = { key, data: exact };
    const meta: BlobMeta = { key, bytes: exact.byteLength, fetchedAt, ttlMs, usedAt: fetchedAt };
    return withQuotaRetry(() => this.tx([BLOB_STORE, BLOB_META_STORE], 'readwrite', async (tx) => {
      await Promise.all([req(tx.objectStore(BLOB_STORE).put(rec)), req(tx.objectStore(BLOB_META_STORE).put(meta))]);
    }), this.hook, { store: 'blob', key });
  }

  deleteBlob(key: string): Promise<void> {
    return this.tx([BLOB_STORE, BLOB_META_STORE], 'readwrite', async (tx) => {
      await Promise.all([req(tx.objectStore(BLOB_STORE).delete(key)), req(tx.objectStore(BLOB_META_STORE).delete(key))]);
    });
  }

  async blobInfo(key: string): Promise<BlobInfo | undefined> {
    const m = await this.tx([BLOB_META_STORE], 'readonly', (tx) => req<BlobMeta | undefined>(tx.objectStore(BLOB_META_STORE).get(key)));
    return m && { fetchedAt: m.fetchedAt, ttlMs: m.ttlMs, bytes: m.bytes };
  }

  touchBlob(key: string, ttlMs: number, fetchedAt = Date.now()): Promise<void> {
    return this.tx([BLOB_META_STORE], 'readwrite', async (tx) => {
      const os = tx.objectStore(BLOB_META_STORE);
      const m = await req<BlobMeta | undefined>(os.get(key));
      if (m) await req(os.put({ ...m, fetchedAt, ttlMs, usedAt: fetchedAt }));
    });
  }

  /** Accounting rows under `prefix`, read through the `usedAt` index (oldest use first); never the bytes. */
  private blobRows(tx: IDBTransaction, prefix: string): Promise<BlobMeta[]> {
    return new Promise((resolve, reject) => {
      const out: BlobMeta[] = [];
      const c = tx.objectStore(BLOB_META_STORE).index(USED_AT_INDEX).openCursor();
      c.onerror = () => reject(c.error);
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return resolve(out);
        const m = cur.value as BlobMeta;
        if (m.key.startsWith(prefix)) out.push(m);
        cur.continue();
      };
    });
  }

  async blobStats(prefix: string): Promise<{ count: number; bytes: number }> {
    const rows = await this.tx([BLOB_META_STORE], 'readonly', (tx) => this.blobRows(tx, prefix));
    return { count: rows.length, bytes: rows.reduce((n, r) => n + r.bytes, 0) };
  }

  trimBlobs(prefix: string, maxBytes: number): Promise<number> {
    return this.tx([BLOB_STORE, BLOB_META_STORE], 'readwrite', async (tx) => {
      const victims = lruVictims(await this.blobRows(tx, prefix), maxBytes);
      for (const k of victims) await Promise.all([req(tx.objectStore(BLOB_STORE).delete(k)), req(tx.objectStore(BLOB_META_STORE).delete(k))]);
      return victims.length;
    });
  }

  /** Walks only the `expiresAt` index below the cutoff with a key cursor: values are never read, kept prefixes are skipped. */
  prune(maxAgeMs: number, now = Date.now(), keepPrefixes: readonly string[] = []): Promise<number> {
    return this.tx([KV_STORE], 'readwrite', (tx) => new Promise<number>((resolve, reject) => {
      let n = 0;
      const os = tx.objectStore(KV_STORE);
      const c = os.index(EXPIRES_AT_INDEX).openKeyCursor(this.keyRange.upperBound(now - maxAgeMs, true));
      c.onerror = () => reject(c.error);
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return resolve(n);
        const key = String(cur.primaryKey);
        if (!keepPrefixes.some((p) => key.startsWith(p))) { os.delete(key); n++; }
        cur.continue();
      };
    }));
  }
}

export interface OpenedKv {
  kv: KvStore;
  /** false when IndexedDB could not be opened (private mode, blocked, disabled) and the data lives in memory only */
  persistent: boolean;
  /** why the fallback was used, for the health report */
  error?: string;
}

/** Open the IndexedDB store, or fall back to memory when the browser refuses (the app then works, but nothing survives a reload). */
export async function openKv(opts: IdbKvOptions = {}): Promise<OpenedKv> {
  try {
    return { kv: await IdbKv.open(opts), persistent: true };
  } catch (err) {
    return { kv: new MemoryKv(), persistent: false, error: err instanceof Error ? err.message : String(err) };
  }
}
