import { systemClock, type Clock } from './clock';
import { HttpError, TIMEOUT_MS, diagnosticHeaders, requestHeaders, withCauseCode } from './http-util';
import { guardedFetch } from './net/guarded-fetch';
import { LimitedError, type Limiter, type LimitMode } from './net/limiter';
import { sourceForUrl } from './net/limits';
import { isFresh, type KvStore } from './store';

export { HttpError, LimitedError };

/** How a request is limited: the source key (default: from the URL's host) and the mode (`poll` default). */
export interface RequestOptions {
  source?: string;
  mode?: LimitMode;
  /** a `demand` request may wait this long for the spacing gap (follow-up requests of one lookup) */
  waitMs?: number;
  /** serve only what the cache holds, even a stale copy, and never touch the network (a follower tab that another tab feeds) */
  cacheOnly?: boolean;
}

export interface Cached<T> {
  value: T;
  /** served from the cache instead of a fresh response */
  fromCache: boolean;
  /** served from cache because the network (or parse) failed; `error` says why */
  stale: boolean;
  fetchedAt: number;
  error?: string;
  /** the stale copy is served because a request limit applies (nothing was sent): the time asking is possible again */
  limitedUntil?: number;
  /** the fresh value could not be written to the store (quota, closed database); it is still returned, but is not cached */
  storageError?: string;
}

export interface HttpOptions {
  offline?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** the request limiter (required: it carries the shared store and lock) */
  limiter: Limiter;
  /** as `cacheOnly` on every request */
  cacheOnly?: boolean;
  /** time source for cache ages (default the system clock) */
  clock?: Pick<Clock, 'now'>;
}

export class Http {
  private inflight = new Map<string, Promise<Cached<unknown>>>();
  readonly limiter: Limiter;
  private clock: Pick<Clock, 'now'>;

  constructor(private store: KvStore, private opts: HttpOptions) {
    this.limiter = opts.limiter;
    this.clock = opts.clock ?? systemClock;
  }

  get offline(): boolean {
    return !!this.opts.offline;
  }

  /**
   * GET text with a timeout; throws `HttpError` on non-2xx (with `retry-after`/`server`/`cf-ray`/`via` and
   * a body excerpt) and an error whose message carries undici's cause code on network failures (browsers give no cause code).
   */
  async text(url: string, headers: Record<string, string> = {}, ro: RequestOptions = {}): Promise<string> {
    const { res, body } = await this.request(url, headers, ro);
    if (!res.ok) throw httpError(res, url, body);
    return body;
  }

  /** Every request goes through the limiter (`net/guarded-fetch.ts`; the upstream resolver there decides direct, relay or static); a limited one throws `LimitedError` without sending. */
  private async request(url: string, headers: Record<string, string>, ro: RequestOptions = {}): Promise<{ res: Response; body: string }> {
    if (this.opts.offline) throw new Error('offline (OFFLINE=1)');
    if (this.opts.cacheOnly || ro.cacheOnly) throw new Error('cache only: not requested');
    const source = ro.source ?? sourceForUrl(url);
    try {
      const r = await guardedFetch(this.limiter, source, url, {
        headers: requestHeaders(headers),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? TIMEOUT_MS),
      }, { mode: ro.mode ?? 'poll', fetch: this.opts.fetch, waitMs: ro.waitMs });
      if ('limited' in r) throw new LimitedError(source, r.retryAt, r.reason, r.kind, r.blockKind);
      return { res: r.response, body: await r.response.text() };
    } catch (err) {
      if (err instanceof LimitedError) throw err;
      throw withCauseCode(err);
    }
  }

  /**
   * Fresh cache hit returns without network. Otherwise fetch + `parse` + store; if that fails
   * the stale cache entry (any age) is returned with `stale: true`, or the error is thrown.
   */
  cachedFetch<T>(
    key: string, url: string, ttlMs: number, parse: (text: string) => T, headers?: Record<string, string>, ro?: RequestOptions,
  ): Promise<Cached<T>> {
    const pending = this.inflight.get(key) as Promise<Cached<T>> | undefined;
    if (pending) return pending;
    const p = this.load(key, url, ttlMs, parse, headers, ro).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Write to the cache; a failure is returned as text (and logged), never thrown over a good answer. */
  private async persist(key: string, value: unknown, ttlMs: number, fetchedAt: number): Promise<string | undefined> {
    try {
      await this.store.put(key, value, ttlMs, fetchedAt);
      return undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[http] could not cache ${key}: ${msg}`);
      return msg;
    }
  }

  private async load<T>(
    key: string, url: string, ttlMs: number, parse: (text: string) => T, headers?: Record<string, string>, ro?: RequestOptions,
  ): Promise<Cached<T>> {
    const row = await this.store.get<T>(key);
    const now = this.clock.now();
    if (row && (isFresh(row, now) || this.opts.offline || this.opts.cacheOnly || ro?.cacheOnly)) {
      return { value: row.value, fromCache: true, stale: !isFresh(row, now), fetchedAt: row.fetchedAt };
    }
    try {
      const { res, body } = await this.request(url, headers ?? {}, ro);
      if (res.status === 304 && row) {
        // not modified since the `if-modified-since` the caller sent: keep the entry and restart its TTL
        const fetchedAt = this.clock.now();
        const storageError = await this.persist(key, row.value, ttlMs, fetchedAt);
        return { value: row.value, fromCache: true, stale: false, fetchedAt, ...(storageError ? { storageError } : {}) };
      }
      if (!res.ok) throw httpError(res, url, body);
      const value = parse(body);
      const fetchedAt = this.clock.now();
      const storageError = await this.persist(key, value, ttlMs, fetchedAt);
      return { value, fromCache: false, stale: false, fetchedAt, ...(storageError ? { storageError } : {}) };
    } catch (err) {
      if (!row) throw err;
      return {
        value: row.value, fromCache: true, stale: true, fetchedAt: row.fetchedAt, error: (err as Error).message,
        ...(err instanceof LimitedError ? { limitedUntil: err.retryAt } : {}),
      };
    }
  }
}

const httpError = (res: Response, url: string, body: string): HttpError =>
  new HttpError(res.status, url, body, diagnosticHeaders(res.headers));
