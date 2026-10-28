import { HttpError, TIMEOUT_MS, USER_AGENT, diagnosticHeaders, requestHeaders, withCauseCode } from './http-util';
import { isFresh, type Store } from './store';

export { HttpError, USER_AGENT };

export interface Cached<T> {
  value: T;
  /** served from SQLite instead of a fresh response */
  fromCache: boolean;
  /** served from cache because the network (or parse) failed; `error` says why */
  stale: boolean;
  fetchedAt: number;
  error?: string;
}

export interface HttpOptions {
  offline?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class Http {
  private inflight = new Map<string, Promise<Cached<unknown>>>();

  constructor(private store: Store, private opts: HttpOptions = {}) {}

  get offline(): boolean {
    return !!this.opts.offline;
  }

  /**
   * GET text with UA header and timeout; throws `HttpError` on non-2xx (with `retry-after`/`server`/`cf-ray`/`via` and
   * a body excerpt) and an error whose message carries undici's cause code on network failures.
   */
  async text(url: string, headers: Record<string, string> = {}): Promise<string> {
    const { res, body } = await this.request(url, headers);
    if (!res.ok) throw httpError(res, url, body);
    return body;
  }

  private async request(url: string, headers: Record<string, string>): Promise<{ res: Response; body: string }> {
    if (this.opts.offline) throw new Error('offline (OFFLINE=1)');
    try {
      const res = await (this.opts.fetch ?? fetch)(url, {
        headers: requestHeaders(headers),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? TIMEOUT_MS),
      });
      return { res, body: await res.text() };
    } catch (err) {
      throw withCauseCode(err);
    }
  }

  /**
   * Fresh cache hit returns without network. Otherwise fetch + `parse` + store; if that fails
   * the stale cache entry (any age) is returned with `stale: true`, or the error is thrown.
   */
  cachedFetch<T>(
    key: string, url: string, ttlMs: number, parse: (text: string) => T, headers?: Record<string, string>,
  ): Promise<Cached<T>> {
    const pending = this.inflight.get(key) as Promise<Cached<T>> | undefined;
    if (pending) return pending;
    const p = this.load(key, url, ttlMs, parse, headers).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async load<T>(
    key: string, url: string, ttlMs: number, parse: (text: string) => T, headers?: Record<string, string>,
  ): Promise<Cached<T>> {
    const row = this.store.get<T>(key);
    if (row && (isFresh(row) || this.opts.offline)) {
      return { value: row.value, fromCache: true, stale: !isFresh(row), fetchedAt: row.fetchedAt };
    }
    try {
      const { res, body } = await this.request(url, headers ?? {});
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
      return { value: row.value, fromCache: true, stale: true, fetchedAt: row.fetchedAt, error: (err as Error).message };
    }
  }
}

const httpError = (res: Response, url: string, body: string): HttpError =>
  new HttpError(res.status, url, body, diagnosticHeaders(res.headers));
