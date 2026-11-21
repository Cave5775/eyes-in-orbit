import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineConfig, type EngineConfig } from '../../../src/engine/config';
import { FALLBACK_AFTER_FAILURES, dsn } from '../../../src/engine/connectors/dsn';
import { issLive } from '../../../src/engine/connectors/iss-live';
import { ISS_POLL_MS, issRest } from '../../../src/engine/connectors/iss-rest';
import { createLaunchlibrary, launchlibrary } from '../../../src/engine/connectors/launchlibrary';
import { MAX_QUERY_CHARS, normalizeQuery, searchNews, snapi } from '../../../src/engine/connectors/snapi';
import { Http } from '../../../src/engine/http';
import { Hub } from '../../../src/engine/hub';
import { Limiter, LimitedError } from '../../../src/engine/net/limiter';
import { LIMITS } from '../../../src/engine/net/limits';
import { Scheduler, type Connector } from '../../../src/engine/scheduler';
import { MemoryKv, type KvStore } from '../../../src/engine/store';

// ported from the server's connector-limits test (the CelesTrak and Horizons cases arrive with those connectors)
const fx = (name: string): string => readFileSync(new URL(`../../../../server/test/fixtures/${name}`, import.meta.url), 'utf8');
const H = 3600_000;

/** a scheduler on fake timers with the REAL limit table, so each connector's source key and cadence are checked end to end */
function setup(connectors: Connector[], answer: (url: string, init?: RequestInit) => Response, over: Partial<EngineConfig> = {}) {
  const hub = new Hub(0);
  const store = new MemoryKv();
  const limiter = new Limiter(store, { limits: LIMITS });
  const calls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    calls.push(String(input));
    inits.push(init);
    return answer(String(input), init);
  });
  const config = engineConfig(over);
  const http = new Http(store, { fetch: fetchMock, offline: false, limiter });
  const scheduler = new Scheduler({ hub, config, store, http }, connectors, 0);
  return { hub, store, limiter, calls, inits, fetchMock, scheduler, config, http };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('each connector goes through the limiter under its own source key', () => {
  it('launchlibrary: the 2.3.0 base and `ll2`', async () => {
    const { limiter, calls, scheduler, hub } = setup([launchlibrary], () => new Response(fx('ll2-2.3.0-launch.json')));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    scheduler.stop();
    expect(calls.map((u) => u.split('?')[0])).toEqual([
      'https://ll.thespacedevs.com/2.3.0/launches/upcoming/', 'https://ll.thespacedevs.com/2.3.0/launches/previous/',
    ]);
    expect(await limiter.status('ll2')).toMatchObject({ used: 2, cap: 7 });
    expect(hub.launches).toHaveLength(1);
  });

  it('launchlibrary: the token comes from the injected credential source and is sent as `Token <key>`; none, no header', async () => {
    const withToken = setup([createLaunchlibrary({ get: async (k) => (k === 'll2Token' ? 'secret' : undefined) })], () => new Response(fx('ll2-2.3.0-launch.json')));
    await withToken.scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    withToken.scheduler.stop();
    expect(withToken.inits.every((i) => (i?.headers as Record<string, string>).authorization === 'Token secret')).toBe(true);

    const without = setup([createLaunchlibrary({ get: async () => undefined })], () => new Response(fx('ll2-2.3.0-launch.json')));
    await without.scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    without.scheduler.stop();
    expect(without.inits.every((i) => !(i?.headers as Record<string, string>).authorization)).toBe(true);
  });

  it('launchlibrary: the base URL is a config field', async () => {
    const { calls, scheduler } = setup([launchlibrary], () => new Response(fx('ll2-2.3.0-launch.json')), { ll2Base: 'https://example.test/ll' });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    scheduler.stop();
    expect(calls[0].startsWith('https://example.test/ll/launches/upcoming/')).toBe(true);
  });

  it('snapi: the poll counts on `snapi`', async () => {
    const { limiter, scheduler } = setup([snapi], () => new Response(fx('snapi-articles.json')));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(5000);
    scheduler.stop();
    expect(await limiter.status('snapi')).toMatchObject({ used: 1, cap: 32 });
  });

  it('dsn: one request per poll on `dsn`', async () => {
    const { limiter, calls, scheduler } = setup([dsn], () => new Response(fx('dsn.xml')));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    scheduler.stop();
    expect(calls).toHaveLength(1);
    expect(await limiter.status('dsn')).toMatchObject({ used: 1, cap: 800 });
  });
});

describe('iss-rest (wheretheiss.at)', () => {
  const fix = JSON.stringify({ timestamp: 1_792_000_000, latitude: 10, longitude: 20, altitude: 420, velocity: 27_500, visibility: 'daylight', footprint: 4500 });

  it('polls every 2 s (was 1 s), only while a client watches, on `wheretheiss`', async () => {
    expect(ISS_POLL_MS).toBe(2000);
    expect(issRest.intervalMs).toBe(2000);
    const { hub, limiter, calls, scheduler } = setup([issRest], () => new Response(fix));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0); // nobody subscribed
    hub.subscribe('iss');
    await vi.advanceTimersByTimeAsync(10_000);
    scheduler.stop();
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(calls.length).toBeLessThanOrEqual(6); // 1 per 2 s, not 1 per second
    expect(await limiter.status('wheretheiss')).toMatchObject({ cap: 1900, window: 'hour' });
  });

  it('honours X-Rate-Limit-Remaining: 0 by pausing until the reset', async () => {
    const resetAt = Date.now() + 40_000;
    const { hub, calls, scheduler } = setup([issRest], () => new Response(fix, { headers: { 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(resetAt / 1000) } }));
    await scheduler.start();
    hub.subscribe('iss');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(1); // paused for 40 s
    await vi.advanceTimersByTimeAsync(15_000);
    scheduler.stop();
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('launchlibrary stays under its cap', () => {
  const stale = async (store: KvStore) => {
    const now = Date.now();
    await store.put('ll2:upcoming', JSON.parse(fx('ll2-2.3.0-launch.json')).results, 9 * 60_000, now - 3 * H);
    await store.put('ll2:previous', JSON.parse(fx('ll2-2.3.0-launch.json')).results, 55 * 60_000, now - 3 * H);
  };

  it('a failing source with a stale cache is retried at the poll interval (15 min), never every 5 min', async () => {
    const { store, calls, scheduler, hub } = setup([launchlibrary], () => new Response('down', { status: 500 }));
    await stale(store);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(2);
    expect(hub.healthOf('launchlibrary').nextRunAt! - Date.now()).toBeGreaterThanOrEqual(14 * 60_000);
    await vi.advanceTimersByTimeAsync(5.5 * 60_000);
    expect(calls).toHaveLength(2); // the old 5 min stale retry would have fired here
    scheduler.stop();
  });

  it('over three hours of a dead source: at most 7 requests in any hour', async () => {
    const { store, calls, scheduler } = setup([launchlibrary], () => new Response('down', { status: 500 }));
    await stale(store);
    const stamps: number[] = [];
    const start = Date.now();
    await scheduler.start();
    for (let m = 0; m < 180; m++) {
      const before = calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      for (let i = before; i < calls.length; i++) stamps.push(Date.now() - start);
    }
    scheduler.stop();
    for (let from = 0; from <= 2 * H; from += 60_000) {
      expect(stamps.filter((t) => t >= from && t < from + H).length, `hour from ${from / 60_000} min`).toBeLessThanOrEqual(7);
    }
  });

  it('with the hourly cap used up the stale cache is served and NOTHING is requested', async () => {
    const { store, limiter, calls, scheduler, hub } = setup([launchlibrary], () => new Response(fx('ll2-2.3.0-launch.json')));
    await stale(store);
    await limiter.report('ll2', { status: 200 });
    const s = await limiter.state('ll2');
    await store.put('limit:ll2', { ...s, hour: { start: Date.now(), count: 7 }, nextAllowedAt: 0 }, 86_400_000);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(20_000);
    scheduler.stop();
    expect(calls).toHaveLength(0);
    expect(hub.launches).toHaveLength(1); // from the stale cache
    expect(hub.healthOf('launchlibrary').lastError).toMatch(/rate limited until/);
  });

  it('HTTP 429 blocks LL2 for at least an hour, longer when Retry-After says so', async () => {
    const { limiter, calls, scheduler } = setup([launchlibrary], () => new Response('throttled', { status: 429, headers: { 'retry-after': '90' } }));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    scheduler.stop();
    expect(calls.length).toBeLessThanOrEqual(2);
    expect((await limiter.state('ll2')).blockedUntil).toBeGreaterThanOrEqual(Date.now() - 10_000 + H);
  });
});

describe('dsn fallback URL', () => {
  const A = 'https://eyes.nasa.gov/dsn/data/dsn.xml', B = 'https://eyes.nasa.gov/dsn/dsn.xml';
  /** the connector remembers its working URL at module level: a fresh copy per test */
  const fresh = async () => {
    vi.resetModules();
    return (await import('../../../src/engine/connectors/dsn')) as { dsn: Connector };
  };

  it('is tried only after 3 failures in a row, with a persisted backoff between attempts', async () => {
    expect(FALLBACK_AFTER_FAILURES).toBe(3);
    const { dsn } = await fresh();
    const times: number[] = [];
    const { calls, scheduler, limiter } = setup([dsn], (url) => (times.push(Date.now()), url.startsWith(A) ? new Response('down', { status: 500 }) : new Response(fx('dsn.xml'))), { dsnUrls: [A, B] });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    scheduler.stop();
    const hosts = calls.map((u) => (u.startsWith(A) ? 'A' : 'B'));
    const firstB = hosts.indexOf('B');
    expect(firstB).toBe(FALLBACK_AFTER_FAILURES); // A, A, A (three failures), then B
    expect(hosts.slice(0, firstB).every((h) => h === 'A')).toBe(true);
    // persisted backoff between the failed attempts: 30 s, then 60 s, then 120 s (not a retry every 5 s)
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(30_000);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(60_000);
    expect(times[3] - times[2]).toBeGreaterThanOrEqual(120_000);
    expect(await limiter.consecutiveFailures('dsn')).toBe(0);
  });

  it('a single failure does not touch the second URL', async () => {
    let n = 0;
    const { dsn } = await fresh();
    const { calls, scheduler } = setup([dsn], () => (n++ === 0 ? new Response('down', { status: 500 }) : new Response(fx('dsn.xml'))), { dsnUrls: [A, B] });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    scheduler.stop();
    expect(calls.every((u) => u.startsWith(A))).toBe(true);
  });
});

describe('snapi search is a limited, normalised demand call', () => {
  it('lower-cases, collapses spaces and caps the query at 80 characters', async () => {
    expect(MAX_QUERY_CHARS).toBe(80);
    expect(normalizeQuery('  International   SPACE\tStation ')).toBe('international space station');
    expect(normalizeQuery('x'.repeat(300))).toHaveLength(80);
    const { http, calls } = setup([], () => new Response(fx('snapi-articles.json')));
    await searchNews(http, `  ${'Long Query '.repeat(30)}`);
    const q = new URL(calls[0]).searchParams.get('search')!;
    expect(q.length).toBeLessThanOrEqual(80);
    expect(q).toBe(q.toLowerCase());
  });

  it('20 lookups per hour: the 21st is refused at once (LimitedError), a repeat of a cached one is served', async () => {
    const { http, calls } = setup([], () => new Response(fx('snapi-articles.json')));
    for (let i = 0; i < 20; i++) {
      await searchNews(http, `topic ${i}`);
      await vi.advanceTimersByTimeAsync(2100);
    }
    expect(calls).toHaveLength(20);
    await expect(searchNews(http, 'topic 21')).rejects.toBeInstanceOf(LimitedError);
    expect(calls).toHaveLength(20);
    await expect(searchNews(http, 'topic 3')).resolves.toBeDefined(); // cached
  });
});

describe('iss-live (Lightstreamer) connect attempts', () => {
  const ctxOf = (limiter: Limiter) => ({
    http: { limiter }, hub: { on() {}, off() {} }, health: {}, config: {}, store: undefined, log() {}, softFail() {}, cachedFetch: undefined,
  });

  it('opens no socket while blocked, and refuses a second attempt within 30 s (reschedule, no error)', async () => {
    const store = new MemoryKv();
    const limiter = new Limiter(store, { limits: LIMITS });
    await limiter.block('iss-live', 15 * 60_000, 'HTTP 429');
    const blocked = await issLive.run!(ctxOf(limiter) as never).catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(LimitedError);
    expect((blocked as LimitedError).kind).toBe('blocked');
    await limiter.clearBlock('iss-live');
    await store.put('limit:iss-live', { nextAllowedAt: Date.now() + 20_000, hour: { start: Date.now(), count: 1 } }, 86_400_000);
    const spaced = await issLive.run!(ctxOf(limiter) as never).catch((e: unknown) => e);
    expect(spaced).toBeInstanceOf(LimitedError);
    expect((spaced as LimitedError).kind).toBe('spacing');
    expect((spaced as LimitedError).retryAt).toBe(Date.now() + 20_000);
  });

  it('twelve attempts per hour', async () => {
    const store = new MemoryKv();
    const limiter = new Limiter(store, { limits: LIMITS });
    await store.put('limit:iss-live', { nextAllowedAt: 0, hour: { start: Date.now(), count: 12 } }, 86_400_000);
    const r = await issLive.run!(ctxOf(limiter) as never).catch((e: unknown) => e);
    expect((r as LimitedError).kind).toBe('cap');
  });
});

describe('health.limit of a connector\'s source', () => {
  it('carries used, cap, window and the block time', async () => {
    const { hub, limiter, scheduler } = setup([snapi], () => new Response(fx('snapi-articles.json')));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(5000);
    const h = (await hub.healthList()).find((x) => x.id === 'snapi')!;
    expect(h.limit).toMatchObject({ used: 1, cap: 32, window: 'hour' });
    await limiter.block('snapi', 20 * 60_000, 'HTTP 429');
    const blocked = (await hub.healthList()).find((x) => x.id === 'snapi')!;
    expect(blocked.limit!.blockedUntil).toBe(Date.now() + 20 * 60_000);
    expect(blocked.feed).toMatchObject({ level: 'orange', reason: 'rate-limited' });
    scheduler.stop();
  });
});
