import { HttpError, TIMEOUT_MS, USER_AGENT, diagnosticHeaders, requestHeaders, withCauseCode } from './http-util';
import { guardedFetch } from './net/guarded-fetch';
import { LimitedError, limiterFor, type Limiter, type LimitMode } from './net/limiter';
import { sourceForUrl } from './net/limits';
import { isFresh, type Store } from './store';

export { HttpError, USER_AGENT, LimitedError };

/** How a request is limited: the source key (default: from the URL's host) and the mode (`poll` default). */
export interface RequestOptions {
  source?: string;
  mode?: LimitMode;
  /** a `demand` request may wait this long for the spacing gap (follow-up requests of one lookup) */
  waitMs?: number;
}

export interface Cached<T> {
  value: T;
  /** served from SQLite instead of a fresh response */
  fromCache: boolean;
  /** served from cache because the network (or parse) failed; `error` says why */
  stale: boolean;
  fetchedAt: number;
  error?: string;
  /** the stale copy is served because a request limit applies (nothing was sent): the time asking is possible again */
  limitedUntil?: number;
}

export interface HttpOptions {
  offline?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** the request limiter (default: the store's own, `limiterFor`) */
  limiter?: Limiter;
}

export class Http {
  private inflight = new Map<string, Promise<Cached<unknown>>>();
  readonly limiter: Limiter;

  constructor(private store: Store, private opts: HttpOptions = {}) {
    this.limiter = opts.limiter ?? limiterFor(store);
  }

  get offline(): boolean {
    return !!this.opts.offline;
  }

  /**
   * GET text with UA header and timeout; throws `HttpError` on non-2xx (with `retry-after`/`server`/`cf-ray`/`via` and
   * a body excerpt) and an error whose message carries undici's cause code on network failures.
   */
  async text(url: string, headers: Record<string, string> = {}, ro: RequestOptions = {}): Promise<string> {
    const { res, body } = await this.request(url, headers, ro);
    if (!res.ok) throw httpError(res, url, body);
    return body;
  }

  /** Every request goes through the limiter (`net/guarded-fetch.ts`); a limited one throws `LimitedError` without sending. */
  private async request(url: string, headers: Record<string, string>, ro: RequestOptions = {}): Promise<{ res: Response; body: string }> {
    if (this.opts.offline) throw new Error('offline (OFFLINE=1)');
    const source = ro.source ?? sourceForUrl(url);
    try {
      const r = await guardedFetch(this.limiter, source, url, {
        headers: requestHeaders(headers),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? TIMEOUT_MS),
      }, { mode: ro.mode ?? 'poll', fetch: this.opts.fetch, waitMs: ro.waitMs });
      if ('limited' in r) throw new LimitedError(source, r.retryAt, r.reason, r.kind);
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

  private async load<T>(
    key: string, url: string, ttlMs: number, parse: (text: string) => T, headers?: Record<string, string>, ro?: RequestOptions,
  ): Promise<Cached<T>> {
    const row = this.store.get<T>(key);
    if (row && (isFresh(row) || this.opts.offline)) {
      return { value: row.value, fromCache: true, stale: !isFresh(row), fetchedAt: row.fetchedAt };
    }
    try {
      const { res, body } = await this.request(url, headers ?? {}, ro);
      if (res.status === 304 && row) {
        // not modified since the `if-modified-since` the caller sent: keep the entry and restart its TTL
        const fetchedAt = Date.now();
        this.store.set(key, row.value, ttlMs, fetchedAt);
        return { value: row.value, fromCache: true, stale: false, fetchedAt };
      }
      if (!res.ok) throw httpError(res, url, body);
      const value = parse(body);
      const fetchedAt = Date.now();
      this.store.set(key, value, ttlMs, fetchedAt);
      return { value, fromCache: false, stale: false, fetchedAt };
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
