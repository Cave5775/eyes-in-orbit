import { describe, expect, it, vi } from 'vitest';
import { Http, HttpError } from '../../src/engine/http';
import { Limiter } from '../../src/engine/net/limiter';
import { MemoryKv, isFresh } from '../../src/engine/store';

const response = (body: string, status = 200) => new Response(body, { status });

function setup(opts: { offline?: boolean } = {}) {
  const store = new MemoryKv();
  const fetchMock = vi.fn<typeof fetch>();
  // the limiter has its own tests (limiter.test.ts); an empty table makes every source unlimited here
  const http = new Http(store, { fetch: fetchMock, limiter: new Limiter(store, { limits: {} }), ...opts });
  return { store, fetchMock, http };
}

describe('Store', () => {
  it('round-trips JSON and reports TTL freshness', async () => {
    const store = new MemoryKv();
    await store.put('k', { a: [1, 2] }, 1000, 5_000);
    const row = (await store.get<{ a: number[] }>('k'))!;
    expect(row.value).toEqual({ a: [1, 2] });
    expect(isFresh(row, 5_999)).toBe(true);
    expect(isFresh(row, 6_000)).toBe(false);
    expect((await store.get('missing'))).toBeUndefined();
  });

  it('upserts and prunes long-expired rows', async () => {
    const store = new MemoryKv();
    await store.put('old', 1, 10, 0);
    await store.put('new', 2, 10, 1_000_000);
    await store.put('old', 3, 10, 0);
    expect((await store.get('old'))!.value).toBe(3);
    expect(await store.prune(1000, 1_000_100)).toBe(1);
    expect((await store.get('old'))).toBeUndefined();
    expect((await store.get('new'))).toBeDefined();
  });
});

describe('Http.cachedFetch', () => {
  it('cacheOnly serves a stale copy without any request and throws without one', async () => {
    const { http, fetchMock, store } = setup();
    await store.put('k', 'old', 1000, Date.now() - 10_000);
    const hit = await http.cachedFetch('k', 'https://x.test/a', 1000, String, undefined, { cacheOnly: true });
    expect(hit).toMatchObject({ value: 'old', fromCache: true, stale: true });
    await expect(http.cachedFetch('none', 'https://x.test/b', 1000, String, undefined, { cacheOnly: true })).rejects.toThrow(/cache only/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the cacheOnly option of the Http instance applies to every request, and a fresh hit is not stale', async () => {
    const store = new MemoryKv();
    const fetchMock = vi.fn<typeof fetch>();
    const http = new Http(store, { fetch: fetchMock, limiter: new Limiter(store, { limits: {} }), cacheOnly: true });
    await store.put('k', 'v', 60_000, Date.now());
    expect(await http.cachedFetch('k', 'https://x.test/a', 60_000, String)).toMatchObject({ value: 'v', fromCache: true, stale: false });
    await expect(http.text('https://x.test/c')).rejects.toThrow(/cache only/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends only the accept header (browsers cannot set a User-Agent) and parses the body', async () => {
    const { http, fetchMock } = setup();
    fetchMock.mockResolvedValue(response('{"n":1}'));
    const res = await http.cachedFetch('k', 'https://x.test/a', 60_000, (t) => JSON.parse(t));
    expect(res).toMatchObject({ value: { n: 1 }, fromCache: false, stale: false });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ accept: 'application/json, text/xml, */*' });
  });

  it('serves a fresh hit without touching the network', async () => {
    const { http, fetchMock } = setup();
    fetchMock.mockResolvedValue(response('"v1"'));
    await http.cachedFetch('k', 'https://x.test/a', 60_000, (t) => JSON.parse(t));
    const again = await http.cachedFetch('k', 'https://x.test/a', 60_000, (t) => JSON.parse(t));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ value: 'v1', fromCache: true, stale: false });
  });

  it('refetches once the TTL has expired', async () => {
    const { http, fetchMock, store } = setup();
    await store.put('k', 'old', 1000, Date.now() - 5000);
    fetchMock.mockResolvedValue(response('"new"'));
    const res = await http.cachedFetch('k', 'https://x.test/a', 1000, (t) => JSON.parse(t));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ value: 'new', fromCache: false });
    expect((await store.get('k'))!.value).toBe('new');
  });

  it('falls back to the stale entry on network failure, HTTP error and parse failure', async () => {
    const { http, fetchMock, store } = setup();
    const staleAt = Date.now() - 10_000;
    for (const failure of [
      () => Promise.reject(new Error('ECONNRESET')),
      () => Promise.resolve(response('rate limited', 429)),
      () => Promise.resolve(response('<html>not json</html>')),
    ]) {
      await store.put('k', 'stale', 1000, staleAt);
      fetchMock.mockImplementationOnce(failure);
      const res = await http.cachedFetch('k', 'https://x.test/a', 1000, (t) => JSON.parse(t));
      expect(res).toMatchObject({ value: 'stale', fromCache: true, stale: true });
      expect(res.error).toBeTruthy();
    }
  });

  it('throws when the network fails and nothing is cached', async () => {
    const { http, fetchMock } = setup();
    fetchMock.mockResolvedValue(response('nope', 503));
    await expect(http.cachedFetch('k', 'https://x.test/a', 1000, String)).rejects.toBeInstanceOf(HttpError);
  });

  it('offline: returns any cached entry and never fetches', async () => {
    const { http, fetchMock, store } = setup({ offline: true });
    await store.put('k', 'cached', 1000, 0);
    expect(await http.cachedFetch('k', 'https://x.test/a', 1000, String)).toMatchObject({ value: 'cached', fromCache: true, stale: true });
    await expect(http.cachedFetch('other', 'https://x.test/b', 1000, String)).rejects.toThrow(/offline/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shares one request between concurrent callers', async () => {
    const { http, fetchMock } = setup();
    fetchMock.mockResolvedValue(response('"v"'));
    await Promise.all([1, 2, 3].map(() => http.cachedFetch('k', 'https://x.test/a', 1000, (t) => JSON.parse(t))));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Http failure details', () => {
  const connectTimeout = () => new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });

  it('keeps undici\'s cause code in the message of a network failure', async () => {
    const { http, fetchMock } = setup();
    fetchMock.mockRejectedValue(connectTimeout());
    await expect(http.text('https://x.test/a')).rejects.toThrow('fetch failed (UND_ERR_CONNECT_TIMEOUT)');
  });

  it('finds the code inside an AggregateError and leaves plain errors alone', async () => {
    const { http, fetchMock } = setup();
    const agg = new AggregateError([Object.assign(new Error('x'), { code: 'ETIMEDOUT' })]);
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed', { cause: agg }));
    await expect(http.text('https://x.test/a')).rejects.toThrow('fetch failed (ETIMEDOUT)');
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    await expect(http.text('https://x.test/a')).rejects.toThrow(/^boom$/);
  });

  it('passes the cause code on to the stale-cache error text', async () => {
    const { http, fetchMock, store } = setup();
    await store.put('k', 'stale', 1000, Date.now() - 10_000);
    fetchMock.mockRejectedValue(connectTimeout());
    const res = await http.cachedFetch('k', 'https://x.test/a', 1000, String);
    expect(res).toMatchObject({ stale: true, error: 'fetch failed (UND_ERR_CONNECT_TIMEOUT)' });
  });

  it('keeps retry-after, server, cf-ray, via and a body excerpt in the HttpError, with a bounded message', async () => {
    const { http, fetchMock } = setup();
    const body = 'x'.repeat(1000);
    fetchMock.mockResolvedValue(new Response(body, {
      status: 403, headers: { 'retry-after': '3600', server: 'cloudflare', 'cf-ray': '8abc-FRA', via: '1.1 proxy' },
    }));
    const err = await http.text('https://x.test/a').catch((e: unknown) => e) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(err.headers).toEqual({ 'retry-after': '3600', server: 'cloudflare', 'cf-ray': '8abc-FRA', via: '1.1 proxy' });
    expect(err.body).toHaveLength(300);
    expect(err.message).toContain('HTTP 403 for https://x.test/a');
    expect(err.message).toContain('retry-after=3600');
    expect(err.message).toContain('server=cloudflare');
    expect(err.message.length).toBeLessThan(350);
  });

  it('keeps the plain message when the response carries none of those headers', async () => {
    const { http, fetchMock } = setup();
    fetchMock.mockResolvedValue(response('denied', 403));
    await expect(http.text('https://x.test/a')).rejects.toThrow(/^HTTP 403 for https:\/\/x\.test\/a: denied$/);
  });
});

describe('Http conditional requests', () => {
  it('treats 304 as a cache hit and restarts the TTL', async () => {
    const { http, fetchMock, store } = setup();
    const old = Date.now() - 10_000;
    await store.put('k', { n: 1 }, 1000, old);
    fetchMock.mockResolvedValue(new Response(null, { status: 304 }));
    const parse = vi.fn((t: string) => JSON.parse(t));
    const res = await http.cachedFetch('k', 'https://x.test/a', 5000, parse, { 'if-modified-since': new Date(old).toUTCString() });
    expect(res).toMatchObject({ value: { n: 1 }, fromCache: true, stale: false });
    expect(res.error).toBeUndefined();
    expect(parse).not.toHaveBeenCalled();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['if-modified-since']).toBe(new Date(old).toUTCString());
    const row = (await store.get('k'))!;
    expect(row.fetchedAt).toBeGreaterThan(old);
    expect(row.ttlMs).toBe(5000);
    expect(isFresh(row)).toBe(true);
    // the next call is a plain fresh hit
    await http.cachedFetch('k', 'https://x.test/a', 5000, parse);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 304 without a cached copy is an error, not an empty value', async () => {
    const { http, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response(null, { status: 304 }));
    await expect(http.cachedFetch('k', 'https://x.test/a', 1000, String)).rejects.toBeInstanceOf(HttpError);
  });
});

describe('Http.cachedFetch when the cache cannot be written', () => {
  it('returns the fresh value with a storageError instead of discarding it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { http, fetchMock, store } = setup();
    vi.spyOn(store, 'put').mockRejectedValue(new DOMException('full', 'QuotaExceededError'));
    fetchMock.mockResolvedValue(response('{"n":2}'));
    const res = await http.cachedFetch('k', 'https://x.test/a', 60_000, (t) => JSON.parse(t));
    expect(res).toMatchObject({ value: { n: 2 }, fromCache: false, stale: false, storageError: 'full' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
