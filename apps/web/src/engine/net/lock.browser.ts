import { inProcessLock, type WithLock } from './lock';

const defaultLocks = (): LockManager | undefined => (typeof navigator === 'undefined' ? undefined : navigator.locks);

/** Whether the Web Locks API is there. When it is not, `webLocks` serialises this tab only and cross-tab limits can race (show it in health). */
/** `null` means "no Web Locks" (tests); undefined looks at `navigator.locks`. */
export const webLocksAvailable = (locks: LockManager | null | undefined = defaultLocks()): boolean => !!locks;

export interface WebLocksOptions {
  /** give up waiting for a lock after this long and reject (the section never runs); a held lock is not interrupted. Default: wait. */
  timeoutMs?: number;
}

/**
 * The browser lock: `navigator.locks.request(name, fn)` (exclusive, origin-wide, shared by every tab and worker). Falls back to
 * the in-process lock where the Web Locks API is missing (`webLocksAvailable()` says which). Browser-only; the pure engine
 * takes a `WithLock` by injection. Sections must not nest the same name (see `lock.ts`).
 */
export function webLocks(locks: LockManager | null | undefined = defaultLocks(), opts: WebLocksOptions = {}): WithLock {
  if (!locks) return inProcessLock(opts.timeoutMs === undefined ? {} : { maxWaitMs: opts.timeoutMs });
  if (opts.timeoutMs === undefined) return <T>(name: string, fn: () => Promise<T>): Promise<T> => locks.request(name, fn) as Promise<T>;
  const { timeoutMs } = opts;
  return <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error(`lock "${name}" not acquired within ${timeoutMs} ms`)), timeoutMs);
    // the abort only cancels a request that is still waiting; once granted the section runs to its end
    return locks.request(name, { signal: ctl.signal }, async () => { clearTimeout(timer); return fn(); }) as Promise<T>;
  };
}
