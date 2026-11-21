/**
 * A named mutual-exclusion lock around an async critical section. The limiter takes one per source so that read -> decide ->
 * write of its persisted state cannot interleave, in this tab or (with the Web Locks implementation in `lock.browser.ts`)
 * across tabs and workers of the same origin.
 */
export type WithLock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** A lock that serialises callers inside this JS realm only (tests, and the fallback where Web Locks are missing). */
export function inProcessLock(): WithLock {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const run = (tails.get(name) ?? Promise.resolve()).then(fn, fn);
    // the next caller waits for this one to settle, whether it resolved or threw
    const tail = run.then(() => undefined, () => undefined);
    tails.set(name, tail);
    void tail.then(() => { if (tails.get(name) === tail) tails.delete(name); });
    return run;
  };
}
