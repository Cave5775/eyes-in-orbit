import { inProcessLock, type WithLock } from './lock';

/**
 * The browser lock: `navigator.locks.request(name, fn)` (exclusive, origin-wide, shared by every tab and worker). Falls back to
 * the in-process lock where the Web Locks API is missing. Browser-only; the pure engine takes a `WithLock` by injection.
 */
export function webLocks(locks: LockManager | undefined = typeof navigator === 'undefined' ? undefined : navigator.locks): WithLock {
  if (!locks) return inProcessLock();
  return <T>(name: string, fn: () => Promise<T>): Promise<T> => locks.request(name, fn) as Promise<T>;
}
