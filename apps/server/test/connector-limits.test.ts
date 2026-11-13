import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { Scheduler, type Connector } from '../src/connector';
import { celestrak } from '../src/connectors/celestrak';
import { FALLBACK_AFTER_FAILURES, dsn } from '../src/connectors/dsn';
import { horizons } from '../src/connectors/horizons';
import { issLive } from '../src/connectors/iss-live';
import { ISS_POLL_MS, issRest } from '../src/connectors/iss-rest';
import { launchlibrary } from '../src/connectors/launchlibrary';
import { MAX_QUERY_CHARS, normalizeQuery, searchNews, snapi } from '../src/connectors/snapi';
import { Http } from '../src/http';
import { Hub } from '../src/hub';
import { Limiter, LimitedError } from '../src/net/limiter';
import { LIMITS } from '../src/net/limits';
import { Store } from '../src/store';

const fx = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const H = 3600_000;

/** a scheduler on fake timers with the REAL limit table, so each connector's source key and cadence are checked end to end */
function setup(connectors: Connector[], answer: (url: string) => Response, env: NodeJS.ProcessEnv = {}) {
  const hub = new Hub(0);
  const store = new Store(':memory:');
  const limiter = new Limiter(store, { limits: LIMITS });
  const calls: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    calls.push(String(input));
    return answer(String(input));
  });
  const config = loadConfig(env);
  const http = new Http(store, { fetch: fetchMock, offline: false, limiter });
  const scheduler = new Scheduler({ hub, config, store, http }, connectors, 0);
  return { hub, store, limiter, calls, fetchMock, scheduler, config, http };
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
  it('celestrak: 11 groups, 2 s apart, counted on `celestrak` (within 15 per hour)', async () => {
    const { limiter, calls, scheduler } = setup([celestrak], () => new Response(fx('celestrak-stations.json')));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(40_000);
    scheduler.stop();
    expect(calls).toHaveLength(11);
    expect(calls.every((u) => u.startsWith('https://celestrak.org/'))).toBe(true);
    expect(limiter.status('celestrak')).toMatchObject({ used: 11, cap: 15, window: 'hour' });
  });

  it('launchlibrary: the 2.3.0 base and `ll2`', async () => {
    const { limiter, calls, scheduler, hub } = setup([launchlibrary], () => new Response(fx('ll2-2.3.0-launch.json')));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    scheduler.stop();
    expect(calls.map((u) => u.split('?')[0])).toEqual([
      'https://ll.thespacedevs.com/2.3.0/launches/upcoming/', 'https://ll.thespacedevs.com/2.3.0/launches/previous/',
    ]);
    expect(limiter.status('ll2')).toMatchObject({ used: 2, cap: 7 });
    expect(hub.launches).toHaveLength(1);
  });

  it('snapi: the poll counts on `snapi`', async () => {
    const { limiter, scheduler } = setup([snapi], () => new Response(fx('snapi-articles.json')));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(5000);
    scheduler.stop();
    expect(limiter.status('snapi')).toMatchObject({ used: 1, cap: 32 });
  });

  it('dsn: one request per poll on `dsn`', async () => {
    const { limiter, calls, scheduler } = setup([dsn], () => new Response(fx('dsn.xml')));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    scheduler.stop();
    expect(calls).toHaveLength(1);
    expect(limiter.status('dsn')).toMatchObject({ used: 1, cap: 800 });
  });

  it('horizons: one request at a time, 1.5 s apart, on `horizons`', async () => {
    const { limiter, calls, scheduler } = setup([horizons], () => new Response(fx('horizons-vectors.json')));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    scheduler.stop();
    expect(calls.length).toBeGreaterThan(5);
    expect(limiter.status('horizons')).toMatchObject({ used: calls.length, cap: 120 });
    expect(limiter.state('horizons').nextAllowedAt - (Date.now() - 1)).toBeLessThanOrEqual(1500);
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
    expect(limiter.status('wheretheiss')).toMatchObject({ cap: 1900, window: 'hour' });
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
  const stale = (store: Store) => {
    const now = Date.now();
    store.set('ll2:upcoming', JSON.parse(fx('ll2-2.3.0-launch.json')).results, 9 * 60_000, now - 3 * H);
    store.set('ll2:previous', JSON.parse(fx('ll2-2.3.0-launch.json')).results, 55 * 60_000, now - 3 * H);
  };

  it('a failing source with a stale cache is retried at the poll interval (15 min), never every 5 min', async () => {
    const { store, calls, scheduler, hub } = setup([launchlibrary], () => new Response('down', { status: 500 }));
    stale(store);
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
    stale(store);
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
    stale(store);
    for (let i = 0; i < 7; i++) limiter.tryAcquire('ll2', 'poll'); // spacing is 1 s: advance the clock between attempts
    // (the loop above stops at the first spacing refusal, so fill the window directly)
    limiter.report('ll2', { status: 200 });
    const s = limiter.state('ll2');
    store.set('limit:ll2', { ...s, hour: { start: Date.now(), count: 7 }, nextAllowedAt: 0 }, 86_400_000);
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
    expect(limiter.state('ll2').blockedUntil).toBeGreaterThanOrEqual(Date.now() - 10_000 + H);
  });
});

describe('dsn fallback URL', () => {
  const A = 'https://eyes.nasa.gov/dsn/data/dsn.xml', B = 'https://eyes.nasa.gov/dsn/dsn.xml';
  /** the connector remembers its working URL at module level: a fresh copy per test */
  const fresh = async () => {
    vi.resetModules();
    return (await import('../src/connectors/dsn')) as { dsn: Connector };
  };

  it('is tried only after 3 failures in a row, with a persisted backoff between attempts', async () => {
    expect(FALLBACK_AFTER_FAILURES).toBe(3);
    const { dsn } = await fresh();
    const times: number[] = [];
    const { calls, scheduler, limiter } = setup([dsn], (url) => (times.push(Date.now()), url.startsWith(A) ? new Response('down', { status: 500 }) : new Response(fx('dsn.xml'))), { DSN_URL: `${A},${B}` });
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
    expect(limiter.consecutiveFailures('dsn')).toBe(0);
  });

  it('a single failure does not touch the second URL', async () => {
    let n = 0;
    const { dsn } = await fresh();
    const { calls, scheduler } = setup([dsn], (url) => (n++ === 0 ? new Response('down', { status: 500 }) : new Response(fx('dsn.xml'))), { DSN_URL: `${A},${B}` });
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
    const store = new Store(':memory:');
    const limiter = new Limiter(store, { limits: LIMITS });
    limiter.block('iss-live', 15 * 60_000, 'HTTP 429');
    const blocked = await issLive.run!(ctxOf(limiter) as never).catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(LimitedError);
    expect((blocked as LimitedError).kind).toBe('blocked');
    limiter.clearBlock('iss-live');
    store.set('limit:iss-live', { nextAllowedAt: Date.now() + 20_000, hour: { start: Date.now(), count: 1 } }, 86_400_000);
    const spaced = await issLive.run!(ctxOf(limiter) as never).catch((e: unknown) => e);
    expect(spaced).toBeInstanceOf(LimitedError);
    expect((spaced as LimitedError).kind).toBe('spacing');
    expect((spaced as LimitedError).retryAt).toBe(Date.now() + 20_000);
  });

  it('twelve attempts per hour', async () => {
    const store = new Store(':memory:');
    const limiter = new Limiter(store, { limits: LIMITS });
    store.set('limit:iss-live', { nextAllowedAt: 0, hour: { start: Date.now(), count: 12 } }, 86_400_000);
    const r = await issLive.run!(ctxOf(limiter) as never).catch((e: unknown) => e);
    expect((r as LimitedError).kind).toBe('cap');
  });
});

describe('the scheduler on a limited run', () => {
  it('a spacing refusal is silent (no error, rescheduled at the retry time); a cap shows "rate limited until" and keeps ok after data', async () => {
    let mode: 'spacing' | 'cap' | 'ok' = 'ok';
    const retry = () => Date.now() + 45_000;
    const c: Connector = {
      id: 'c', intervalMs: 1000,
      run: async () => {
        if (mode === 'spacing') throw new LimitedError('x', retry(), '30 s spacing', 'spacing');
        if (mode === 'cap') throw new LimitedError('x', retry(), 'hourly cap of 7 reached', 'cap');
      },
    };
    const { hub, scheduler } = setup([c], () => new Response(''));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.healthOf('c').status).toBe('ok');
    mode = 'spacing';
    await vi.advanceTimersByTimeAsync(1100);
    expect(hub.healthOf('c')).toMatchObject({ status: 'ok', lastError: undefined });
    expect(hub.healthOf('c').nextRunAt! - Date.now()).toBeGreaterThanOrEqual(44_000);
    mode = 'cap';
    await vi.advanceTimersByTimeAsync(46_000);
    expect(hub.healthOf('c')).toMatchObject({ status: 'ok' });
    expect(hub.healthOf('c').lastError).toMatch(/rate limited until \d\d:\d\dZ \(hourly cap of 7 reached\)/);
    const feed = hub.healthList().find((h) => h.id === 'c')!.feed!;
    expect(feed).toMatchObject({ level: 'orange', reason: 'rate-limited' });
    expect(feed.retryUtc).toMatch(/^\d\d:\d\dZ$/);
    scheduler.stop();
  });

  it('health.limit carries used, cap, window and the block time of the connector\'s source', async () => {
    const { hub, limiter, scheduler } = setup([snapi], () => new Response(fx('snapi-articles.json')));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(5000);
    const h = hub.healthList().find((x) => x.id === 'snapi')!;
    expect(h.limit).toMatchObject({ used: 1, cap: 32, window: 'hour' });
    limiter.block('snapi', 20 * 60_000, 'HTTP 429');
    const blocked = hub.healthList().find((x) => x.id === 'snapi')!;
    expect(blocked.limit!.blockedUntil).toBe(Date.now() + 20 * 60_000);
    expect(blocked.feed).toMatchObject({ level: 'orange', reason: 'rate-limited' });
    scheduler.stop();
  });
});
