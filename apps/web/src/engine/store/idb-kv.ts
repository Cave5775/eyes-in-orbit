import {
  BLOB_USED_THROTTLE_MS, isPrunable, isQuotaError, lruVictims,
  type BlobInfo, type BlobRow, type CacheRow, type KvStore,
} from './types';

/** One IndexedDB database, two object stores mirroring the former SQLite tables. */
export const DB_NAME = 'eio';
/** Bump when a store or index changes and add a step to `upgrade`; per-key `v1`/`v2` suffixes stay for value formats. */
export const DB_VERSION = 1;
export const KV_STORE = 'kv';
export const BLOB_STORE = 'blob';
export const USED_AT_INDEX = 'usedAt';

interface KvRecord { key: string; value: unknown; fetchedAt: number; ttlMs: number }
interface BlobRecord { key: string; data: Uint8Array; bytes: number; fetchedAt: number; ttlMs: number; usedAt: number }

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

/** Create the stores and indexes of every version after `oldVersion`. */
export function upgrade(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    db.createObjectStore(KV_STORE, { keyPath: 'key' });
    db.createObjectStore(BLOB_STORE, { keyPath: 'key' }).createIndex(USED_AT_INDEX, 'usedAt');
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


export class IdbKv implements KvStore {
  private constructor(private db: IDBDatabase, private keyRange: typeof IDBKeyRange, private hook?: QuotaHook) {}

  private prefixRange(prefix: string): IDBKeyRange | undefined {
    return prefix ? this.keyRange.bound(prefix, `${prefix}￿`) : undefined;
  }

  static async open(opts: IdbKvOptions = {}): Promise<IdbKv> {
    const factory = opts.factory ?? indexedDB;
    const open = factory.open(opts.name ?? DB_NAME, DB_VERSION);
    open.onupgradeneeded = (e) => upgrade(open.result, e.oldVersion);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('the IndexedDB upgrade is blocked by another tab'));
    });
    // another tab upgrading the database must not be held up by this connection
    db.onversionchange = () => db.close();
    return new IdbKv(db, opts.keyRange ?? IDBKeyRange, opts.onQuotaExceeded);
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` in one transaction; resolves with its result once the transaction committed. */
  private tx<T>(stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const tx = this.db.transaction(stores, mode);
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
    const rec: KvRecord = { key, value, fetchedAt, ttlMs };
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
    return this.tx([BLOB_STORE], 'readwrite', async (tx) => {
      const os = tx.objectStore(BLOB_STORE);
      const r = await req<BlobRecord | undefined>(os.get(key));
      if (!r) return undefined;
      if (now - r.usedAt > BLOB_USED_THROTTLE_MS) await req(os.put({ ...r, usedAt: now }));
      return { data: r.data, fetchedAt: r.fetchedAt, ttlMs: r.ttlMs };
    });
  }

  putBlob(key: string, data: Uint8Array, ttlMs: number, fetchedAt = Date.now()): Promise<void> {
    const rec: BlobRecord = { key, data, bytes: data.byteLength, fetchedAt, ttlMs, usedAt: fetchedAt };
    return withQuotaRetry(() => this.tx([BLOB_STORE], 'readwrite', async (tx) => void (await req(tx.objectStore(BLOB_STORE).put(rec)))), this.hook, { store: 'blob', key });
  }

  deleteBlob(key: string): Promise<void> {
    return this.tx([BLOB_STORE], 'readwrite', async (tx) => void (await req(tx.objectStore(BLOB_STORE).delete(key))));
  }

  async blobInfo(key: string): Promise<BlobInfo | undefined> {
    const r = await this.tx([BLOB_STORE], 'readonly', (tx) => req<BlobRecord | undefined>(tx.objectStore(BLOB_STORE).get(key)));
    return r && { fetchedAt: r.fetchedAt, ttlMs: r.ttlMs, bytes: r.bytes };
  }

  touchBlob(key: string, ttlMs: number, fetchedAt = Date.now()): Promise<void> {
    return this.tx([BLOB_STORE], 'readwrite', async (tx) => {
      const os = tx.objectStore(BLOB_STORE);
      const r = await req<BlobRecord | undefined>(os.get(key));
      if (r) await req(os.put({ ...r, fetchedAt, ttlMs, usedAt: fetchedAt }));
    });
  }

  /** Rows under `prefix` as (key, bytes, usedAt), read through the `usedAt` index (oldest use first). */
  private blobRows(tx: IDBTransaction, prefix: string): Promise<{ key: string; bytes: number; usedAt: number }[]> {
    return new Promise((resolve, reject) => {
      const out: { key: string; bytes: number; usedAt: number }[] = [];
      const c = tx.objectStore(BLOB_STORE).index(USED_AT_INDEX).openCursor();
      c.onerror = () => reject(c.error);
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return resolve(out);
        const r = cur.value as BlobRecord;
        if (r.key.startsWith(prefix)) out.push({ key: r.key, bytes: r.bytes, usedAt: r.usedAt });
        cur.continue();
      };
    });
  }

  async blobStats(prefix: string): Promise<{ count: number; bytes: number }> {
    const rows = await this.tx([BLOB_STORE], 'readonly', (tx) => this.blobRows(tx, prefix));
    return { count: rows.length, bytes: rows.reduce((n, r) => n + r.bytes, 0) };
  }

  trimBlobs(prefix: string, maxBytes: number): Promise<number> {
    return this.tx([BLOB_STORE], 'readwrite', async (tx) => {
      const victims = lruVictims(await this.blobRows(tx, prefix), maxBytes);
      const os = tx.objectStore(BLOB_STORE);
      for (const k of victims) await req(os.delete(k));
      return victims.length;
    });
  }

  prune(maxAgeMs: number, now = Date.now(), keepPrefixes: readonly string[] = []): Promise<number> {
    return this.tx([KV_STORE], 'readwrite', (tx) => new Promise<number>((resolve, reject) => {
      let n = 0;
      const c = tx.objectStore(KV_STORE).openCursor();
      c.onerror = () => reject(c.error);
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return resolve(n);
        const r = cur.value as KvRecord;
        if (isPrunable(r, r.key, maxAgeMs, now, keepPrefixes)) { cur.delete(); n++; }
        cur.continue();
      };
    }));
  }
}
