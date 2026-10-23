import type { Store } from './store';

/**
 * Persistent per-source retry gate. CelesTrak answers HTTP 403 to clients that re-download unchanged data, so a
 * failed source must stay quiet across restarts too: the "not before" time lives in the SQLite store, not in memory.
 */
export interface Backoff {
  failures: number;
  /** ms since epoch; no network request to the source before this */
  notBefore: number;
  message?: string;
}

const BLOCKED_BASE_MS = 3 * 3600_000;
const TRANSIENT_BASE_MS = 30 * 60_000;
export const MAX_BACKOFF_MS = 12 * 3600_000;

/** HTTP 403/429 means the source is rate-limiting this IP; anything else (timeout, 5xx, bad JSON) is probably transient. */
export const isBlockError = (message: string): boolean => /\bHTTP (403|429)\b/.test(message);

/**
 * How long to leave a source alone after its `failures`-th consecutive failure.
 */
export function backoffMs(failures: number, blocked: boolean): number {
  const base = blocked ? BLOCKED_BASE_MS : TRANSIENT_BASE_MS;
  return Math.min(base * 2 ** (Math.max(failures, 1) - 1), MAX_BACKOFF_MS);
}

export const backoffKey = (source: string): string => `backoff:${source}`;

/** The stored gate, whether or not it is still in force. */
export function readBackoff(store: Store, source: string): Backoff | undefined {
  return store.get<Backoff>(backoffKey(source))?.value;
}

/** True while the gate is closed. */
export const isBackedOff = (b: Backoff | undefined, now = Date.now()): b is Backoff => !!b && b.notBefore > now;

/** Count another failure and close the gate for `backoffMs`; returns the new state. */
export function recordFailure(store: Store, source: string, err: unknown, now = Date.now()): Backoff {
  const message = err instanceof Error ? err.message : String(err);
  const failures = (readBackoff(store, source)?.failures ?? 0) + 1;
  const next: Backoff = { failures, notBefore: now + backoffMs(failures, isBlockError(message)), message };
  store.set(backoffKey(source), next, MAX_BACKOFF_MS * 2, now);
  return next;
}

export function clearBackoff(store: Store, source: string): void {
  store.delete(backoffKey(source));
}
