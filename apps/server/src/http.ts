import { isFresh, type Store } from './store';

export const USER_AGENT = 'EyesInOrbit/0.1 (local mission control)';
const TIMEOUT_MS = 20_000;

export class HttpError extends Error {
  constructor(public status: number, url: string, body = '') {
    super(`HTTP ${status} for ${url}${body ? `: ${body.slice(0, 160).replace(/\s+/g, ' ')}` : ''}`);
  }
}

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

  /** GET text with UA header and timeout; throws `HttpError` on non-2xx. */
  async text(url: string, headers: Record<string, string> = {}): Promise<string> {
    if (this.opts.offline) throw new Error('offline (OFFLINE=1)');
    const res = await (this.opts.fetch ?? fetch)(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/xml, */*', ...headers },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? TIMEOUT_MS),
    });
    const body = await res.text();
    if (!res.ok) throw new HttpError(res.status, url, body);
    return body;
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
      const value = parse(await this.text(url, headers));
      const fetchedAt = Date.now();
      this.store.set(key, value, ttlMs, fetchedAt);
      return { value, fromCache: false, stale: false, fetchedAt };
    } catch (err) {
      if (!row) throw err;
      return { value: row.value, fromCache: true, stale: true, fetchedAt: row.fetchedAt, error: (err as Error).message };
    }
  }
}
