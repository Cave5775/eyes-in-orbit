import { describe, expect, it } from 'vitest';
import { guardedFetch } from '../src/net/guarded-fetch';
import { LimitedError, Limiter, hhmmz, limitKey, parseRateLimitHeaders, parseRetryAfter } from '../src/net/limiter';
import { LIMITS, FEED_SOURCE, sourceForUrl, type SourceLimit } from '../src/net/limits';
import { Store } from '../src/store';

const T0 = Date.parse('2026-11-01T10:00:00Z');
const H = 3600_000;

/** a limiter on a controllable clock; `sleep` advances it */
function rig(limits: Record<string, SourceLimit> = LIMITS, store = new Store(':memory:')) {
  const c = { t: T0, sleeps: [] as number[] };
  const make = (s = store) => new Limiter(s, { limits, now: () => c.t, sleep: async (ms) => { c.sleeps.push(ms); c.t += ms; } });
  return { c, store, limiter: make(), make };
}

const table = (over: Partial<SourceLimit> = {}): Record<string, SourceLimit> => ({ src: { label: 'src', policy: 'test', minSpacingMs: 2000, ...over } });
const res = (status: number, headers: Record<string, string> = {}) => new Response('x', { status, headers });

describe('spacing', () => {
  it('refuses a second request inside the minimum gap and allows it after', () => {
    const { c, limiter } = rig(table());
    expect(limiter.tryAcquire('src', 'demand')).toEqual({ ok: true });
    expect(limiter.tryAcquire('src', 'demand')).toMatchObject({ limited: true, kind: 'spacing', retryAt: T0 + 2000 });
    c.t += 2000;
    expect(limiter.tryAcquire('src', 'demand')).toEqual({ ok: true });
  });

  it('a poll caller waits out a short gap; a demand caller never does (unless it allows a bounded wait)', async () => {
    const { c, limiter } = rig(table());
    await limiter.acquire('src', 'poll');
    expect(await limiter.acquire('src', 'poll')).toEqual({ ok: true });
    expect(c.sleeps).toEqual([2000]);
    c.sleeps.length = 0;
    const demand = await limiter.acquire('src', 'demand');
    expect(demand).toMatchObject({ limited: true, kind: 'spacing' });
    expect(c.sleeps).toEqual([]);
    c.t += 100;
    expect(await limiter.acquire('src', 'demand', 3000)).toEqual({ ok: true }); // follow-up of one lookup: waits 1.9 s
    expect(c.sleeps).toEqual([1900]);
  });

  it('a gap longer than maxWaitMs is rescheduled, not slept (iss-live: 30 s)', async () => {
    const { c, limiter } = rig();
    await limiter.acquire('iss-live', 'poll');
    const r = await limiter.acquire('iss-live', 'poll');
    expect(r).toMatchObject({ limited: true, kind: 'spacing', retryAt: T0 + 30_000 });
    expect(c.sleeps).toEqual([]);
  });
});

describe('hour and day caps', () => {
  it('counts per attempt and refuses until the window rolls over', () => {
    const { c, limiter } = rig(table({ minSpacingMs: 0, perHour: 3 }));
    for (let i = 0; i < 3; i++) expect(limiter.tryAcquire('src', 'poll')).toEqual({ ok: true });
    const r = limiter.tryAcquire('src', 'poll');
    expect(r).toMatchObject({ limited: true, kind: 'cap', retryAt: T0 + H });
    expect((r as { reason: string }).reason).toMatch(/hourly cap of 3/);
    c.t = T0 + H;
    expect(limiter.tryAcquire('src', 'poll')).toEqual({ ok: true });
    expect(limiter.status('src')).toMatchObject({ used: 1, cap: 3, window: 'hour' });
  });

  it('has a daily cap that outlasts the hour window', () => {
    const { c, limiter } = rig(table({ minSpacingMs: 0, perHour: 100, perDay: 2 }));
    limiter.tryAcquire('src', 'poll');
    c.t += 2 * H;
    limiter.tryAcquire('src', 'poll');
    c.t += 2 * H;
    expect(limiter.tryAcquire('src', 'poll')).toMatchObject({ limited: true, kind: 'cap', retryAt: T0 + 24 * H });
  });

  it('has a per-minute cap (DISCOS: 10 per minute)', () => {
    const { c, limiter } = rig();
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryAcquire('discos', 'poll')).toEqual({ ok: true });
      c.t += 1000;
    }
    expect(limiter.tryAcquire('discos', 'poll')).toMatchObject({ limited: true, kind: 'cap', retryAt: T0 + 60_000 });
  });

  it('SNAPI: 20 lookups per hour for demand calls on top of the poll, and the total cap of 32', () => {
    const { c, limiter } = rig();
    for (let i = 0; i < 20; i++) {
      expect(limiter.tryAcquire('snapi', 'demand')).toEqual({ ok: true });
      c.t += 2000;
    }
    expect(limiter.tryAcquire('snapi', 'demand')).toMatchObject({ limited: true, kind: 'cap' });
    expect(limiter.tryAcquire('snapi', 'poll')).toEqual({ ok: true }); // the poll still has its share
  });
});

describe('persistence', () => {
  it('a new limiter on the same store (a restart) keeps spacing, counters and blocks', () => {
    const { c, store, limiter, make } = rig(table({ perHour: 5 }));
    limiter.tryAcquire('src', 'poll');
    limiter.block('src', H, 'HTTP 429');
    const restarted = make(store);
    expect(restarted.state('src').hour?.count).toBe(1);
    expect(restarted.tryAcquire('src', 'poll')).toMatchObject({ limited: true, kind: 'blocked', retryAt: T0 + H });
    c.t += H;
    expect(restarted.tryAcquire('src', 'poll')).toEqual({ ok: true });
    expect(store.get(limitKey('src'))).toBeDefined();
  });

  it('writes the attempt BEFORE the request is sent: a crash during the request still counts', async () => {
    const { limiter, store } = rig(table());
    const seen: number[] = [];
    const fetchImpl = (async () => {
      seen.push(store.get<{ hour?: { count: number }; nextAllowedAt: number }>(limitKey('src'))?.value.nextAllowedAt ?? 0);
      throw new Error('process died');
    }) as unknown as typeof fetch;
    await expect(guardedFetch(limiter, 'src', 'https://example.test/', undefined, { mode: 'poll', fetch: fetchImpl })).rejects.toThrow('process died');
    expect(seen[0]).toBe(T0 + 2000); // already stored while the fetch was running
  });
});

describe('what the source says', () => {
  it('Retry-After in seconds blocks for at least that long (and never less than the table minimum)', () => {
    const { limiter } = rig();
    limiter.report('ll2', { status: 429, headers: new Headers({ 'retry-after': '7200' }) });
    expect(limiter.state('ll2').blockedUntil).toBe(T0 + 2 * H);
    const other = rig();
    other.limiter.report('ll2', { status: 429, headers: new Headers({ 'retry-after': '30' }) });
    expect(other.limiter.state('ll2').blockedUntil).toBe(T0 + H); // LL2: max(Retry-After, 1 h)
  });

  it('Retry-After as an HTTP date', () => {
    const { limiter } = rig();
    const at = new Date(T0 + 3 * H).toUTCString();
    limiter.report('celestrak', { status: 403, headers: new Headers({ 'retry-after': at }) });
    expect(limiter.state('celestrak').blockedUntil).toBe(T0 + 3 * H);
    expect(parseRetryAfter(at, T0)).toBe(3 * H);
    expect(parseRetryAfter('120', T0)).toBe(120_000);
    expect(parseRetryAfter('soon', T0)).toBeUndefined();
    expect(parseRetryAfter(undefined, T0)).toBeUndefined();
  });

  it('a Retry-After on a 503 blocks even where the table has no rule for it', () => {
    const { limiter } = rig();
    limiter.report('dsn', { status: 503, headers: new Headers({ 'retry-after': '90' }) });
    expect(limiter.state('dsn').blockedUntil).toBe(T0 + 90_000);
  });

  it('X-Rate-Limit headers: no requests remaining blocks until the reset; some remaining does nothing', () => {
    const { limiter } = rig();
    limiter.report('wheretheiss', { status: 200, headers: new Headers({ 'x-rate-limit-limit': '1', 'x-rate-limit-remaining': '1' }) });
    expect(limiter.state('wheretheiss').blockedUntil).toBeUndefined();
    limiter.report('wheretheiss', { status: 200, headers: new Headers({ 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String((T0 + 45_000) / 1000) }) });
    expect(limiter.state('wheretheiss').blockedUntil).toBe(T0 + 45_000);
    expect(parseRateLimitHeaders((n) => ({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '30' } as Record<string, string>)[n], T0)).toBe(30_000);
    expect(parseRateLimitHeaders((n) => ({ 'x-rate-limit-remaining': '0' } as Record<string, string>)[n], T0)).toBe(60_000);
  });

  it('a 429 or 503 from the table blocks (Horizons 503: 15 min), a 200 does not', () => {
    const { limiter } = rig();
    limiter.report('horizons', { status: 200 });
    expect(limiter.state('horizons').blockedUntil).toBeUndefined();
    limiter.report('horizons', { status: 503 });
    expect(limiter.state('horizons').blockedUntil).toBe(T0 + 15 * 60_000);
  });

  it('CelesTrak: three failed answers within 2 h stop it for 24 h', () => {
    const { c, limiter } = rig();
    limiter.report('celestrak', { status: 500 });
    c.t += 30 * 60_000;
    limiter.report('celestrak', { status: 500 });
    expect(limiter.state('celestrak').blockedUntil).toBeUndefined();
    c.t += 30 * 60_000;
    limiter.report('celestrak', { status: 500 });
    expect(limiter.state('celestrak').blockedUntil).toBe(c.t + 24 * H);
    expect(limiter.tryAcquire('celestrak', 'poll')).toMatchObject({ limited: true, kind: 'blocked' });
  });

  it('CelesTrak: failures more than 2 h apart do not add up', () => {
    const { c, limiter } = rig();
    for (let i = 0; i < 4; i++) {
      limiter.report('celestrak', { status: 500 });
      c.t += 3 * H;
    }
    expect(limiter.state('celestrak').blockedUntil).toBeUndefined();
  });

  it('DSN: persisted exponential backoff after failures, reset by a success', () => {
    const { c, limiter } = rig();
    limiter.report('dsn', { networkError: true });
    expect(limiter.state('dsn').blockedUntil).toBe(T0 + 30_000);
    c.t += 31_000;
    limiter.report('dsn', { status: 500 });
    expect(limiter.state('dsn').blockedUntil).toBe(c.t + 60_000);
    expect(limiter.consecutiveFailures('dsn')).toBe(2);
    c.t += 61_000;
    limiter.report('dsn', { status: 200 });
    expect(limiter.consecutiveFailures('dsn')).toBe(0);
  });

  it('Wikimedia: 429 backs off from 5 s, doubling, and honours a longer Retry-After', () => {
    const { c, limiter } = rig();
    limiter.report('wikimedia', { status: 429 });
    expect(limiter.state('wikimedia').blockedUntil).toBe(T0 + 5000);
    c.t += 6000;
    limiter.report('wikimedia', { status: 429 });
    expect(limiter.state('wikimedia').blockedUntil).toBe(c.t + 10_000);
    c.t += 11_000;
    limiter.report('wikimedia', { status: 429, headers: new Headers({ 'retry-after': '120' }) });
    expect(limiter.state('wikimedia').blockedUntil).toBe(c.t + 120_000);
    limiter.report('wikimedia', { status: 404 }); // an unknown article is not a rate limit
    expect(limiter.consecutiveFailures('wikimedia')).toBe(0);
  });

  it('a block never gets shorter by a later report', () => {
    const { limiter } = rig();
    limiter.block('celestrak', 5 * H, 'earlier');
    limiter.report('celestrak', { status: 403 }); // 3 h
    expect(limiter.state('celestrak').blockedUntil).toBe(T0 + 5 * H);
  });
});

describe('demand mode and guardedFetch', () => {
  it('answers limited immediately, without sending or sleeping, and does not count the refused call', async () => {
    const { c, limiter } = rig();
    let sent = 0;
    const fetchImpl = (async () => { sent++; return res(200); }) as unknown as typeof fetch;
    const a = await guardedFetch(limiter, 'wikimedia', 'https://en.wikipedia.org/x', undefined, { mode: 'demand', fetch: fetchImpl });
    expect('ok' in a).toBe(true);
    const b = await guardedFetch(limiter, 'wikimedia', 'https://en.wikipedia.org/y', undefined, { mode: 'demand', fetch: fetchImpl });
    expect(b).toMatchObject({ limited: true, kind: 'spacing', retryAt: T0 + 1500 });
    expect(sent).toBe(1);
    expect(c.sleeps).toEqual([]);
    expect(limiter.state('wikimedia').hour?.count).toBe(1);
  });

  it('reports the answer: a 429 with Retry-After blocks the source for the next call', async () => {
    const { c, limiter } = rig();
    const fetchImpl = (async () => res(429, { 'retry-after': '1800' })) as unknown as typeof fetch;
    await guardedFetch(limiter, 'snapi', 'https://api.spaceflightnewsapi.net/v4/articles/', undefined, { mode: 'poll', fetch: fetchImpl });
    c.t += 5000;
    const next = await guardedFetch(limiter, 'snapi', 'https://api.spaceflightnewsapi.net/v4/articles/', undefined, { mode: 'poll', fetch: fetchImpl });
    expect(next).toMatchObject({ limited: true, kind: 'blocked', retryAt: T0 + 1800_000 });
  });

  it('a network error is counted and rethrown', async () => {
    const { limiter } = rig();
    const fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(guardedFetch(limiter, 'dsn', 'https://eyes.nasa.gov/dsn/data/dsn.xml', undefined, { mode: 'poll', fetch: fetchImpl })).rejects.toThrow('fetch failed');
    expect(limiter.consecutiveFailures('dsn')).toBe(1);
    expect(limiter.state('dsn').blockedUntil).toBe(T0 + 30_000);
  });

  it('a source without a table entry is unlimited', async () => {
    const { limiter } = rig({});
    expect(limiter.tryAcquire('nothing', 'poll')).toEqual({ ok: true });
    expect(limiter.status('nothing')).toBeUndefined();
  });
});

describe('credential saves clear only the failure block', () => {
  it('keeps spacing, counters and the window; drops blockedUntil and the failure history', () => {
    const { c, limiter } = rig();
    limiter.tryAcquire('spacetrack:query', 'poll');
    limiter.block('spacetrack:query', 6 * H, 'failed login');
    limiter.report('spacetrack:query', { status: 500 });
    limiter.clearBlock('spacetrack:query');
    const s = limiter.state('spacetrack:query');
    expect(s.blockedUntil).toBeUndefined();
    expect(s.consecutiveFailures).toBe(0);
    expect(s.day?.count).toBe(1);
    expect(s.nextAllowedAt).toBe(T0 + 2 * H);
    c.t += 3600_000; // 1 h later: the 2 h gap still holds, so no immediate fetch
    expect(limiter.tryAcquire('spacetrack:query', 'poll')).toMatchObject({ limited: true, kind: 'spacing' });
  });
});

describe('status and tables', () => {
  it('shows the busiest window plus the spacing and block times ahead', () => {
    const { limiter } = rig();
    limiter.tryAcquire('ll2', 'poll');
    expect(limiter.status('ll2')).toEqual({ used: 1, cap: 7, window: 'hour', nextAllowedAt: T0 + 1000 });
    limiter.block('ll2', H, 'HTTP 429');
    expect(limiter.status('ll2')).toMatchObject({ blockedUntil: T0 + H });
  });

  it('LimitedError says when asking is possible again', () => {
    const e = new LimitedError('ll2', T0 + 90 * 60_000, 'hourly cap of 7 reached');
    expect(e.message).toBe(`rate limited until ${hhmmz(T0 + 90 * 60_000)} (hourly cap of 7 reached)`);
    expect(e.message).toMatch(/until 11:30Z/);
  });

  it('maps URLs and feeds to their sources, and every feed source has a table entry', () => {
    expect(sourceForUrl('https://celestrak.org/NORAD/elements/gp.php')).toBe('celestrak');
    expect(sourceForUrl('https://ll.thespacedevs.com/2.3.0/launch/')).toBe('ll2');
    expect(sourceForUrl('https://en.wikipedia.org/api/rest_v1/page/summary/X')).toBe('wikimedia');
    expect(sourceForUrl('https://www.wikidata.org/w/api.php')).toBe('wikimedia');
    expect(sourceForUrl('https://discosweb.esoc.esa.int/api/objects')).toBe('discos');
    expect(sourceForUrl('https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi')).toBe('gibs');
    expect(sourceForUrl('https://example.test/')).toBe('other');
    for (const s of Object.values(FEED_SOURCE)) expect(LIMITS[s], s).toBeDefined();
  });

  it('the table enforces the agreed caps', () => {
    expect(LIMITS.celestrak).toMatchObject({ perHour: 15, minSpacingMs: 2000, failureStop: { count: 3, windowMs: 2 * H, blockMs: 24 * H } });
    expect(LIMITS['spacetrack:login']).toMatchObject({ perHour: 4 });
    expect(LIMITS['spacetrack:query'].minSpacingMs).toBe(2 * H);
    expect(LIMITS.ll2).toMatchObject({ perHour: 7, blockOn: { 429: H } });
    expect(LIMITS.snapi).toMatchObject({ demandPerHour: 20, minSpacingMs: 2000 });
    expect(LIMITS.dsn.perHour).toBe(720);
    expect(LIMITS.horizons).toMatchObject({ minSpacingMs: 1500, perHour: 60, blockOn: { 503: 15 * 60_000 } });
    expect(LIMITS.wheretheiss.perHour).toBe(1800);
    expect(LIMITS['iss-live']).toMatchObject({ minSpacingMs: 30_000, perHour: 12 });
    expect(LIMITS.wikimedia).toMatchObject({ minSpacingMs: 1500, perHour: 600, perDay: 5000 });
    expect(LIMITS.discos).toMatchObject({ perMinute: 10, perHour: 200 });
    expect(LIMITS.gibs).toMatchObject({ minSpacingMs: 200, perHour: 1000, blockOn: { 429: 15 * 60_000, 503: 15 * 60_000 } });
  });
});
