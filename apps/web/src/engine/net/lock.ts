/**
 * A named mutual-exclusion lock around an async critical section. The limiter takes one per source so that read -> decide ->
 * write of its persisted state cannot interleave, in this tab or (with the Web Locks implementation in `lock.browser.ts`)
 * across tabs and workers of the same origin.
 *
 * NO NESTING: a critical section must never ask for the same name again (directly, or by calling something that does, such as
 * a limiter method from inside a limiter callback). The inner request waits for the outer one, which waits for the inner one:
 * a deadlock, and with Web Locks one that spans tabs. Take different names, or restructure so the section does one thing.
 * `maxWaitMs` below turns such a deadlock into an error in development.
 */
export type WithLock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export interface LockOptions {
  /**
   * Reject a caller that has waited longer than this for the lock (its section then never runs). Off by default; tests and
   * development builds set it to catch a nested same-name acquire, which otherwise hangs silently.
   */
  maxWaitMs?: number;
}

/** A lock that serialises callers inside this JS realm only (tests, and the fallback where Web Locks are missing). */
export function inProcessLock(opts: LockOptions = {}): WithLock {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(name: string, fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let abandoned = false;
      const timer = opts.maxWaitMs === undefined ? undefined : setTimeout(() => {
        abandoned = true;
        reject(new Error(`lock "${name}" not acquired within ${opts.maxWaitMs} ms: a nested acquire of the same name, or a section that never ends`));
      }, opts.maxWaitMs);
      const run = (tails.get(name) ?? Promise.resolve()).then(() => {
        clearTimeout(timer);
        return abandoned ? undefined : fn().then(resolve, reject);
      });
      // the next caller waits for this one to settle, whether it resolved or threw
      const tail = run.then(() => undefined, () => undefined);
      tails.set(name, tail);
      void tail.then(() => { if (tails.get(name) === tail) tails.delete(name); });
    });
}
