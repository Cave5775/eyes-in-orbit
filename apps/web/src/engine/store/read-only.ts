import type { KvStore } from './types';

/**
 * A view of a store that reads through and swallows every write. The startup pass that fills the hub from the cache runs connectors
 * against it, so a connector that finds a row stale (and records a backoff gate or a failure for it) leaves the real store alone.
 */
export function readOnlyKv(inner: KvStore): KvStore {
  const none = async (): Promise<void> => undefined;
  return {
    get: (key) => inner.get(key),
    list: (prefix) => inner.list(prefix),
    getBlob: (key) => inner.getBlob(key, 0), // `now` 0 never passes the used-at throttle: a read does not write
    blobInfo: (key) => inner.blobInfo(key),
    blobStats: (prefix) => inner.blobStats(prefix),
    put: none, delete: none, putBlob: none, deleteBlob: none, touchBlob: none,
    trimBlobs: async () => 0,
    prune: async () => 0,
  };
}
