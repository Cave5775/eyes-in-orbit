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

/**
 * The host is not reachable at all: TCP connect timeout or reset (undici cause codes, kept in the message by `http.ts`).
 * From the app this looks the same as an IP-level block or a server outage. A run stops after the first one (no point
 * trying ten more groups), but the retry schedule stays short because an outage usually ends on its own.
 */
export const isConnectError = (message: string): boolean => /\b(UND_ERR_CONNECT_TIMEOUT|ECONNRESET|ETIMEDOUT)\b/.test(message);

/**
 * HTTP 403/429 means the source is rate-limiting this IP, and an unreachable host (connect timeout or reset) is
 * treated the same; anything else (total-request timeout, 5xx, bad JSON) is probably transient.
 */
export const isBlockError = (message: string): boolean => /\bHTTP (403|429)\b/.test(message) || isConnectError(message);

/** The longest `Retry-After` that is honoured beyond the normal cap (24 h). */
export const MAX_RETRY_AFTER_MS = 24 * 3600_000;

/**
 * `Retry-After` from a failure message (`http.ts` writes it as `retry-after=<value>` inside the brackets): a delay in
 * seconds or an HTTP date. Returns ms from `now`, or undefined when absent or unparsable.
 */
export function retryAfterMs(message: string, now = Date.now()): number | undefined {
  const raw = /retry-after=([^;\]]+)/i.exec(message)?.[1]?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(at - now, 0) : undefined;
}

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
  // never retry sooner than the source asked for (`Retry-After`), nor sooner than our own schedule
  // a dead host (connect error) may be an outage that ends within the hour, so it keeps the short schedule; only 403/429 wait hours
  const wait = Math.max(backoffMs(failures, isBlockError(message) && !isConnectError(message)), Math.min(retryAfterMs(message, now) ?? 0, MAX_RETRY_AFTER_MS));
  const next: Backoff = { failures, notBefore: now + wait, message };
  store.set(backoffKey(source), next, MAX_BACKOFF_MS * 2, now);
  return next;
}

export function clearBackoff(store: Store, source: string): void {
  store.delete(backoffKey(source));
}
