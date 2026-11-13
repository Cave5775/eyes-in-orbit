import type { Description } from '@eio/core';

/** An About lookup (or its answer) is reused this long per entity, so re-opening the tab never asks the server again. */
export const DESCRIBE_REUSE_MS = 60_000;

export interface DescribeCache {
  /** the in-flight or last answer for `entityId` when it is younger than `DESCRIBE_REUSE_MS`, else a new lookup */
  get(entityId: string): Promise<Description>;
  clear(): void;
}

/**
 * Per-entity reuse of `GET /api/describe/:id` in the browser: concurrent opens share one request and a settled real answer
 * is kept for 60 s. A failed request and a "rate limited" answer (`limitedUntil`) are forgotten at once, so the next open
 * asks again and the server's limiter decides (it answers from its cache or says limited again, without a request).
 * The server has its own cache and request limits; this only keeps rapid re-selection from reaching it.
 */
export function createDescribeCache(
  load: (entityId: string) => Promise<Description>, opts: { now?: () => number; reuseMs?: number } = {},
): DescribeCache {
  const now = opts.now ?? Date.now;
  const reuseMs = opts.reuseMs ?? DESCRIBE_REUSE_MS;
  const entries = new Map<string, { promise: Promise<Description>; at: number }>();
  return {
    get(entityId) {
      const hit = entries.get(entityId);
      if (hit && now() - hit.at < reuseMs) return hit.promise;
      const entry = { promise: load(entityId), at: now() };
      entries.set(entityId, entry);
      entry.promise.then(
        (d) => {
          if (d.limitedUntil !== undefined) {
            if (entries.get(entityId) === entry) entries.delete(entityId);
          } else entry.at = now();
        },
        () => { if (entries.get(entityId) === entry) entries.delete(entityId); },
      );
      return entry.promise;
    },
    clear: () => entries.clear(),
  };
}

const hhmmZ = (ms: number): string => new Date(ms).toISOString().slice(11, 16) + 'Z';

/** "rate limited, try again at 14:30Z" when the server did not ask a source because of its request limit, else undefined. */
export function limitedNotice(d: Pick<Description, 'limitedUntil'>): string | undefined {
  return d.limitedUntil !== undefined ? `rate limited, try again at ${hhmmZ(d.limitedUntil)}` : undefined;
}
